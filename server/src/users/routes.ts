import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { AppCtx } from "../context.js";
import { HttpError, clientIp } from "../http/guards.js";
import { checkPasswordPolicy } from "../security/passwords.js";
import { publicUser, type UserRow } from "../auth/service.js";

const RoleEnum = z.enum(["admin", "operator", "viewer"]);
const CreateBody = z.object({
  username: z.string().regex(/^[a-zA-Z0-9._-]{3,32}$/, "Usuario: 3-32 caracteres alfanuméricos, punto, guion o guion bajo"),
  displayName: z.string().max(80).optional(),
  role: RoleEnum,
  password: z.string().min(1).max(256),
});
const PatchBody = z.object({ displayName: z.string().max(80).optional(), role: RoleEnum.optional(), disabled: z.boolean().optional() });
const PasswordBody = z.object({ password: z.string().min(1).max(256) });

export function registerUserRoutes(app: FastifyInstance, ctx: AppCtx) {
  const { db, guard, auth, audit } = ctx;

  const activeAdmins = () => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0")!.n;
  const load = (id: number) => {
    const u = auth.getUser(id);
    if (!u) throw new HttpError(404, "Usuario inexistente", "not_found");
    return u;
  };

  app.get("/api/users", async (req) => {
    guard(req, { role: "admin" });
    return db.all<UserRow>("SELECT * FROM users ORDER BY username").map(publicUser);
  });

  app.post("/api/users", async (req) => {
    const a = guard(req, { role: "admin", stepUp: true });
    const body = CreateBody.parse(req.body);
    const issues = checkPasswordPolicy(body.password, body.username);
    if (issues.length) throw new HttpError(400, issues.join(". "), "weak_password");
    if (auth.getUserByName(body.username)) throw new HttpError(409, "El usuario ya existe", "exists");
    const id = await auth.createUser({ ...body, mustChange: true });
    audit.log({ userId: a.user.id, username: a.user.username, action: "user.create", target: body.username, ip: clientIp(req), details: { role: body.role } });
    return publicUser(load(id));
  });

  app.patch<{ Params: { id: string } }>("/api/users/:id", async (req) => {
    const a = guard(req, { role: "admin", stepUp: true });
    const body = PatchBody.parse(req.body);
    const target = load(Number(req.params.id));
    const demoting = target.role === "admin" && ((body.role && body.role !== "admin") || body.disabled);
    if (demoting && activeAdmins() <= 1) throw new HttpError(400, "No puede quitar el último administrador activo", "last_admin");
    db.run("UPDATE users SET display_name = $d, role = $r, disabled = $dis, updated_at = $now WHERE id = $id", {
      d: body.displayName ?? target.display_name,
      r: body.role ?? target.role,
      dis: body.disabled ?? Boolean(target.disabled),
      now: Date.now(),
      id: target.id,
    });
    if (body.disabled) auth.revokeAllSessions(target.id);
    audit.log({ userId: a.user.id, username: a.user.username, action: "user.update", target: target.username, ip: clientIp(req), details: body });
    return publicUser(load(target.id));
  });

  app.post<{ Params: { id: string } }>("/api/users/:id/password", async (req) => {
    const a = guard(req, { role: "admin", stepUp: true });
    const target = load(Number(req.params.id));
    await auth.adminSetPassword(target.id, PasswordBody.parse(req.body).password);
    audit.log({ userId: a.user.id, username: a.user.username, action: "user.password_reset", target: target.username, ip: clientIp(req) });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/users/:id/reset-2fa", async (req) => {
    const a = guard(req, { role: "admin", stepUp: true });
    const target = load(Number(req.params.id));
    auth.resetTotp(target.id);
    audit.log({ userId: a.user.id, username: a.user.username, action: "user.2fa_reset", target: target.username, ip: clientIp(req) });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/users/:id/unlock", async (req) => {
    const a = guard(req, { role: "admin" });
    const target = load(Number(req.params.id));
    db.run("UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $id", { id: target.id });
    audit.log({ userId: a.user.id, username: a.user.username, action: "user.unlock", target: target.username, ip: clientIp(req) });
    return { ok: true };
  });

  // ───────── Auditoría ─────────
  app.get<{ Querystring: { limit?: string; before?: string; action?: string; username?: string } }>("/api/audit", async (req) => {
    guard(req, { role: "admin" });
    const q = req.query;
    return audit.list({
      limit: q.limit ? Number(q.limit) : undefined,
      before: q.before ? Number(q.before) : undefined,
      action: q.action || undefined,
      username: q.username || undefined,
    });
  });

  app.get("/api/audit/verify", async (req) => {
    guard(req, { role: "admin" });
    return audit.verify();
  });
}
