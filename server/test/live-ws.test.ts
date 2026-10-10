import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import { buildApp, type BuiltApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { decodeFrame } from "../src/live/protocol.js";
import { parseJpegInfo } from "../src/video/jpeg.js";

const INITIAL_PW = "Inicial!Segura2026";
const NEW_PW = "Cambiada!Segura2026";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Msg = { t?: string; [k: string]: unknown };

interface Client {
  ws: WebSocket;
  texts: Msg[];
  frames: NonNullable<ReturnType<typeof decodeFrame>>[];
  closed: Promise<{ code: number; reason: string }>;
  send: (m: unknown) => void;
}

describe("WebSocket /api/live: autenticación, créditos y límites", () => {
  let built: BuiltApp;
  let app: FastifyInstance;
  let dir: string;
  let base: string;
  let origin: string;
  let admin = "";
  let viewer = "";
  let restricted = "";

  const inject = async (method: string, url: string, cookie: string, body?: unknown) => {
    const res = await app.inject({ method: method as "GET", url, payload: body as object, headers: { cookie, "x-requested-with": "CamerasIA" } });
    const sc = res.headers["set-cookie"];
    return { status: res.statusCode, json: res.headers["content-type"]?.includes("json") ? res.json() : undefined, cookie: sc ? String(Array.isArray(sc) ? sc[0] : sc).split(";")[0]! : "", res };
  };

  const login = async (username: string, password: string) => {
    const r = await inject("POST", "/api/auth/login", "", { username, password });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.cookie;
  };

  /** Abre un WebSocket; resuelve con el código HTTP si el handshake se rechaza. */
  const connect = (headers: Record<string, string>, pathName = "/api/live") =>
    new Promise<{ client?: Client; status?: number }>((resolve) => {
      const ws = new WebSocket(`${base.replace("http", "ws")}${pathName}`, { headers });
      const texts: Msg[] = [];
      const frames: Client["frames"] = [];
      const closed = new Promise<{ code: number; reason: string }>((r) => ws.on("close", (code, reason) => r({ code, reason: reason.toString() })));
      ws.on("message", (data, isBinary) => {
        if (isBinary) {
          const f = decodeFrame(data as Buffer);
          assert.ok(f, "cabecera binaria válida");
          frames.push(f);
        } else texts.push(JSON.parse(data.toString()));
      });
      ws.on("open", () => resolve({ client: { ws, texts, frames, closed, send: (m) => ws.send(typeof m === "string" ? m : JSON.stringify(m)) } }));
      ws.on("unexpected-response", (req, res) => {
        req.destroy();
        resolve({ status: res.statusCode });
      });
      ws.on("error", () => undefined);
    });

  const open = async (cookie = admin) => {
    const r = await connect({ cookie, origin });
    assert.ok(r.client, `conexión rechazada (${r.status})`);
    return r.client;
  };

  const shut = async (c: Client) => {
    c.ws.close();
    await c.closed;
    await sleep(30);
  };

  const waitFor = async <T>(fn: () => T | undefined, ms = 4000): Promise<T> => {
    const t0 = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error("tiempo de espera agotado");
      await sleep(20);
    }
  };

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cia-live-"));
    const cfg = loadConfig({
      DATA_DIR: dir,
      DEMO_MODE: "true",
      REQUIRE_2FA: "false",
      ADMIN_INITIAL_PASSWORD: INITIAL_PW,
      VPN_MODE: "simulate",
      LOG_LEVEL: "error",
      LIVE_REVALIDATE_MS: "200",
    } as NodeJS.ProcessEnv);
    built = await buildApp(cfg, { logger: false });
    app = built.app;
    await built.ctx.auth.ensureInitialAdmin(() => undefined);
    await built.ctx.cameras.reload();
    await built.ctx.cameras.sync();
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    origin = base;
    const first = await login("admin", INITIAL_PW);
    assert.equal((await inject("POST", "/api/auth/password", first, { current: INITIAL_PW, next: NEW_PW })).status, 200);
    admin = first;
    await built.ctx.auth.createUser({ username: "visor", role: "viewer", password: INITIAL_PW, mustChange: true });
    viewer = await login("visor", INITIAL_PW);
    assert.equal((await inject("POST", "/api/auth/password", viewer, { current: INITIAL_PW, next: NEW_PW })).status, 200);
    await built.ctx.auth.createUser({ username: "nuevo", role: "viewer", password: INITIAL_PW, mustChange: true });
    restricted = await login("nuevo", INITIAL_PW);
  });

  after(async () => {
    await built.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("el handshake exige sesión, Origin válido y sesión sin restricciones", async () => {
    assert.equal((await connect({ origin })).status, 401, "sin cookie");
    assert.equal((await connect({ cookie: admin, origin: "https://evil.example" })).status, 403, "otro origen");
    assert.equal((await connect({ cookie: admin, origin: "null" })).status, 403, "Origin null");
    assert.equal((await connect({ cookie: admin })).status, 403, "sin Origin");
    assert.equal((await connect({ cookie: restricted, origin })).status, 403, "debe cambiar la clave");
    const ping = await inject("GET", "/api/ping", admin);
    assert.equal(ping.status, 200, "el servidor sigue vivo");
    assert.match(String(ping.res.headers["content-security-policy"]), /connect-src 'self'/);
    // /api/ws con Origin "null" ya no lanza una excepción: cierra con 4403.
    const legacy = await connect({ cookie: admin, origin: "null" }, "/api/ws");
    assert.ok(legacy.client);
    assert.equal((await legacy.client.closed).code, 4403);
  });

  test("como máximo 4 conexiones por usuario", async () => {
    const cs = [];
    for (let i = 0; i < 4; i++) cs.push(await open());
    assert.equal((await connect({ cookie: admin, origin })).status, 429);
    for (const c of cs) await shut(c);
    const again = await open();
    await shut(again);
  });

  test("un cuadro binario lleva la cabecera de 32 bytes coherente con el JPEG", async () => {
    const c = await open(viewer);
    try {
      const welcome = await waitFor(() => c.texts.find((m) => m.t === "welcome"));
      assert.equal(welcome.v, 1);
      c.send({ t: "hello", v: 1 });
      c.send({ t: "sub", s: 7, cam: "demo:1", fps: 2, maxW: 640, prio: "grid" });
      const f = await waitFor(() => c.frames[0]);
      assert.equal(f.version, 1);
      assert.equal(f.kind, 1);
      assert.equal(f.subId, 7);
      assert.equal(f.seq, 1);
      const info = parseJpegInfo(f.payload);
      assert.ok(info);
      assert.equal(f.width, info.width);
      assert.equal(f.height, info.height);
      assert.ok(Math.abs(Date.now() - f.tCap) < 10_000);
      assert.ok(c.texts.some((m) => m.t === "state" && m.s === 7));
      c.send({ t: "ping", c: 123.5 });
      const pong = await waitFor(() => c.texts.find((m) => m.t === "pong"));
      assert.equal(pong.c, 123.5);
    } finally {
      await shut(c);
    }
  });

  test("créditos: sin confirmación no llegan más cuadros; al confirmar llega el último", async () => {
    const c = await open();
    try {
      c.send({ t: "sub", s: 3, cam: "demo:2", fps: 4, maxW: 320, prio: "grid" });
      await waitFor(() => c.frames[0]);
      await sleep(1500);
      assert.equal(c.frames.length, 1, "grilla: 1 crédito");
      c.send({ t: "ack", a: [[3, c.frames[0]!.seq, 4]] });
      const second = await waitFor(() => c.frames[1], 1500);
      assert.ok(second.seq > c.frames[0]!.seq, "seq estrictamente creciente");
      assert.ok(second.dropped > 0, `descartados: ${second.dropped}`);
      const stats = await inject("GET", "/api/live/stats", admin);
      assert.equal(stats.status, 200);
      assert.ok(stats.json.connections.some((x: { droppedBackpressure: number }) => x.droppedBackpressure > 0));
      assert.ok(stats.json.cameras.some((x: { key: string }) => x.key === "demo:2"));
      assert.equal((await inject("GET", "/api/live/stats", viewer)).status, 403, "estadísticas: sólo Administrador o Tester");
    } finally {
      await shut(c);
    }
  });

  test("límites: suscripciones, vistas ampliadas, fps y cámaras inexistentes", async () => {
    const c = await open();
    const c2 = await open();
    try {
      for (let s = 1; s <= 25; s++) c.send({ t: "sub", s, cam: `demo:${(s % 7) + 1}`, fps: 1, maxW: 320, prio: "grid" });
      c.send({ t: "sub", s: 26, cam: "demo:1", fps: 1, maxW: 320, prio: "grid" });
      await waitFor(() => c.texts.find((m) => m.t === "err" && m.s === 26 && m.code === "too_many_subs"));
      c2.send({ t: "sub", s: 1, cam: "demo:3", fps: 60, maxW: 1920, prio: "focus" });
      c2.send({ t: "sub", s: 2, cam: "demo:4", fps: 10, maxW: 1920, prio: "focus" });
      c2.send({ t: "sub", s: 3, cam: "demo:5", fps: 10, maxW: 1920, prio: "focus" });
      await waitFor(() => c2.texts.find((m) => m.t === "err" && m.s === 3 && m.code === "too_many_focus"));
      const st = await waitFor(() => c2.texts.find((m) => m.t === "state" && m.s === 1));
      assert.ok((st.effFps as number) <= 12, `fps efectivos ${st.effFps}`);
      c2.send({ t: "sub", s: 9, cam: "demo:999", fps: 1, maxW: 320 });
      await waitFor(() => c2.texts.find((m) => m.t === "err" && m.s === 9 && m.code === "not_found"));
      c2.send("{no es json");
      await waitFor(() => c2.texts.find((m) => m.t === "err" && m.code === "bad_msg"));
      assert.equal(c2.ws.readyState, WebSocket.OPEN, "un mensaje inválido no cierra la conexión");
      c2.send({ t: "sub", s: 10, cam: "x".repeat(5000), fps: 1 });
      assert.equal((await c2.closed).code, 1009);
    } finally {
      await shut(c);
      if (c2.ws.readyState === WebSocket.OPEN) await shut(c2);
    }
  });

  test("inundar con mensajes cierra con 1008", async () => {
    const c = await open();
    for (let i = 0; i < 120; i++) c.send({ t: "ping", c: i });
    assert.equal((await c.closed).code, 1008);
    await sleep(30);
  });

  test("cerrar la sesión corta el video con 4401", async () => {
    const session = await login("admin", NEW_PW);
    const c = await open(session);
    c.send({ t: "sub", s: 1, cam: "demo:1", fps: 1, maxW: 320, prio: "grid" });
    await waitFor(() => c.frames[0]);
    assert.equal((await inject("POST", "/api/auth/logout", session)).status, 200);
    const t0 = Date.now();
    const closed = await c.closed;
    assert.equal(closed.code, 4401);
    assert.ok(Date.now() - t0 < 2000);
  });

  test("snapshot con ?w= usa el hub y la prueba de perfil respeta los roles", async () => {
    const r = await inject("GET", "/api/cameras/demo%3A1/snapshot?w=300&fps=2", viewer);
    assert.equal(r.status, 200);
    assert.equal(r.res.headers["content-type"], "image/jpeg");
    assert.ok(parseJpegInfo(r.res.rawPayload));
    assert.match(String(r.res.headers["x-frame-size"]), /^\d+x\d+$/);
    assert.equal((await inject("POST", "/api/exacq/servers/demo/live-probe", viewer)).status, 403);
  });
});
