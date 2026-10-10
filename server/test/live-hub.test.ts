import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import jpeg from "jpeg-js";
import { ExacqSource } from "../src/exacq/client.js";
import type { Snapshot, SnapshotOpts, VideoSource } from "../src/exacq/types.js";
import { LiveHub, type HubCameras, type LiveCfg, type LiveFrame, type LiveState } from "../src/live/hub.js";
import { FLAG_CACHED } from "../src/live/protocol.js";
import { Bus } from "../src/realtime/bus.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const BASE = (() => {
  const w = 16;
  const h = 9;
  const data = Buffer.alloc(w * h * 4, 128);
  return jpeg.encode({ data, width: w, height: h }, 70).data as Buffer;
})();

/** JPEG válido y único (contador después del EOI), con relleno opcional para simular tamaño. */
let counter = 0;
const frame = (pad = 0) => {
  const tail = Buffer.alloc(4 + pad);
  tail.writeUInt32BE(++counter, 0);
  return Buffer.concat([BASE, tail]);
};

const cfg = (o: Partial<LiveCfg> = {}): LiveCfg => ({
  gridMaxFps: 4,
  focusMaxFps: 12,
  pipelineGrid: 2,
  pipelineFocus: 3,
  frameTimeoutMs: 2000,
  idleGraceMs: 300,
  latestTtlMs: 5000,
  maxConcurrentPerServer: 12,
  maxUpstreamFpsPerServer: 40,
  maxUpstreamMbps: 40,
  ...o,
});

interface Call {
  key: string;
  opts: Omit<SnapshotOpts, "live">;
  resolve: (s: Snapshot) => void;
  reject: (e: Error) => void;
  done: boolean;
}

/** Servicio de cámaras falso: cada pedido queda pendiente (modo manual) o se responde solo. */
function fakeCameras(o: { auto?: (key: string) => Buffer | Error | null; delayMs?: number; server?: (key: string) => string } = {}) {
  const calls: Call[] = [];
  const rows = new Map<string, { id: string; server_id: string; camera_id: string; enabled: number; online: number }>();
  const source = { id: "s1", name: "Fake", kind: "demo" } as unknown as VideoSource;
  const row = (key: string) => {
    let r = rows.get(key);
    if (!r) {
      r = { id: key, server_id: o.server?.(key) ?? "s1", camera_id: key, enabled: 1, online: 1 };
      rows.set(key, r);
    }
    return r;
  };
  const cams: HubCameras & { calls: Call[]; rows: typeof rows; auto?: typeof o.auto } = {
    calls,
    rows,
    auto: o.auto,
    resolve: (key) => ({ row: row(key), source }),
    row: (key) => row(key),
    liveFrame: (key, opts) =>
      new Promise<Snapshot>((resolve, reject) => {
        const c: Call = { key, opts, resolve: (s) => ((c.done = true), resolve(s)), reject: (e) => ((c.done = true), reject(e)), done: false };
        calls.push(c);
        const auto = cams.auto?.(key);
        if (auto) {
          setTimeout(() => (auto instanceof Error ? c.reject(auto) : c.resolve({ data: auto, contentType: "image/jpeg", ts: Date.now() })), o.delayMs ?? 5);
        }
      }),
  };
  return cams;
}

const collect = () => {
  const frames: LiveFrame[] = [];
  const states: LiveState[] = [];
  return { frames, states, sink: { onFrame: (f: LiveFrame) => frames.push(f), onState: (s: LiveState) => states.push(s) } };
};

const pending = (calls: Call[]) => calls.filter((c) => !c.done).length;
const snap = (data: Buffer): Snapshot => ({ data, contentType: "image/jpeg", ts: Date.now() });

