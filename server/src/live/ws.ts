import { monitorEventLoopDelay } from "node:perf_hooks";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { AppCtx } from "../context.js";
import { ExacqError } from "../exacq/client.js";
import { publicLiveProfile } from "../exacq/live-profile.js";
import { HttpError, clientIp, isAllowedOrigin, sessionCookieName } from "../http/guards.js";
import type { LiveFrame, LiveHandle, LiveState } from "./hub.js";
import { ClientMessage, PROTOCOL_VERSION, encodeFrame, tierFor } from "./protocol.js";

/**
 * WebSocket dedicado al video en vivo (/api/live): cuadros JPEG binarios con control de flujo por
 * créditos (el cliente confirma cada cuadro pintado). Si el cliente o la red no dan abasto, se
 * guarda sólo el último cuadro de cada suscripción: nunca se encolan cuadros viejos.
 */

const MAX_MSG_BYTES = 4096;
const MSG_RATE = 30; // mensajes por segundo
const MSG_BURST = 60;
const PING_EVERY_MS = 15_000;
const PONG_TIMEOUT_MS = 35_000;
const STUCK_MS = 30_000;

interface WsSub {
  id: number;
  key: string;
  prio: "grid" | "focus";
  credits: number;
  sentSeq: number;
  ackedSeq: number;
  pending: LiveFrame | null;
  dropped: number;
  waitingSince: number;
  handle?: LiveHandle;
}

interface Conn {
  socket: WebSocket;
  userId: number;
  username: string;
  token: string;
  subs: Map<number, WsSub>;
  tokens: number;
  lastRefill: number;
  lastPingAt: number;
  lastPongAt: number;
  droppedBackpressure: number;
  framesSent: number;
  rr: number;
  openedAt: number;
}

