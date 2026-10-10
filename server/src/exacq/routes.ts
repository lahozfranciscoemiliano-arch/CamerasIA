import crypto from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { AppCtx } from "../context.js";
import { HttpError, clientIp } from "../http/guards.js";
import { ExacqSource, normalizeBaseUrl } from "./client.js";
import { diagnosticConfig } from "./diagnostics.js";
import { EXTRA_RE, manualProfile, publicLiveProfile, type LiveProfile } from "./live-profile.js";
import { publicCamera, type ExacqServerRow } from "./service.js";
import { tierFor } from "../live/protocol.js";

const PatchCamera = z.object({
  name: z.string().min(1).max(80).optional(),
  zone: z.string().max(80).nullable().optional(),
  enabled: z.boolean().optional(),
  motionEnabled: z.boolean().optional(),
  aiVerify: z.boolean().optional(),
  sensitivity: z.number().int().min(1).max(100).optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

const RangeQuery = z.object({ start: z.coerce.date(), end: z.coerce.date() });
const ExportBody = z.object({ camera: z.string().min(1), start: z.coerce.date(), end: z.coerce.date() });

const template = z
  .string()
  .max(500)
  .regex(/^\/[^\s]*$/, "La plantilla debe ser una ruta que empiece con / (sin esquema ni host)")
  .refine((v) => !v.startsWith("//"), "Ruta inválida");

const ServerBody = z.object({
  name: z.string().min(1).max(80),
  baseUrl: z.preprocess(
    (v) => {
      if (typeof v !== "string") return v;
      try {
        return normalizeBaseUrl(v);
      } catch {
        return v;
      }
    },
    z
      .string()
      .url("URL inválida: use por ejemplo http://192.168.109.58")
      .refine((u) => /^https?:\/\//.test(u), "Use http:// o https://")
      .refine((u) => !/^https?:\/\/[^/]*@/.test(u), "No incluya usuario/contraseña en la URL: use una credencial de la bóveda"),
  ),
  credentialId: z.string().uuid().nullable().optional(),
  enabled: z.boolean().default(true),
  snapshotTemplate: template.nullable().optional(),
  liveTemplate: template.nullable().optional(),
  vpnProfileId: z.string().nullable().optional(),
  timezone: z.string().max(64).nullable().optional(),
  /** Perfil de video en vivo manual (sólo PATCH): parámetros extra de tamaño y calidad; null lo borra. */
  liveProfile: z
    .object({
      resize: z.object({ extra: z.string().regex(EXTRA_RE, "Parámetros de tamaño inválidos") }).nullable().optional(),
      quality: z.object({ extra: z.string().regex(EXTRA_RE, "Parámetros de calidad inválidos") }).nullable().optional(),
    })
    .nullable()
    .optional(),
});

const publicServer = (s: ExacqServerRow, liveProfile: LiveProfile | null = null) => ({
  id: s.id,
  name: s.name,
  baseUrl: s.base_url,
  credentialId: s.credential_id,
  enabled: Boolean(s.enabled),
  snapshotTemplate: s.snapshot_template,
  liveTemplate: s.live_template,
  vpnProfileId: s.vpn_profile_id,
  timezone: s.timezone,
  lastOkAt: s.last_ok_at,
  lastError: s.last_error,
  liveProfile: publicLiveProfile(liveProfile),
});

export function registerCameraRoutes(app: FastifyInstance, ctx: AppCtx) {
  const { guard, cameras, audit, db } = ctx;

  app.get("/api/cameras", async (req) => {
    guard(req);
    return cameras.list();
  });

  app.patch<{ Params: { key: string } }>("/api/cameras/:key", async (req) => {
    const a = guard(req, { role: "admin" });
    const body = PatchCamera.parse(req.body);
    const row = cameras.row(req.params.key);
    if (!row) throw new HttpError(404, "Cámara inexistente", "not_found");
    db.run(
      `UPDATE cameras SET name = $name, zone = $zone, enabled = $enabled, motion_enabled = $motion, ai_verify = $ai,
       sensitivity = $sens, sort_order = $order WHERE id = $id`,
      {
        name: body.name ?? row.name,
        zone: body.zone === undefined ? row.zone : body.zone,
        enabled: body.enabled ?? Boolean(row.enabled),
        motion: body.motionEnabled ?? Boolean(row.motion_enabled),
        ai: body.aiVerify ?? Boolean(row.ai_verify),
        sens: body.sensitivity ?? row.sensitivity,
        order: body.sortOrder ?? row.sort_order,
        id: row.id,
      },
    );
    audit.log({ userId: a.user.id, username: a.user.username, action: "camera.update", target: row.id, ip: clientIp(req), details: body });
    const src = cameras.sources.get(row.server_id);
    return publicCamera(cameras.row(row.id)!, src?.name, src?.kind);
  });

  app.get<{ Params: { key: string }; Querystring: { w?: string; fps?: string } }>("/api/cameras/:key/snapshot", { config: { rateLimit: { max: 6000, timeWindow: "1 minute" } } }, async (req, reply) => {
    guard(req);
    const w = Number(req.query.w);
    if (cameras.live && Number.isFinite(w) && w > 0) {
      // Visor en vivo por HTTP (respaldo del WebSocket): comparte el lazo de la cámara en el hub y
      // recibe un cuadro del ancho pedido. Errores genéricos: no se expone la URL interna del exacq.
      const fps = Math.min(Math.max(Number(req.query.fps) || 1, 0.2), 10);
      try {
        const f = await cameras.live.pull(req.params.key, { tierW: tierFor(w), fps, maxAgeMs: Math.max(200, 1000 / fps), timeoutMs: 4000 });
        reply.header("Cache-Control", "no-store").header("X-Frame-Size", `${f.w}x${f.h}`).header("X-Frame-Age", String(Math.max(0, Math.round(Date.now() - f.tCap)))).type("image/jpeg");
        return f.data;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode ?? 502;
        throw new HttpError(status, status === 404 ? "Cámara inexistente" : "Sin imagen de la cámara", "snapshot_failed");
      }
    }
    try {
      const snap = await cameras.snapshot(req.params.key);
      reply.header("Cache-Control", "no-store").type(snap.contentType);
      return snap.data;
    } catch (e) {
      throw new HttpError((e as { statusCode?: number }).statusCode ?? 502, (e as Error).message, "snapshot_failed");
    }
  });

  app.get<{ Params: { key: string }; Querystring: { fps?: string; w?: string } }>("/api/cameras/:key/stream", async (req, reply) => {
    guard(req);
    await cameras.stream(req.params.key, req, reply, Number(req.query.fps ?? 2), { tierW: tierFor(Number(req.query.w)) });
  });

  app.get<{ Params: { key: string }; Querystring: { start?: string; speed?: string } }>("/api/cameras/:key/replay", async (req, reply) => {
    guard(req);
    const start = new Date(req.query.start ?? Date.now() - 600_000);
    if (Number.isNaN(start.getTime())) throw new HttpError(400, "Fecha inválida");
    await cameras.replay(req.params.key, start, Math.min(Math.max(Number(req.query.speed ?? 1), 0.25), 16), req, reply);
  });

  app.get<{ Params: { key: string } }>("/api/cameras/:key/recordings", async (req) => {
    guard(req);
    const q = RangeQuery.parse(req.query);
    if (q.end.getTime() - q.start.getTime() > 7 * 24 * 3600_000) throw new HttpError(400, "Rango máximo: 7 días");
    try {
      return await cameras.searchRecordings(req.params.key, q.start, q.end);
    } catch (e) {
      throw new HttpError(502, (e as Error).message, "search_failed");
    }
  });

  // ───────── Exportación / reproducción de grabaciones ─────────
  app.post("/api/recordings/export", async (req) => {
    const a = guard(req, { role: "operator" });
    const body = ExportBody.parse(req.body);
    const span = body.end.getTime() - body.start.getTime();
    if (span <= 0 || span > 2 * 3600_000) throw new HttpError(400, "El clip debe durar entre 1 segundo y 2 horas");
    const job = cameras.startExport(body.camera, body.start, body.end, a.user.username);
    audit.log({
      userId: a.user.id,
      username: a.user.username,
      action: "recording.export",
      target: body.camera,
      ip: clientIp(req),
      details: { start: job.start, end: job.end },
    });
    return job;
  });

  app.get("/api/recordings/exports", async (req) => {
    guard(req);
    return [...cameras.exports.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
  });

  app.get<{ Params: { id: string } }>("/api/recordings/export/:id", async (req) => {
    guard(req);
    const job = cameras.exports.get(req.params.id);
    if (!job) throw new HttpError(404, "Exportación inexistente", "not_found");
    return job;
  });

  app.get<{ Params: { id: string }; Querystring: { download?: string } }>("/api/recordings/export/:id/file", async (req, reply) => {
    const a = guard(req);
    const job = cameras.exports.get(req.params.id);
    if (!job?.file || job.status !== "ready") throw new HttpError(404, "Archivo no disponible", "not_found");
    if (req.query.download) {
      audit.log({ userId: a.user.id, username: a.user.username, action: "recording.download", target: job.cameraKey, ip: clientIp(req) });
      reply.header("Content-Disposition", `attachment; filename="${(job.filename ?? "clip.mp4").replace(/"/g, "")}"`);
    }
    return reply.sendFile(job.file, ctx.cfg.paths.exports);
  });

  // ───────── Servidores exacqVision (administración y diagnósticos) ─────────
  app.get("/api/exacq/servers", async (req) => {
    guard(req, { role: "tester" });
    return cameras.servers().map((s) => publicServer(s, cameras.liveProfile(s.id)));
  });

  app.get("/api/exacq/status", async (req) => {
    guard(req);
    return cameras.sourceStatuses();
  });

  app.post("/api/exacq/servers", async (req) => {
    const a = guard(req, { role: "admin", stepUp: true });
    const { liveProfile: _ignored, ...b } = ServerBody.parse(req.body);
    const id = crypto.randomUUID();
    const now = Date.now();
    db.run(
      `INSERT INTO exacq_servers(id, name, base_url, credential_id, enabled, snapshot_template, live_template, vpn_profile_id, timezone, created_at, updated_at)
       VALUES($id, $name, $url, $cred, $enabled, $snap, $live, $vpn, $tz, $now, $now)`,
      { id, name: b.name, url: b.baseUrl, cred: b.credentialId, enabled: b.enabled, snap: b.snapshotTemplate, live: b.liveTemplate, vpn: b.vpnProfileId, tz: b.timezone, now },
    );
    audit.log({ userId: a.user.id, username: a.user.username, action: "exacq.server_create", target: b.name, ip: clientIp(req), details: { baseUrl: b.baseUrl } });
    await cameras.reload();
    void cameras.sync().catch(() => undefined);
    return publicServer(db.get<ExacqServerRow>("SELECT * FROM exacq_servers WHERE id = $id", { id })!);
  });

  app.patch<{ Params: { id: string } }>("/api/exacq/servers/:id", async (req) => {
    const a = guard(req, { role: "admin", stepUp: true });
    const cur = db.get<ExacqServerRow>("SELECT * FROM exacq_servers WHERE id = $id", { id: req.params.id });
    if (!cur) throw new HttpError(404, "Servidor inexistente", "not_found");
    const b = ServerBody.partial().parse(req.body);
    // Perfil de video en vivo: manual (nunca se reemplaza solo) o null para volver a probarlo.
    if (b.liveProfile !== undefined) {
      const prev = cameras.liveProfile(cur.id);
      cameras.setLiveProfile(cur.id, b.liveProfile ? manualProfile(b.liveProfile, prev) : null);
    } else if (b.snapshotTemplate !== undefined && b.snapshotTemplate !== cur.snapshot_template && cameras.liveProfile(cur.id)?.source !== "manual") {
      // Los parámetros se verificaron con la URL anterior.
      cameras.setLiveProfile(cur.id, null);
    }
    db.run(
      `UPDATE exacq_servers SET name = $name, base_url = $url, credential_id = $cred, enabled = $enabled, snapshot_template = $snap,
       live_template = $live, vpn_profile_id = $vpn, timezone = $tz, updated_at = $now WHERE id = $id`,
      {
        id: cur.id,
        name: b.name ?? cur.name,
        url: b.baseUrl ?? cur.base_url,
        cred: b.credentialId === undefined ? cur.credential_id : b.credentialId,
        enabled: b.enabled ?? Boolean(cur.enabled),
        snap: b.snapshotTemplate === undefined ? cur.snapshot_template : b.snapshotTemplate,
        live: b.liveTemplate === undefined ? cur.live_template : b.liveTemplate,
        vpn: b.vpnProfileId === undefined ? cur.vpn_profile_id : b.vpnProfileId,
        tz: b.timezone === undefined ? cur.timezone : b.timezone,
        now: Date.now(),
      },
    );
    audit.log({ userId: a.user.id, username: a.user.username, action: "exacq.server_update", target: cur.name, ip: clientIp(req), details: b });
    await cameras.reload();
    void cameras.sync().catch(() => undefined);
    return publicServer(db.get<ExacqServerRow>("SELECT * FROM exacq_servers WHERE id = $id", { id: cur.id })!, cameras.liveProfile(cur.id));
  });

  app.delete<{ Params: { id: string } }>("/api/exacq/servers/:id", async (req) => {
    const a = guard(req, { role: "admin", stepUp: true });
    const cur = db.get<ExacqServerRow>("SELECT * FROM exacq_servers WHERE id = $id", { id: req.params.id });
    if (!cur) throw new HttpError(404, "Servidor inexistente", "not_found");
    db.tx(() => {
      db.run("DELETE FROM cameras WHERE server_id = $id", { id: cur.id });
      db.run("DELETE FROM exacq_servers WHERE id = $id", { id: cur.id });
    });
    cameras.setLiveProfile(cur.id, null);
    audit.log({ userId: a.user.id, username: a.user.username, action: "exacq.server_delete", target: cur.name, ip: clientIp(req) });
    await cameras.reload();
    return { ok: true };
  });

  const exacqSource = (id: string) => {
    const src = cameras.sources.get(id);
    if (!(src instanceof ExacqSource)) throw new HttpError(404, "Servidor no activo (¿deshabilitado?)", "not_found");
    return src;
  };

  app.post<{ Params: { id: string } }>("/api/exacq/servers/:id/test", async (req) => {
    guard(req, { role: "tester" });
    const src = exacqSource(req.params.id);
    const t0 = Date.now();
    const result = await src.diagnose();
    if (result.cameras !== undefined) await cameras.sync().catch(() => undefined);
    return { ...result, latencyMs: Date.now() - t0 };
  });

  app.post<{ Params: { id: string }; Body: { cameraId?: string } }>("/api/exacq/servers/:id/detect", async (req) => {
    let a = guard(req, { role: "tester" });
    // Guardar la URL detectada modifica la configuración: sólo Administrador y con 2FA reciente,
    // igual que editar el servidor. Tester obtiene el resultado sin guardar.
    const apply = a.user.role === "admin";
    if (apply) a = guard(req, { role: "admin", stepUp: true });
    const src = exacqSource(req.params.id);
    const list = req.body?.cameraId ? [] : await src.listCameras();
    const cameraId = String(req.body?.cameraId ?? (list.find((c) => c.online) ?? list[0])?.cameraId ?? "");
    if (!cameraId) throw new HttpError(400, "No hay cámaras para probar");
    const result = await src.detectTemplates(cameraId, { apply });
    audit.log({ userId: a.user.id, username: a.user.username, action: "exacq.detect_templates", target: req.params.id, ip: clientIp(req), details: { snapshot: result.snapshot, live: result.live, applied: result.applied } });
    return result;
  });

  app.get<{ Params: { id: string } }>("/api/exacq/servers/:id/raw-config", async (req) => {
    const a = guard(req, { role: "tester" });
    const config = await exacqSource(req.params.id).rawConfig();
    return a.user.role === "tester" ? diagnosticConfig(config) : config;
  });
}
