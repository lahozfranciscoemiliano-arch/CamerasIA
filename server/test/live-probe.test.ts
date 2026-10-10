import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import jpeg from "jpeg-js";
import { Db } from "../src/db/index.js";
import { LiveProfiles } from "../src/exacq/live-probe.js";
import { liveProfileKey, manualProfile } from "../src/exacq/live-profile.js";
import { CameraService } from "../src/exacq/service.js";
import { Bus } from "../src/realtime/bus.js";
import { KeyRing } from "../src/security/crypto.js";
import { VaultService } from "../src/vault/service.js";
import { parseJpegInfo } from "../src/video/jpeg.js";

const cache = new Map<string, Buffer>();
function image(w: number, h: number, q: number) {
  const k = `${w}x${h}@${q}`;
  let buf = cache.get(k);
  if (!buf) {
    const data = Buffer.alloc(w * h * 4);
    let seed = 7;
    for (let i = 0; i < w * h; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const x = i % w;
      const y = Math.floor(i / w);
      const n = (seed >> 16) % 40;
      data[i * 4] = ((x * 255) / w + n) & 255;
      data[i * 4 + 1] = ((y * 255) / h + n) & 255;
      data[i * 4 + 2] = (x ^ y) & 255;
      data[i * 4 + 3] = 255;
    }
    buf = jpeg.encode({ data, width: w, height: h }, q).data as Buffer;
    cache.set(k, buf);
  }
  return buf;
}

interface FakeOpts {
  /** "wh": sólo achica si vienen w y h; "none": ignora todo. */
  resize: "wh" | "none";
  quality: boolean;
  /** Responde 400 ante parámetros que no conoce. */
  strict?: boolean;
  /** Atiende un pedido de imagen por vez (sin pipelining). */
  serialize?: boolean;
  /** Corta la conexión a partir del pedido de imagen N. */
  failAfter?: number;
}

async function fakeExacq(o: FakeOpts) {
  const NATIVE = { w: 1280, h: 720 };
  let videoRequests = 0;
  let chain = Promise.resolve();
  const known = new Set(["s", "camera", "fmt", "w", "h", "quality"]);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/v1/login.web") {
      req.resume();
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ sessionId: "sess" }));
    }
    if (url.pathname === "/v1/logout.web") return res.end("{}");
    if (url.pathname === "/v1/config.web") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ Cameras: [1, 2, 3].map((id) => ({ id, name: `Cam ${id}`, state: 0, disabled: 0 })) }));
    }
    if (url.pathname !== "/v1/video.web" || url.searchParams.get("fmt") !== "jpg") {
      res.statusCode = 404;
      return res.end();
    }
    videoRequests++;
    if (o.failAfter && videoRequests >= o.failAfter) return req.socket.destroy();
    if (o.strict && [...url.searchParams.keys()].some((k) => !known.has(k))) {
      res.statusCode = 400;
      return res.end();
    }
    const p = url.searchParams;
    let w = NATIVE.w;
    let h = NATIVE.h;
    if (o.resize === "wh" && p.has("w") && p.has("h")) {
      w = Number(p.get("w"));
      h = Number(p.get("h"));
    }
    const q = o.quality && p.has("quality") ? Number(p.get("quality")) : 75;
    const send = () => {
      res.setHeader("content-type", "image/jpeg");
      res.end(image(w, h, q));
    };
    const work = () => new Promise<void>((r) => setTimeout(() => (send(), r()), 40));
    if (o.serialize) chain = chain.then(work);
    else void work();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, count: () => videoRequests };
}