test("LiveHub: dos visores comparten un único lazo de pedidos", async () => {
  const cams = fakeCameras({ auto: () => frame() });
  const hub = new LiveHub(cams, null, cfg());
  try {
    const a = collect();
    const b = collect();
    const ha = hub.subscribe("s1:1", { fps: 4, tierW: 640, prio: "grid" }, a.sink);
    const hb = hub.subscribe("s1:1", { fps: 4, tierW: 320, prio: "grid" }, b.sink);
    await sleep(800);
    assert.ok(a.frames.length >= 2 && b.frames.length >= 2, `${a.frames.length}/${b.frames.length}`);
    assert.ok(cams.calls.length <= 5, `pedidos: ${cams.calls.length}`);
    assert.equal(hub.stats().cameras.length, 1);
    assert.equal(hub.stats().cameras[0]!.subs, 2);
    ha.close();
    hb.close();
  } finally {
    hub.stop();
  }
});

test("LiveHub: nunca más de P pedidos en vuelo y nunca un cuadro fuera de orden", async () => {
  const cams = fakeCameras();
  const hub = new LiveHub(cams, null, cfg());
  try {
    const a = collect();
    hub.subscribe("s1:1", { fps: 4, tierW: 0, prio: "grid" }, a.sink);
    await sleep(900);
    assert.equal(pending(cams.calls), 2, "P = 2 para la grilla");
    assert.equal(cams.calls.length, 2);
    const [c1, c2] = cams.calls;
    c2!.resolve(snap(frame()));
    await sleep(10);
    c1!.resolve(snap(frame()));
    await sleep(10);
    assert.equal(a.frames.length, 1, "el cuadro viejo que llegó tarde se descarta");
    assert.equal(a.frames[0]!.issueSeq, 2);
    assert.equal(hub.stats().cameras[0]!.stale, 1);
    for (const c of cams.calls) if (!c.done) c.resolve(snap(frame()));
  } finally {
    hub.stop();
  }
});

test("LiveHub: descarta cuadros repetidos y baja el ritmo", async () => {
  const same = frame();
  const cams = fakeCameras({ auto: () => same });
  const hub = new LiveHub(cams, null, cfg());
  try {
    const a = collect();
    hub.subscribe("s1:1", { fps: 10, tierW: 0, prio: "focus" }, a.sink);
    await sleep(1500);
    assert.equal(a.frames.length, 1, "sólo se entrega el primero");
    const st = hub.stats().cameras[0]!;
    assert.ok(st.dup > 3, `repetidos: ${st.dup}`);
    assert.ok(st.effFps < 8, `fps efectivos: ${st.effFps}`);
  } finally {
    hub.stop();
  }
});

test("LiveHub: período de gracia, reutilización del lazo y último cuadro en caché", async () => {
  const cams = fakeCameras({ auto: () => frame() });
  const hub = new LiveHub(cams, null, cfg({ idleGraceMs: 300 }));
  try {
    const a = collect();
    const h = hub.subscribe("s1:1", { fps: 4, tierW: 0, prio: "grid" }, a.sink);
    await sleep(200);
    assert.ok(a.frames.length >= 1);
    h.close();
    await sleep(100);
    const b = collect();
    const h2 = hub.subscribe("s1:1", { fps: 4, tierW: 0, prio: "grid" }, b.sink);
    assert.equal(b.frames.length, 1, "el cuadro en caché se entrega al instante");
    assert.ok(b.frames[0]!.flags & FLAG_CACHED);
    assert.equal(hub.stats().cameras.length, 1, "mismo lazo");
    h2.close();
    await sleep(500);
    assert.equal(hub.stats().cameras.length, 0, "el lazo se detiene tras la gracia");
    const n = cams.calls.length;
    await sleep(400);
    assert.equal(cams.calls.length, n, "sin pedidos después de la gracia");
    assert.ok(hub.peek("s1:1"), "el último cuadro sigue disponible");
  } finally {
    hub.stop();
  }
});

