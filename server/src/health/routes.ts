import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { AppCtx } from "../context.js";
import { HttpError, clientIp } from "../http/guards.js";
import { publicHost } from "./service.js";

const HostBody = z.object({
  name: z.string().min(1).max(80),
  host: z.string().min(1).max(255).regex(/^[a-zA-Z0-9.:-]+$/, "Host inválido"),
  port: z.number().int().min(1).max(65535),
  kind: z.enum(["exacq", "fortigate", "nvr", "camera", "switch", "server", "other"]).default("other"),
});

export function registerHealthRoutes(app: FastifyInstance, ctx: AppCtx) {
  const { guard, health, audit, cameras, events, vpn, ai } = ctx;

  app.get("/api/health/hosts", async (req) => {
    guard(req);
    return health.list().map(publicHost);
  });

  app.post("/api/health/hosts", async (req) => {
    const a = guard(req, { role: "admin" });
    const b = HostBody.parse(req.body);
    const id = health.add(b);
    audit.log({ userId: a.user.id, username: a.user.username, action: "health.host_add", target: `${b.host}:${b.port}`, ip: clientIp(req) });
    return { id };
  });

  app.delete<{ Params: { id: string } }>("/api/health/hosts/:id", async (req) => {
    const a = guard(req, { role: "admin" });
    if (!health.remove(req.params.id)) throw new HttpError(404, "Equipo inexistente", "not_found");
    audit.log({ userId: a.user.id, username: a.user.username, action: "health.host_remove", target: req.params.id, ip: clientIp(req) });
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/health/hosts/:id/history", async (req) => {
    guard(req);
    return health.history(req.params.id);
  });

  app.get("/api/health/system", async (req) => {
    guard(req);
    return health.system();
  });

  /** Resumen único para el tablero NOC/SOC. */
  app.get("/api/dashboard", async (req) => {
    guard(req);
    // Las deshabilitadas en exacqVision (y las ocultas por el usuario) no cuentan como "sin señal".
    const cams = cameras.list().filter((c) => c.enabled);
    const vmsDisabled = cameras.list({ includeVmsDisabled: true }).filter((c) => c.vmsDisabled).length;
    return {
      now: Date.now(),
      demo: ctx.cfg.DEMO_MODE,
      threat: events.threatLevel(),
      stats: events.stats(24),
      cameras: {
        total: cams.length,
        online: cams.filter((c) => c.online).length,
        offline: cams.filter((c) => !c.online).map((c) => ({ id: c.id, name: c.name })),
        detection: cams.filter((c) => c.motionEnabled).length,
        aiVerify: cams.filter((c) => c.aiVerify).length,
        vmsDisabled,
      },
      sources: cameras.sourceStatuses(),
      vpn: vpn.status(),
      hosts: health.list().map(publicHost),
      system: health.system(),
      ai: { available: ai.available(), model: ai.model, budget: ai.budget(), engine: ctx.detection.stats },
      recent: events.list({ limit: 12, silent: false }),
    };
  });
}
