import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { AppCtx } from "../context.js";
import { isAllowedOrigin, sessionCookieName } from "../http/guards.js";
import type { RealtimeMessage } from "./bus.js";

const VPN_LOG_ROLES = new Set(["admin", "operator", "tester"]);

/** Canal WebSocket autenticado por cookie de sesión: empuja eventos, estado de VPN, cámaras y salud en tiempo real. */
export function registerRealtime(app: FastifyInstance, ctx: AppCtx) {
  const clients = new Map<WebSocket, { token: string; role: string }>();

  ctx.bus.on("message", (msg: RealtimeMessage) => {
    const payload = JSON.stringify(msg);
    for (const [socket, info] of clients) {
      if (msg.topic === "vpn.log" && !VPN_LOG_ROLES.has(info.role)) continue;
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  });

  // Revalida sesiones periódicamente (logout, expiración, usuario deshabilitado).
  setInterval(() => {
    for (const [socket, info] of clients) {
      const a = ctx.auth.resolveSession(info.token);
      if (!a || ctx.auth.restrictions(a).mustEnrollTotp || ctx.auth.restrictions(a).mustChangePassword) socket.close(4401, "session");
      else info.role = a.user.role;
    }
  }, 60_000).unref();

  app.get("/api/ws", { websocket: true }, (socket, req) => {
    // Origin "null" o inválido ya no lanza una excepción: se rechaza.
    if (!isAllowedOrigin(req, ctx.cfg)) {
      socket.close(4403, "origin");
      return;
    }
    const token = req.cookies[sessionCookieName(ctx.cfg)];
    const a = ctx.auth.resolveSession(token);
    if (!token || !a) {
      socket.close(4401, "unauthenticated");
      return;
    }
    const r = ctx.auth.restrictions(a);
    if (r.mustChangePassword || r.mustEnrollTotp) {
      socket.close(4403, "restricted");
      return;
    }
    clients.set(socket, { token, role: a.user.role });
    socket.send(JSON.stringify({ topic: "system.notice", data: { hello: a.user.username }, ts: Date.now() }));
    socket.on("message", (raw: Buffer) => {
      if (raw.toString() === "ping") socket.send(JSON.stringify({ topic: "pong", ts: Date.now() }));
    });
    socket.on("close", () => clients.delete(socket));
  });
}