async function setup(o: FakeOpts) {
  const remote = await fakeExacq(o);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cia-probe-"));
  const db = new Db(":memory:");
  const vault = new VaultService(db, new KeyRing({ 1: crypto.randomBytes(32) }, 1));
  const cameras = new CameraService(db, vault, new Bus(), { demo: false, exportsDir: dir, log: () => undefined });
  const credentialId = vault.create({ name: "exacq", kind: "exacq", secret: { username: "u", password: "p" } });
  db.run("INSERT INTO exacq_servers(id, name, base_url, credential_id, created_at, updated_at) VALUES('srv', 'Fake', $url, $cred, $now, $now)", { url: remote.url, cred: credentialId, now: Date.now() });
  await cameras.reload();
  await cameras.sync();
  const saved: string[] = [];
  const profiles = new LiveProfiles(cameras, { log: () => undefined, onSaved: (_s, _p, reason) => saved.push(reason), probe: { gapMs: 0 } });
  const close = async () => {
    for (const s of cameras.sources.values()) await s.dispose?.();
    cameras.stop();
    remote.server.closeAllConnections();
    await new Promise<void>((r) => remote.server.close(() => r()));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { remote, db, cameras, profiles, saved, close };
}

test("prueba de perfil: servidor que sólo respeta w/h y quality", async () => {
  const t = await setup({ resize: "wh", quality: true, strict: true });
  try {
    const r = await t.profiles.probe("srv", { save: true, reason: "probe" });
    assert.equal(r.saved, true);
    assert.equal(r.profile.resize?.extra, "w={w}&h={h}");
    assert.equal(r.profile.resize?.kind, "param");
    assert.deepEqual(r.profile.resize?.verified.map((v) => [v.reqW, v.gotW]), [[640, 640], [320, 320]]);
    assert.equal(r.profile.quality?.extra, "quality={q}");
    assert.equal(r.profile.baseline?.w, 1280);
    assert.equal(r.profile.pipeline.ok, true, "el fake atiende en paralelo");
    assert.ok(t.remote.count() <= 40, `pedidos: ${t.remote.count()}`);
    assert.ok(r.steps.some((s) => s.step.includes("width={w}") && !s.ok && s.detail === "no soportado"), "400 se saltea sin abortar");
    // Persistido en settings y aplicado a la fuente activa.
    assert.equal(t.cameras.liveProfile("srv")?.source, "probe");
    assert.equal(t.db.getSetting<{ source?: string }>(liveProfileKey("srv"), {}).source, "probe");
    assert.deepEqual(t.saved, ["probe"]);
    const f = await t.cameras.liveFrame("srv:1", { width: 640, height: 360, quality: 65 });
    assert.equal(parseJpegInfo(f.data)?.width, 640, "los cuadros en vivo usan el tamaño verificado");
    const full = await t.cameras.snapshot("srv:1");
    assert.equal(parseJpegInfo(full.data)?.width, 1280, "el snapshot normal sigue en resolución completa");
  } finally {
    await t.close();
  }
});

test("prueba de perfil: servidor que ignora todos los parámetros y no admite pipelining", async () => {
  const t = await setup({ resize: "none", quality: false, serialize: true });
  try {
    const r = await t.profiles.probe("srv", { save: false, reason: "probe" });
    assert.equal(r.saved, false);
    assert.equal(r.profile.resize, null);
    assert.equal(r.profile.quality, null);
    assert.equal(r.profile.pipeline.ok, false, `speedup ${r.profile.pipeline.speedup}`);
    assert.equal(r.profile.recommendedConcurrency, 3);
    assert.equal(t.cameras.liveProfile("srv"), null, "sin guardar (Tester)");
  } finally {
    await t.close();
  }
});

test("prueba de perfil: un corte de red a mitad de la prueba no guarda nada", async () => {
  const t = await setup({ resize: "wh", quality: true, failAfter: 6 });
  try {
    await assert.rejects(t.profiles.probe("srv", { save: true, reason: "probe" }), /contactar|cortó|fetch/i);
    assert.equal(t.cameras.liveProfile("srv"), null);
    assert.equal(t.db.get("SELECT value FROM settings WHERE key = $k", { k: liveProfileKey("srv") }), undefined);
    assert.equal(t.cameras.sourceStatuses()[0]!.ok, true, "la prueba no cambia el estado del servidor");
  } finally {
    await t.close();
  }
});

test("prueba de perfil: la automática no reemplaza un perfil manual", async () => {
  const t = await setup({ resize: "wh", quality: true });
  try {
    t.cameras.setLiveProfile("srv", manualProfile({ resize: { extra: "w={w}&h={h}" } }, null));
    t.profiles.ensure("srv"); // ya tiene perfil: no prueba
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(t.remote.count(), 0);
    const r = await t.profiles.probe("srv", { save: true, reason: "auto" });
    assert.equal(r.saved, false);
    assert.equal(t.cameras.liveProfile("srv")?.source, "manual");
    // Pedido explícito de un administrador: sí lo reemplaza.
    const r2 = await t.profiles.probe("srv", { save: true, reason: "probe" });
    assert.equal(r2.saved, true);
    assert.equal(t.cameras.liveProfile("srv")?.source, "probe");
    // Un cambio de plantilla de imagen borra el perfil probado.
    t.cameras.setLiveProfile("srv", null);
    assert.equal(t.cameras.liveProfile("srv"), null);
  } finally {
    await t.close();
  }
});
