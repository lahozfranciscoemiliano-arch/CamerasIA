import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppCtx } from "../context.js";
import { HttpError, clientIp } from "../http/guards.js";
import { Assistant } from "./assistant.js";
import { AiUnavailableError } from "./service.js";

const ChatBody = z.object({ conversationId: z.string().uuid().optional(), message: z.string().min(1).max(4000) });
const ReportBody = z.object({ hours: z.number().int().min(1).max(72), notes: z.string().max(2000).optional() });
const AnalyzeBody = z.object({ camera: z.string().min(1) });
const SettingsBody = z.object({
  siteContext: z.string().max(2000).optional(),
  businessHours: z.string().max(200).optional(),
  autoVerify: z.boolean().optional(),
});

/** Abre un canal Server-Sent Events sobre la respuesta (para streaming de texto de la IA). */
function openSse(reply: FastifyReply) {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const ac = new AbortController();
  reply.raw.on("close", () => {
    if (!reply.raw.writableFinished) ac.abort();
  });
  const send = (event: string, data: unknown) => {
    if (!reply.raw.writableEnded) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const ping = setInterval(() => reply.raw.write(": ping\n\n"), 15_000);
  const end = () => {
    clearInterval(ping);
    if (!reply.raw.writableEnded) reply.raw.end();
  };
  return { send, end, signal: ac.signal };
}

function friendlyError(e: unknown) {
  if (e instanceof AiUnavailableError) return e.message;
  if (e instanceof Anthropic.AuthenticationError) return "La API key de Anthropic es inválida o fue revocada";
  if (e instanceof Anthropic.RateLimitError) return "Límite de uso de la API de IA alcanzado; reintente en unos minutos";
  if (e instanceof Anthropic.APIConnectionError) return "No se pudo conectar con la API de IA (¿salida a internet bloqueada?)";
  if (e instanceof Anthropic.APIError) return `Error de la API de IA (${e.status ?? "?"}): ${e.message}`;
  return (e as Error).message;
}

export function registerAiRoutes(app: FastifyInstance, ctx: AppCtx) {
  const { guard, ai, audit, cameras, events, detection } = ctx;
  const assistant = new Assistant({ db: ctx.db, ai, cameras, events, vpn: ctx.vpn, health: ctx.health });

  app.get("/api/ai/status", async (req) => {
    guard(req);
    return { available: ai.available(), model: ai.model, settings: ai.settings(), budget: ai.budget(), engine: detection.stats };
  });

  app.put("/api/ai/settings", async (req) => {
    const a = guard(req, { role: "admin" });
    const body = SettingsBody.parse(req.body);
    ai.saveSettings(body);
    audit.log({ userId: a.user.id, username: a.user.username, action: "ai.settings", ip: clientIp(req), details: { fields: Object.keys(body) } });
    return ai.settings();
  });

  app.get<{ Querystring: { days?: string } }>("/api/ai/usage", async (req) => {
    guard(req, { role: "operator" });
    return ai.usageSummary(Math.min(Math.max(Number(req.query.days ?? 7), 1), 90));
  });

  /** "Analizar ahora": toma el cuadro en vivo y lo analiza con Claude visión. */
  app.post("/api/ai/analyze-camera", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const a = guard(req, { role: "operator" });
    const { camera } = AnalyzeBody.parse(req.body);
    const row = cameras.row(camera);
    if (!row) throw new HttpError(404, "Cámara inexistente", "not_found");
    if (!ai.available()) throw new HttpError(400, "IA no configurada: cargue la API key de Anthropic en la bóveda", "ai_unavailable");
    if (!ai.takeAnalysisBudget()) throw new HttpError(429, "Se alcanzó el límite horario de análisis IA", "ai_budget");
    const snap = await cameras.snapshot(camera, 1000).catch((e) => {
      throw new HttpError(502, (e as Error).message, "snapshot_failed");
    });
    try {
      const result = await ai.analyzeImage(snap.data, { cameraName: row.name, zone: row.zone, reason: `Análisis manual solicitado por ${a.user.username}` }, a.user.id);
      let eventId: number | null = null;
      if (["medium", "high", "critical"].includes(result.threat_level)) {
        const ev = events.create({
          type: result.event_type === "none" ? "ai_alert" : result.event_type,
          severity: result.threat_level as "medium" | "high" | "critical",
          source: "ia",
          cameraId: row.id,
          title: `IA · ${row.name}: ${result.summary}`.slice(0, 200),
          description: result.recommended_action,
          snapshot: snap.data,
          ai: { ...result, model: ai.model, analyzedAt: Date.now() },
        });
        eventId = ev.id;
      }
      audit.log({ userId: a.user.id, username: a.user.username, action: "ai.analyze_camera", target: row.id, ip: clientIp(req), details: { threat: result.threat_level } });
      return { result, eventId, capturedAt: snap.ts };
    } catch (e) {
      throw new HttpError(502, friendlyError(e), "ai_failed");
    }
  });

  app.get("/api/ai/conversations", async (req) => {
    const a = guard(req, { role: "operator" });
    return assistant.listConversations(a.user.id);
  });

  app.get<{ Params: { id: string } }>("/api/ai/conversations/:id", async (req) => {
    const a = guard(req, { role: "operator" });
    const conv = assistant.getConversation(a.user.id, req.params.id);
    if (!conv) throw new HttpError(404, "Conversación inexistente", "not_found");
    return { id: conv.id, title: conv.title, updatedAt: conv.updated_at, messages: Assistant.displayMessages(conv.messages) };
  });

  app.delete<{ Params: { id: string } }>("/api/ai/conversations/:id", async (req) => {
    const a = guard(req, { role: "operator" });
    return { ok: assistant.deleteConversation(a.user.id, req.params.id) };
  });

  app.post("/api/ai/chat", { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } }, async (req, reply) => {
    const a = guard(req, { role: "operator" });
    const body = ChatBody.parse(req.body);
    if (!ai.available()) throw new HttpError(400, "IA no configurada: cargue la API key de Anthropic en la bóveda", "ai_unavailable");
    const sse = openSse(reply);
    try {
      const res = await assistant.chat({
        userId: a.user.id,
        conversationId: body.conversationId,
        message: body.message,
        signal: sse.signal,
        emit: (event, data) => sse.send(event, data),
      });
      audit.log({ userId: a.user.id, username: a.user.username, action: "ai.chat", target: res.conversationId, ip: clientIp(req), details: res.usage });
      sse.send("done", res);
    } catch (e) {
      if (!sse.signal.aborted) sse.send("error", { message: friendlyError(e) });
    } finally {
      sse.end();
    }
  });

  app.post("/api/ai/report", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req, reply) => {
    const a = guard(req, { role: "operator" });
    const body = ReportBody.parse(req.body);
    if (!ai.available()) throw new HttpError(400, "IA no configurada: cargue la API key de Anthropic en la bóveda", "ai_unavailable");
    const sse = openSse(reply);
    try {
      await assistant.shiftReport({ hours: body.hours, notes: body.notes, userId: a.user.id, signal: sse.signal, emit: (d) => sse.send("text", d) });
      audit.log({ userId: a.user.id, username: a.user.username, action: "ai.report", ip: clientIp(req), details: { hours: body.hours } });
      sse.send("done", {});
    } catch (e) {
      if (!sse.signal.aborted) sse.send("error", { message: friendlyError(e) });
    } finally {
      sse.end();
    }
  });
}