test("LiveHub: tope por servidor y la vista ampliada pasa antes que la grilla", async () => {
  const cams = fakeCameras();
  const hub = new LiveHub(cams, null, cfg({ maxConcurrentPerServer: 4, pipelineGrid: 1 }));
  try {
    for (let i = 0; i < 20; i++) hub.subscribe(`s1:${i}`, { fps: 4, tierW: 320, prio: "grid" }, collect().sink);
    await sleep(50);
    assert.equal(pending(cams.calls), 4);
    hub.subscribe("s1:focus", { fps: 10, tierW: 1280, prio: "focus" }, collect().sink);
    await sleep(20);
    assert.equal(pending(cams.calls), 4, "el tope se respeta");
    cams.calls[0]!.resolve(snap(frame()));
    await sleep(20);
    assert.equal(cams.calls.length, 5);
    assert.equal(cams.calls[4]!.key, "s1:focus", "el lugar liberado es para la vista ampliada");
    assert.ok(pending(cams.calls) <= 4);
    for (const c of cams.calls) if (!c.done) c.resolve(snap(frame()));
  } finally {
    hub.stop();
  }
});

test("LiveHub: el gobernador reduce la grilla al superar el ancho de banda y no toca la vista ampliada", async () => {
  // 1 MB/s de presupuesto y cuadros de 500 KB a 4 fps (≈2 MB/s).
  const cams = fakeCameras({ auto: () => frame(500_000) });
  const hub = new LiveHub(cams, null, cfg({ maxUpstreamMbps: 8 }));
  try {
    hub.subscribe("s1:grid", { fps: 4, tierW: 0, prio: "grid" }, collect().sink);
    hub.subscribe("s1:focus", { fps: 4, tierW: 0, prio: "focus" }, collect().sink);
    for (let i = 0; i < 4; i++) {
      await sleep(500);
      hub.tick();
    }
    const st = hub.stats();
    assert.ok(st.servers[0]!.gridScale < 1, `escala ${st.servers[0]!.gridScale}`);
    const grid = st.cameras.find((c) => c.key === "s1:grid")!;
    const focus = st.cameras.find((c) => c.key === "s1:focus")!;
    assert.ok(grid.effFps < 4, `grilla ${grid.effFps}`);
    assert.equal(focus.effFps, 4, "la vista ampliada no se escala");
  } finally {
    hub.stop();
  }
});

test("LiveHub: espera creciente ante errores y estado 'stalled'", async () => {
  let fail = true;
  const cams = fakeCameras({ auto: () => (fail ? new Error("caído") : frame()) });
  const hub = new LiveHub(cams, null, cfg());
  try {
    const a = collect();
    hub.subscribe("s1:1", { fps: 4, tierW: 0, prio: "grid" }, a.sink);
    await sleep(1900);
    assert.ok(a.states.some((s) => s.st === "stalled"), JSON.stringify(a.states));
    assert.ok(cams.calls.length <= 5, `pedidos con espera creciente: ${cams.calls.length}`);
    fail = false;
    await sleep(2500);
    assert.equal(a.states.at(-1)!.st, "live");
    assert.ok(a.frames.length >= 1);
  } finally {
    hub.stop();
  }
});

test("LiveHub: el disyuntor se abre ante fallas generalizadas del servidor y se recupera", async () => {
  let fail = true;
  const cams = fakeCameras({ auto: () => (fail ? new Error("túnel caído") : frame()) });
  const hub = new LiveHub(cams, null, cfg());
  try {
    for (let i = 0; i < 6; i++) hub.subscribe(`s1:${i}`, { fps: 4, tierW: 0, prio: "grid" }, collect().sink);
    await sleep(200);
    assert.equal(hub.stats().servers[0]!.breaker, "open");
    const n = cams.calls.length;
    await sleep(1000);
    assert.equal(cams.calls.length, n, "abierto: no se pide nada");
    fail = false;
    await sleep(3500);
    assert.equal(hub.stats().servers[0]!.breaker, "closed");
    assert.ok(cams.calls.length > n + 1);
  } finally {
    hub.stop();
  }
});

