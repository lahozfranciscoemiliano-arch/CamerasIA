import crypto from "node:crypto";
import fs from "node:fs";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppCtx } from "../context.js";
import { HttpError, clientIp } from "../http/guards.js";
import { sha256, safeEqual } from "../security/crypto.js";
import { EVENT_STATUSES, EVENT_TYPES, SEVERITIES, type EventFilter } from "./service.js";
import { AlertSettingsSchema } from "./settings.js";

const StatusBody = z.object({ status: z.enum(EVENT_STATUSES) });
const NoteBody = z.object({ text: z.string().min(1).max(2000) });
const AssignBody = z.object({ assignee: z.string().max(64).nullable() });

const FilterBody = z.object({
  status: z.string().max(20).optional(),
  severity: z.string().max(80).optional(),
  type: z.string().max(400).optional(),
  camera: z.string().max(120).optional(),
  q: z.string().max(200).optional(),
  since: z.number().int().optional(),
  until: z.number().int().optional(),
  category: z.enum(["security", "infra"]).optional(),
  silent: z.boolean().optional(),
});

const BulkBody = z
  .object({
    status: z.enum(["ack", "resolved", "false_positive"]),
    ids: z.array(z.number().int().positive()).min(1).max(1000).optional(),
    filter: FilterBody.optional(),
    dryRun: z.boolean().optional(),
  })
  .refine((b) => (b.ids === undefined) !== (b.filter === undefined), "Indique ids o filter (uno de los dos)");

/** silent=0/1/true/false en la query → boolean (otro valor: sin filtro). */
const boolParam = (v: string | undefined) => (v === "1" || v === "true" ? true : v === "0" || v === "false" ? false : undefined);
const categoryParam = (v: string | undefined) => (v === "security" || v === "infra" ? v : undefined);

const IngestBody = z.object({
  camera: z.string().max(120).optional().describe("id interno (srv:cam), id de cámara exacq o nombre"),
  type: z.enum(EVENT_TYPES).default("external"),
  severity: z.enum(SEVERITIES).optional(),
  title: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  label: z.string().max(60).optional(),
  confidence: z.number().min(0).max(1).optional(),
  snapshot: z.string().max(3_000_000).optional().describe("JPEG en base64"),
  ts: z.number().int().optional(),
  source: z.string().max(40).optional(),
  verify: z.boolean().optional().describe("Pedir verificación con IA"),
});