export function registerLive(app: FastifyInstance, ctx: AppCtx) {
  const { cfg, auth, cameras, guard, audit } = ctx;
  const hub = ctx.live;
  const conns = new Set<Conn>();
  const eld = monitorEventLoopDelay({ resolution: 20 });
  eld.enable();
  app.addHook("onClose", async () => {
    eld.disable();
    for (const c of conns) c.socket.terminate();
  });

  const userConns = (userId: number) => [...conns].filter((c) => c.userId === userId).length;
  const userFocus = (userId: number) => {
    let n = 0;
    for (const c of conns) if (c.userId === userId) for (const s of c.subs.values()) if (s.prio === "focus") n++;
    return n;
  };
  const sendJson = (conn: Conn, msg: unknown) => {
    if (conn.socket.readyState === conn.socket.OPEN) conn.socket.send(JSON.stringify(msg));
  };

  const sendFrame = (conn: Conn, sub: WsSub, f: LiveFrame) => {
    sub.sentSeq++;
    if (sub.sentSeq - sub.ackedSeq === 1) sub.waitingSince = Date.now();
    const buf = encodeFrame({ subId: sub.id, seq: sub.sentSeq, tCap: f.tCap, upMs: f.upMs, width: f.w, height: f.h, flags: f.flags, dropped: sub.dropped }, f.data);
    sub.dropped = 0;
    conn.framesSent++;
    // El callback de send es la señal de "drenado": puede liberar cuadros pendientes.
    conn.socket.send(buf, { binary: true }, () => flushPending(conn));
  };

  const blocked = (conn: Conn, sub: WsSub) => sub.sentSeq - sub.ackedSeq >= sub.credits || conn.socket.bufferedAmount > cfg.LIVE_WS_HIGH_WATER_BYTES;

  const offer = (conn: Conn, sub: WsSub, f: LiveFrame) => {
    if (conn.socket.readyState !== conn.socket.OPEN || conn.subs.get(sub.id) !== sub) return;
    if (blocked(conn, sub)) {
      if (sub.pending) {
        sub.dropped = Math.min(0xffff, sub.dropped + 1);
        conn.droppedBackpressure++;
      }
      sub.pending = f; // sólo el último: nunca se encola
      return;
    }
    sendFrame(conn, sub, f);
  };

  /** Envía pendientes con créditos disponibles: primero vista ampliada, luego grilla en ronda. */
  function flushPending(conn: Conn) {
    if (conn.socket.readyState !== conn.socket.OPEN) return;
    const all = [...conn.subs.values()].filter((s) => s.pending);
    if (!all.length) return;
    const grid = all.filter((s) => s.prio !== "focus");
    const offset = grid.length ? conn.rr++ % grid.length : 0;
    const order = [...all.filter((s) => s.prio === "focus"), ...grid.slice(offset), ...grid.slice(0, offset)];
    for (const sub of order) {
      if (conn.socket.bufferedAmount > cfg.LIVE_WS_HIGH_WATER_BYTES) break;
      if (!sub.pending || sub.sentSeq - sub.ackedSeq >= sub.credits) continue;
      const f = sub.pending;
      sub.pending = null;
      sendFrame(conn, sub, f);
    }
  }

  const closeSub = (conn: Conn, sub: WsSub) => {
    conn.subs.delete(sub.id);
    sub.pending = null;
    sub.handle?.close();
  };

  const closeConn = (conn: Conn) => {
    if (!conns.delete(conn)) return;
    for (const sub of [...conn.subs.values()]) closeSub(conn, sub);
  };

  const handleMessage = (conn: Conn, raw: Buffer, isBinary: boolean) => {
    if (raw.length > MAX_MSG_BYTES) {
      conn.socket.close(1009, "message too big");
      return;
    }
    // Límite de mensajes: balde de fichas (30/s, ráfaga 60).
    const now = Date.now();
    conn.tokens = Math.min(MSG_BURST, conn.tokens + ((now - conn.lastRefill) / 1000) * MSG_RATE);
    conn.lastRefill = now;
    if (conn.tokens < 1) {
      conn.socket.close(1008, "flood");
      return;
    }
    conn.tokens--;
    if (isBinary) return sendJson(conn, { t: "err", code: "bad_msg" });
    let json: unknown;
    try {
      json = JSON.parse(raw.toString("utf8"));
    } catch {
      return sendJson(conn, { t: "err", code: "bad_msg" });
    }
    const parsed = ClientMessage.safeParse(json);
    if (!parsed.success) {
      const s = (json as { s?: unknown })?.s;
      return sendJson(conn, { t: "err", ...(typeof s === "number" ? { s } : {}), code: "bad_msg" });
    }
    const m = parsed.data;
    switch (m.t) {
      case "hello":
        if (m.v !== PROTOCOL_VERSION) sendJson(conn, { t: "err", code: "bad_msg" });
        return;
      case "ping":
        return sendJson(conn, { t: "pong", c: m.c, s: Date.now() });
      case "ack": {
        for (const [s, seq] of m.a) {
          const sub = conn.subs.get(s);
          if (!sub) continue;
          sub.ackedSeq = Math.min(sub.sentSeq, Math.max(sub.ackedSeq, seq));
          sub.waitingSince = sub.sentSeq > sub.ackedSeq ? now : 0;
        }
        flushPending(conn);
        return;
      }
      case "unsub": {
        const sub = conn.subs.get(m.s);
        if (sub) closeSub(conn, sub);
        return;
      }
      case "upd": {
        const sub = conn.subs.get(m.s);
        if (!sub) return sendJson(conn, { t: "err", s: m.s, code: "not_found" });
        let prio = m.prio;
        if (prio === "focus" && sub.prio !== "focus" && userFocus(conn.userId) >= cfg.LIVE_MAX_FOCUS_PER_USER) {
          sendJson(conn, { t: "err", s: m.s, code: "too_many_focus" });
          prio = undefined;
        }
        if (prio) {
          sub.prio = prio;
          sub.credits = prio === "focus" ? 2 : 1;
        }
        sub.handle?.update({ fps: m.fps, tierW: m.maxW === undefined ? undefined : tierFor(m.maxW), prio });
        flushPending(conn);
        return;
      }
      case "sub": {
        const prev = conn.subs.get(m.s);
        if (prev) closeSub(conn, prev);
        const row = cameras.row(m.cam);
        if (!row || !cameras.sources.has(row.server_id)) return sendJson(conn, { t: "err", s: m.s, code: "not_found" });
        if (conn.subs.size >= cfg.LIVE_MAX_SUBS_PER_CONN) return sendJson(conn, { t: "err", s: m.s, code: "too_many_subs" });
        if (m.prio === "focus" && userFocus(conn.userId) >= cfg.LIVE_MAX_FOCUS_PER_USER) return sendJson(conn, { t: "err", s: m.s, code: "too_many_focus" });
        const sub: WsSub = { id: m.s, key: m.cam, prio: m.prio, credits: m.prio === "focus" ? 2 : 1, sentSeq: 0, ackedSeq: 0, pending: null, dropped: 0, waitingSince: 0 };
        conn.subs.set(sub.id, sub);
        sub.handle = hub!.subscribe(
          m.cam,
          { fps: m.fps, tierW: tierFor(m.maxW), prio: m.prio },
          {
            onFrame: (f) => offer(conn, sub, f),
            onState: (s: LiveState) => {
              if (conn.subs.get(sub.id) === sub) sendJson(conn, { t: "state", s: sub.id, ...s });
            },
          },
        );
        return;
      }
    }
  };

  if (hub && cfg.LIVE_ENABLED) {
    app.get(
      "/api/live",
      {
        websocket: true,
        // Autenticación antes del upgrade: si falla, el handshake se rechaza con el código HTTP.
        preValidation: async (req) => {
          if (!isAllowedOrigin(req, cfg, { required: true })) throw new HttpError(403, "Origen no permitido", "origin");
          const a = auth.resolveSession(req.cookies[sessionCookieName(cfg)]);
          if (!a) throw new HttpError(401, "Sesión no válida o expirada", "unauthenticated");
          const r = auth.restrictions(a);
          if (r.mustChangePassword || r.mustEnrollTotp) throw new HttpError(403, "Sesión restringida", "restricted");
          if (userConns(a.user.id) >= cfg.LIVE_MAX_CONN_PER_USER) throw new HttpError(429, "Demasiadas conexiones de video abiertas", "too_many_connections");
          req.auth = a;
        },
      },
      (socket, req) => {
        const a = req.auth!;
        if (userConns(a.user.id) >= cfg.LIVE_MAX_CONN_PER_USER) {
          socket.close(1013, "overloaded");
          return;
        }
        const now = Date.now();
        const conn: Conn = {
          socket,
          userId: a.user.id,
          username: a.user.username,
          token: req.cookies[sessionCookieName(cfg)]!,
          subs: new Map(),
          tokens: MSG_BURST,
          lastRefill: now,
          lastPingAt: now,
          lastPongAt: now,
          droppedBackpressure: 0,
          framesSent: 0,
          rr: 0,
          openedAt: now,
        };
        conns.add(conn);
        sendJson(conn, {
          t: "welcome",
          v: PROTOCOL_VERSION,
          now: Date.now(),
          limits: { maxSubs: cfg.LIVE_MAX_SUBS_PER_CONN, maxFocus: cfg.LIVE_MAX_FOCUS_PER_USER, gridMaxFps: cfg.LIVE_GRID_MAX_FPS, focusMaxFps: cfg.LIVE_FOCUS_MAX_FPS },
        });

        // Latido: ping cada 15 s, se corta si no hay pong en 35 s (sockets medio abiertos mantendrían
        // vivos los lazos de las cámaras). Cliente trabado: sin confirmaciones en 30 s → 4408.
        const heartbeat = setInterval(() => {
          const t = Date.now();
          if (t - conn.lastPongAt > PONG_TIMEOUT_MS) return socket.terminate();
          if (t - conn.lastPingAt >= PING_EVERY_MS) {
            conn.lastPingAt = t;
            try {
              socket.ping();
            } catch {
              /* socket cerrándose */
            }
          }
          for (const s of conn.subs.values()) {
            if (s.sentSeq > s.ackedSeq && s.waitingSince && t - s.waitingSince > STUCK_MS) return socket.close(4408, "stuck");
          }
        }, Math.min(5000, PING_EVERY_MS));
        // Revalidación de la sesión (logout, expiración, usuario deshabilitado o rol restringido).
        const revalidate = setInterval(() => {
          const s = auth.resolveSession(conn.token);
          if (!s) return socket.close(4401, "session");
          const r = auth.restrictions(s);
          if (r.mustChangePassword || r.mustEnrollTotp) socket.close(4403, "restricted");
        }, Math.max(100, cfg.LIVE_REVALIDATE_MS));

        socket.on("pong", () => {
          conn.lastPongAt = Date.now();
        });
        socket.on("message", (raw: Buffer, isBinary: boolean) => {
          try {
            handleMessage(conn, Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer), isBinary);
          } catch (e) {
            req.log.warn({ err: e }, "live: mensaje no procesado");
            sendJson(conn, { t: "err", code: "bad_msg" });
          }
        });
        socket.on("error", () => undefined);
        socket.on("close", () => {
          clearInterval(heartbeat);
          clearInterval(revalidate);
          closeConn(conn);
        });
      },
    );
  }

  // ───────── Observabilidad ─────────
  app.get("/api/live/stats", async (req) => {
    guard(req, { role: "tester" });
    const ms = (ns: number) => Math.round((ns / 1e6) * 10) / 10;
    const loop = { p50: ms(eld.percentile(50)), p99: ms(eld.percentile(99)), max: ms(eld.max) };
    eld.reset();
    const hubStats = hub?.stats() ?? { servers: [], cameras: [] };
    const names = new Map(cameras.servers().map((s) => [s.id, s.name]));
    return {
      enabled: Boolean(hub && cfg.LIVE_ENABLED),
      ts: Date.now(),
      eventLoopMs: loop,
      servers: hubStats.servers.map((s) => ({ ...s, name: names.get(s.id) ?? (s.id === "demo" ? "Simulador DEMO" : s.id) })),
      cameras: hubStats.cameras.map((c) => ({ ...c, name: cameras.row(c.key)?.name ?? c.key })),
      connections: [...conns].map((c) => ({
        user: c.username,
        subs: c.subs.size,
        focus: [...c.subs.values()].filter((s) => s.prio === "focus").length,
        framesSent: c.framesSent,
        droppedBackpressure: c.droppedBackpressure,
        unacked: [...c.subs.values()].reduce((n, s) => n + (s.sentSeq - s.ackedSeq), 0),
        bufferedBytes: c.socket.bufferedAmount,
        since: c.openedAt,
      })),
      profiles: cameras.servers().map((s) => ({ id: s.id, name: s.name, enabled: Boolean(s.enabled), profile: publicLiveProfile(cameras.liveProfile(s.id)) })),
      limits: {
        gridMaxFps: cfg.LIVE_GRID_MAX_FPS,
        focusMaxFps: cfg.LIVE_FOCUS_MAX_FPS,
        maxConcurrentPerServer: cfg.LIVE_MAX_CONCURRENT_PER_SERVER,
        maxUpstreamMbps: cfg.LIVE_MAX_UPSTREAM_MBPS,
        maxUpstreamFpsPerServer: cfg.LIVE_MAX_UPSTREAM_FPS_PER_SERVER,
      },
    };
  });

  // ───────── Prueba del perfil de video en vivo ─────────
  app.post<{ Params: { id: string } }>("/api/exacq/servers/:id/live-probe", async (req) => {
    let a = guard(req, { role: "tester" });
    // Guardar el perfil modifica la configuración: sólo Administrador con 2FA reciente.
    // Tester obtiene el resultado sin guardar (igual que "Detectar video").
    const save = a.user.role === "admin";
    if (save) a = guard(req, { role: "admin", stepUp: true });
    let result;
    try {
      result = await ctx.liveProfiles.probe(req.params.id, { save, reason: "probe" });
    } catch (e) {
      const notFound = e instanceof ExacqError && e.kind === "not_found";
      throw new HttpError(notFound ? 404 : 502, (e as Error).message, notFound ? "not_found" : "probe_failed");
    }
    audit.log({
      userId: a.user.id,
      username: a.user.username,
      action: "exacq.live_probe",
      target: req.params.id,
      ip: clientIp(req),
      details: { saved: result.saved, resize: result.profile.resize?.extra ?? null, quality: result.profile.quality?.extra ?? null, concurrency: result.profile.recommendedConcurrency },
    });
    return { saved: result.saved, profile: publicLiveProfile(result.profile), steps: result.steps };
  });
}
