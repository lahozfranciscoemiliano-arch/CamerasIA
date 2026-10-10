import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Db } from "../src/db/index.js";
import { CameraService } from "../src/exacq/service.js";
import { LiveHub } from "../src/live/hub.js";
import { pipeLatestMultipart } from "../src/live/mjpeg.js";
import { Bus } from "../src/realtime/bus.js";
import { KeyRing } from "../src/security/crypto.js";
import { VaultService } from "../src/vault/service.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Destino lento: no confirma ninguna escritura hasta que se lo "suelta" (cliente pausado). */
class PausedSink extends Writable {
  callbacks: Array<() => void> = [];
  chunks: Buffer[] = [];
  paused = true;
  headers?: Record<string, string>;
  constructor(highWaterMark = 16 * 1024) {
    super({ highWaterMark });
  }
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
    this.chunks.push(Buffer.from(chunk));
    if (this.paused) this.callbacks.push(cb);
    else cb();
  }
  release() {
    this.paused = false;
    const cbs = this.callbacks;
    this.callbacks = [];
    for (const cb of cbs) cb();
  }
  writeHead(_status: number, headers: Record<string, string>) {
    this.headers = headers;
    return this;
  }
  /** Contenido JPEG de cada parte multipart recibida. */
  parts() {
    const all = Buffer.concat(this.chunks).toString("latin1");
    return all
      .split("--ciaframe\r\n")
      .filter(Boolean)
      .map((p) => p.slice(p.indexOf("\r\n\r\n") + 4, -2));
  }
}

test("MJPEG con contrapresión: con el cliente pausado se conserva sólo el último cuadro", async () => {
  const sink = new PausedSink();
  const out = pipeLatestMultipart(sink, "ciaframe");
  const frame = (n: number) => Buffer.concat([Buffer.from(`frame-${n}:`), Buffer.alloc(30_000, n % 251)]);
  let maxBuffered = 0;
  for (let n = 1; n <= 50; n++) {
    out.push(frame(n));
    maxBuffered = Math.max(maxBuffered, sink.writableLength);
  }
  assert.ok(maxBuffered <= 30_100 + 16 * 1024, `buffer máximo ${maxBuffered}`);
  assert.equal(out.dropped, 48, "los intermedios se descartan");
  sink.release();
  await sleep(10);
  const parts = sink.parts();
  assert.equal(parts.length, 2);
  assert.ok(parts[0]!.startsWith("frame-1:"));
  assert.ok(parts[1]!.startsWith("frame-50:"), "al vaciarse se envía el más reciente");
  out.push(frame(51));
  await sleep(10);
  assert.ok(sink.parts().at(-1)!.startsWith("frame-51:"), "cliente al día: se escribe directo");
  out.close();
});

test("/stream sobre el LiveHub: la demora no crece con un cliente lento", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cia-stream-"));
  const db = new Db(":memory:");
  const vault = new VaultService(db, new KeyRing({ 1: crypto.randomBytes(32) }, 1));
  const bus = new Bus();
  const cameras = new CameraService(db, vault, bus, { demo: true, exportsDir: dir, log: () => undefined });
  await cameras.reload();
  await cameras.sync();
  const hub = new LiveHub(cameras, bus, {
    gridMaxFps: 4,
    focusMaxFps: 12,
    pipelineGrid: 2,
    pipelineFocus: 3,
    frameTimeoutMs: 2000,
    idleGraceMs: 200,
    latestTtlMs: 5000,
    maxConcurrentPerServer: 12,
    maxUpstreamFpsPerServer: 40,
    maxUpstreamMbps: 40,
  });
  cameras.live = hub;
  const sink = new PausedSink(4096);
  const reply = { raw: sink, hijack: () => undefined } as unknown as FastifyReply;
  try {
    const done = cameras.stream("demo:1", {} as FastifyRequest, reply, 10);
    let maxBuffered = 0;
    for (let i = 0; i < 15; i++) {
      await sleep(100);
      maxBuffered = Math.max(maxBuffered, sink.writableLength);
    }
    assert.ok(sink.headers?.["Content-Type"]?.startsWith("multipart/x-mixed-replace"));
    assert.ok(maxBuffered > 0 && maxBuffered < 80_000, `buffer máximo ${maxBuffered}`);
    assert.equal(hub.stats().cameras[0]?.prio, "focus");
    sink.release();
    await sleep(300);
    assert.ok(sink.parts().length >= 2, "se reanuda al consumir");
    sink.destroy();
    sink.emit("close");
    await done;
    await sleep(300);
    assert.equal(hub.stats().cameras.length, 0, "al cerrar se libera la suscripción");
  } finally {
    hub.stop();
    cameras.stop();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