test("LiveHub: camera.status offline detiene los pedidos y online los reanuda", async () => {
  const bus = new Bus();
  const cams = fakeCameras({ auto: () => frame() });
  const hub = new LiveHub(cams, bus, cfg());
  try {
    const a = collect();
    hub.subscribe("s1:1", { fps: 4, tierW: 0, prio: "grid" }, a.sink);
    await sleep(300);
    bus.publish("camera.status", { id: "s1:1", online: false });
    assert.equal(a.states.at(-1)!.st, "offline");
    const n = cams.calls.length;
    await sleep(600);
    assert.equal(cams.calls.length, n, "sin pedidos mientras está sin señal");
    bus.publish("camera.status", { id: "s1:1", online: true });
    await sleep(400);
    assert.ok(cams.calls.length > n);
    assert.equal(a.states.at(-1)!.st, "live");
    // Deshabilitada en la base: ni siquiera se pide.
    cams.rows.get("s1:1")!.enabled = 0;
    const c = collect();
    hub.subscribe("s1:1", { fps: 4, tierW: 0, prio: "grid" }, c.sink);
    assert.equal(c.states[0]!.st, "disabled");
    await assert.rejects(hub.pull("s1:1", { tierW: 640, fps: 1, maxAgeMs: 100 }), /deshabilitada/);
  } finally {
    hub.stop();
  }
});

test("LiveHub: pull comparte el lazo y reutiliza un cuadro reciente", async () => {
  const cams = fakeCameras({ auto: () => frame() });
  const hub = new LiveHub(cams, null, cfg());
  try {
    const f1 = await hub.pull("s1:1", { tierW: 640, fps: 1, maxAgeMs: 1000 });
    const n = cams.calls.length;
    const f2 = await hub.pull("s1:1", { tierW: 640, fps: 1, maxAgeMs: 1000 });
    assert.equal(f2.issueSeq, f1.issueSeq, "cuadro reciente reutilizado");
    assert.equal(cams.calls.length, n);
  } finally {
    hub.stop();
  }
});

test("cuadros en vivo: cancelar o fallar no cambia el estado del servidor exacq (salvo una racha larga)", async () => {
  let hang = true;
  const remote = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/v1/login.web") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ sessionId: "s" }));
    }
    if (url.pathname === "/v1/config.web") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ Cameras: [{ id: 1, name: "A", state: 0 }] }));
    }
    if (url.pathname === "/v1/video.web") {
      if (hang) return; // nunca responde
      res.setHeader("content-type", "image/jpeg");
      return res.end(frame());
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => remote.listen(0, "127.0.0.1", r));
  const statuses: boolean[] = [];
  const src = new ExacqSource({ id: "x", name: "X", baseUrl: `http://127.0.0.1:${(remote.address() as AddressInfo).port}` }, () => ({ username: "u", password: "p" }), (st) => statuses.push(st.ok));
  try {
    await src.listCameras();
    assert.equal(src.status().ok, true);
    const ac = new AbortController();
    const p = src.snapshot("1", { live: true, signal: ac.signal, timeoutMs: 5000 });
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(p, (e: { kind?: string }) => e.kind === "aborted");
    for (let i = 0; i < 9; i++) await assert.rejects(src.snapshot("1", { live: true, timeoutMs: 60 }));
    assert.equal(src.status().ok, true, "9 fallas de cuadros en vivo no cambian el estado");
    await assert.rejects(src.snapshot("1", { live: true, timeoutMs: 60 }));
    assert.equal(src.status().ok, false, "la décima seguida sí");
    hang = false;
    const ok = await src.snapshot("1", { live: true });
    assert.equal(ok.width, 16);
    assert.deepEqual(statuses, [true, false]);
  } finally {
    remote.closeAllConnections();
    await new Promise<void>((r) => remote.close(() => r()));
  }
});