export function registerEventRoutes(app: FastifyInstance, ctx: AppCtx) {
  const { guard, events, audit, db, cameras } = ctx;

  app.get<{ Querystring: Record<string, string | undefined> }>("/api/events", async (req) => {
    guard(req);
    const q = req.query;
    return events.list({
      status: q.status,
      severity: q.severity,
      type: q.type,
      camera: q.camera,
      q: q.q,
      since: q.since ? Number(q.since) : undefined,
      until: q.until ? Number(q.until) : undefined,
      limit: q.limit ? Number(q.limit) : undefined,
      before: q.before ? Number(q.before) : undefined,
      silent: boolParam(q.silent),
      category: categoryParam(q.category),
    });
  });

  app.get<{ Querystring: { hours?: string } }>("/api/events/stats", async (req) => {
    guard(req);
    return events.stats(Math.min(Math.max(Number(req.query.hours ?? 24), 1), 24 * 30));
  });

  app.get<{ Params: { id: string } }>("/api/events/:id", async (req) => {
    guard(req);
    const ev = events.get(Number(req.params.id));
    if (!ev) throw new HttpError(404, "Evento inexistente", "not_found");
    return { ...ev, notes: events.notes(ev.id) };
  });

  app.get<{ Params: { id: string } }>("/api/events/:id/snapshot", async (req, reply) => {
    guard(req);
    const p = events.snapshotPath(Number(req.params.id));
    if (!p) throw new HttpError(404, "Sin imagen", "not_found");
    reply.header("Cache-Control", "private, max-age=86400").type("image/jpeg");
    return fs.createReadStream(p);
  });

  app.post<{ Params: { id: string } }>("/api/events/:id/status", async (req) => {
    const a = guard(req, { role: "operator" });
    const { status } = StatusBody.parse(req.body);
    const ev = events.setStatus(Number(req.params.id), status, a.user.username);
    if (!ev) throw new HttpError(404, "Evento inexistente", "not_found");
    audit.log({ userId: a.user.id, username: a.user.username, action: "event.status", target: String(ev.id), ip: clientIp(req), details: { status } });
    return ev;
  });

  /** Compatibilidad: reconoce sólo los que siguen "nuevos" (no reabre eventos resueltos entretanto). */
  app.post("/api/events/ack-all", async (req) => {
    const a = guard(req, { role: "operator" });
    const body = z.object({ ids: z.array(z.number().int()).max(500) }).parse(req.body);
    const r = events.bulkStatus({ ids: body.ids, status: "ack", user: a.user.username });
    audit.log({ userId: a.user.id, username: a.user.username, action: "event.bulk_ack", ip: clientIp(req), details: { count: r.count } });
    return { ok: true, count: r.count };
  });

  /** Cambio de estado masivo por selección (ids) o por "todo lo que coincide con el filtro". */
  app.post("/api/events/bulk-status", async (req) => {
    const a = guard(req, { role: "operator" });
    const b = BulkBody.parse(req.body);
    const filter: EventFilter | undefined = b.filter;
    const r = events.bulkStatus({ ids: b.ids, filter, status: b.status, user: a.user.username, dryRun: b.dryRun });
    if (!b.dryRun) {
      audit.log({
        userId: a.user.id,
        username: a.user.username,
        action: "event.bulk_status",
        ip: clientIp(req),
        details: { status: b.status, count: r.count, mode: b.ids ? "ids" : "filter", filter: b.filter },
      });
    }
    return r;
  });

  // ───────── Política de alertas del servidor ─────────
  app.get("/api/alerts/settings", async (req) => {
    guard(req, { role: "tester" });
    return ctx.alertSettings.get();
  });

  app.put("/api/alerts/settings", async (req) => {
    const a = guard(req, { role: "admin" });
    const body = AlertSettingsSchema.partial().strict().parse(req.body);
    const saved = ctx.alertSettings.set(body);
    audit.log({ userId: a.user.id, username: a.user.username, action: "alerts.settings", ip: clientIp(req), details: body });
    return saved;
  });

  app.post<{ Params: { id: string } }>("/api/events/:id/assign", async (req) => {
    const a = guard(req, { role: "operator" });
    const { assignee } = AssignBody.parse(req.body);
    const ev = events.assign(Number(req.params.id), assignee);
    if (!ev) throw new HttpError(404, "Evento inexistente", "not_found");
    audit.log({ userId: a.user.id, username: a.user.username, action: "event.assign", target: String(ev.id), ip: clientIp(req), details: { assignee } });
    return ev;
  });

  app.post<{ Params: { id: string } }>("/api/events/:id/notes", async (req) => {
    const a = guard(req, { role: "operator" });
    const { text } = NoteBody.parse(req.body);
    const id = Number(req.params.id);
    if (!events.row(id)) throw new HttpError(404, "Evento inexistente", "not_found");
    return events.addNote(id, a.user.id, a.user.username, text);
  });

  /** Re-analiza la imagen de un evento con IA (bajo demanda). */
  app.post<{ Params: { id: string } }>("/api/events/:id/analyze", async (req) => {
    const a = guard(req, { role: "operator" });
    const id = Number(req.params.id);
    const row = events.row(id);
    if (!row) throw new HttpError(404, "Evento inexistente", "not_found");
    const p = events.snapshotPath(id);
    if (!p) throw new HttpError(400, "El evento no tiene imagen para analizar");
    if (!ctx.ai.available()) throw new HttpError(400, "IA no configurada", "ai_unavailable");
    const cam = row.camera_id ? cameras.row(row.camera_id) : undefined;
    const ev = await ctx.detection.verify(id, { name: cam?.name ?? "desconocida", zone: cam?.zone ?? null }, fs.readFileSync(p), a.user.id);
    if (!ev) throw new HttpError(429, "Sin presupuesto de IA o el análisis falló; reintente más tarde", "ai_failed");
    audit.log({ userId: a.user.id, username: a.user.username, action: "event.ai_analyze", target: String(id), ip: clientIp(req) });
    return ev;
  });

  // ───────── Ingesta de detecciones externas (Frigate, CodeProject.AI, scripts, otros VMS) ─────────

  const keyFromRequest = (req: FastifyRequest) => {
    const h = req.headers.authorization;
    if (h?.startsWith("Bearer ")) return h.slice(7).trim();
    const x = req.headers["x-api-key"];
    return typeof x === "string" ? x.trim() : undefined;
  };

  app.post("/api/ingest/detections", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } }, bodyLimit: 4 * 1024 * 1024 }, async (req) => {
    if (!ctx.cfg.INGEST_ENABLED) throw new HttpError(404, "Not found");
    const key = keyFromRequest(req);
    if (!key || !key.startsWith("cia_")) throw new HttpError(401, "API key requerida", "unauthenticated");
    const prefix = key.slice(0, 12);
    const row = db.get<{ id: string; key_hash: string; name: string }>("SELECT * FROM ingest_keys WHERE prefix = $p AND revoked = 0", { p: prefix });
    if (!row || !safeEqual(row.key_hash, sha256(key))) {
      audit.log({ action: "ingest.auth", ip: clientIp(req), outcome: "failure", details: { prefix } });
      throw new HttpError(401, "API key inválida", "unauthenticated");
    }
    db.run("UPDATE ingest_keys SET last_used_at = $now WHERE id = $id", { now: Date.now(), id: row.id });
    const b = IngestBody.parse(req.body);
    const camList = cameras.list();
    const cam = b.camera
      ? (camList.find((c) => c.id === b.camera) ??
        camList.find((c) => c.cameraId === b.camera) ??
        camList.find((c) => c.name.toLowerCase() === b.camera!.toLowerCase()))
      : undefined;
    const snapshot = b.snapshot ? Buffer.from(b.snapshot.replace(/^data:image\/\w+;base64,/, ""), "base64") : null;
    if (snapshot && !(snapshot[0] === 0xff && snapshot[1] === 0xd8)) throw new HttpError(400, "snapshot debe ser un JPEG en base64");
    const dedupeSec = ctx.alertSettings.get().ingestDedupeSec;
    const { ev, created } = events.upsert({
      dedupeKey: dedupeSec > 0 ? `ext:${row.name}:${cam?.id ?? b.camera ?? ""}:${b.type}:${b.label ?? ""}` : undefined,
      dedupeWindowMs: dedupeSec * 1000,
      ts: b.ts && Math.abs(b.ts - Date.now()) < 24 * 3600_000 ? b.ts : Date.now(),
      type: b.type,
      severity: b.severity ?? "medium",
      source: `ext:${(b.source ?? row.name).slice(0, 30)}`,
      cameraId: cam?.id ?? null,
      title: b.title,
      description: b.description,
      snapshot,
      meta: { label: b.label, confidence: b.confidence, cameraRef: b.camera, ingestKey: row.name },
    });
    if (created && b.verify && snapshot && ctx.ai.available()) void ctx.detection.verify(ev.id, { name: cam?.name ?? b.camera ?? "externa", zone: cam?.zone ?? null }, snapshot);
    return { ok: true, id: ev.id, deduped: !created };
  });

  app.get("/api/ingest/keys", async (req) => {
    guard(req, { role: "tester" });
    return db.all("SELECT id, name, prefix, created_at AS createdAt, last_used_at AS lastUsedAt, revoked FROM ingest_keys ORDER BY created_at DESC");
  });

  app.post("/api/ingest/keys", async (req) => {
    const a = guard(req, { role: "admin", stepUp: true });
    const { name } = z.object({ name: z.string().min(1).max(60) }).parse(req.body);
    const key = `cia_${crypto.randomBytes(24).toString("base64url")}`;
    const id = crypto.randomUUID();
    db.run("INSERT INTO ingest_keys(id, name, prefix, key_hash, created_at) VALUES($id, $name, $prefix, $hash, $now)", {
      id,
      name,
      prefix: key.slice(0, 12),
      hash: sha256(key),
      now: Date.now(),
    });
    audit.log({ userId: a.user.id, username: a.user.username, action: "ingest.key_create", target: name, ip: clientIp(req) });
    return { id, name, key };
  });

  app.delete<{ Params: { id: string } }>("/api/ingest/keys/:id", async (req) => {
    const a = guard(req, { role: "admin", stepUp: true });
    db.run("UPDATE ingest_keys SET revoked = 1 WHERE id = $id", { id: req.params.id });
    audit.log({ userId: a.user.id, username: a.user.username, action: "ingest.key_revoke", target: req.params.id, ip: clientIp(req) });
    return { ok: true };
  });
}
