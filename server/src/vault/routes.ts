import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { AppCtx } from "../context.js";
import { HttpError, clientIp } from "../http/guards.js";
import { SecretSchema, VAULT_KINDS } from "./service.js";

const CreateBody = z.object({
  name: z.string().min(1).max(80),
  kind: z.enum(VAULT_KINDS),
  host: z.string().max(255).optional(),
  notes: z.string().max(1000).optional(),
  secret: SecretSchema,
});
const PatchBody = z.object({
  name: z.string().min(1).max(80).optional(),
  host: z.string().max(255).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  secret: SecretSchema.optional(),
});

export function registerVaultRoutes(app: FastifyInstance, ctx: AppCtx) {
  const { guard, vault, audit, cfg } = ctx;

  app.get("/api/vault", async (req) => {
    guard(req, { role: "tester" });
    return vault.list();
  });

  app.post("/api/vault", async (req) => {
    const a = guard(req, { role: "admin", stepUp: true });
    const body = CreateBody.parse(req.body);
    const id = vault.create(body, a.user.id);
    audit.log({ userId: a.user.id, username: a.user.username, action: "vault.create", target: body.name, ip: clientIp(req), details: { kind: body.kind, id } });
    return vault.meta(id);
  });

  app.patch<{ Params: { id: string } }>("/api/vault/:id", async (req) => {
    const a = guard(req, { role: "admin", stepUp: true });
    const body = PatchBody.parse(req.body);
    if (!vault.update(req.params.id, body)) throw new HttpError(404, "Credencial inexistente", "not_found");
    audit.log({
      userId: a.user.id,
      username: a.user.username,
      action: "vault.update",
      target: req.params.id,
      ip: clientIp(req),
      details: { fields: Object.keys(body.secret ?? {}), meta: Object.keys(body).filter((k) => k !== "secret") },
    });
    return vault.meta(req.params.id);
  });

  app.delete<{ Params: { id: string } }>("/api/vault/:id", async (req) => {
    const a = guard(req, { role: "admin", stepUp: true });
    const meta = vault.meta(req.params.id);
    if (!meta || !vault.delete(req.params.id)) throw new HttpError(404, "Credencial inexistente", "not_found");
    audit.log({ userId: a.user.id, username: a.user.username, action: "vault.delete", target: meta.name, ip: clientIp(req) });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/vault/:id/reveal", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req) => {
    const a = guard(req, { role: "admin", stepUp: true });
    if (!cfg.VAULT_ALLOW_REVEAL) {
      audit.log({ userId: a.user.id, username: a.user.username, action: "vault.reveal", target: req.params.id, ip: clientIp(req), outcome: "denied" });
      throw new HttpError(403, "La visualización de secretos está deshabilitada (VAULT_ALLOW_REVEAL=false)", "reveal_disabled");
    }
    const secret = vault.getSecret(req.params.id);
    if (!secret) throw new HttpError(404, "Credencial inexistente", "not_found");
    audit.log({ userId: a.user.id, username: a.user.username, action: "vault.reveal", target: req.params.id, ip: clientIp(req) });
    return secret;
  });
}
