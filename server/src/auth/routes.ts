import QRCode from "qrcode";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { AppCtx } from "../context.js";
import { HttpError, clearSessionCookie, clientIp, sessionCookieName, setSessionCookie } from "../http/guards.js";
import { publicUser } from "./service.js";

const LoginBody = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) });
const MfaBody = z.object({ mfaToken: z.string().min(10).max(128), code: z.string().min(6).max(20) });
const CodeBody = z.object({ code: z.string().min(6).max(20) });
const StepUpBody = z.object({ code: z.string().min(6).max(20).optional(), password: z.string().max(256).optional() });
const PasswordBody = z.object({ current: z.string().min(1).max(256), next: z.string().min(1).max(256) });

const authLimit = { rateLimit: { max: 10, timeWindow: "1 minute" } };

export function registerAuthRoutes(app: FastifyInstance, ctx: AppCtx) {
  const { auth, guard, cfg } = ctx;

  const mePayload = (a: ReturnType<typeof guard>) => ({
    user: publicUser(a.user),
    restrictions: auth.restrictions(a),
    stepUpUntil: a.session.step_up_at ? a.session.step_up_at + cfg.STEP_UP_MINUTES * 60_000 : null,
    recoveryCodesLeft: (JSON.parse(a.user.recovery_codes) as string[]).length,
  });

  app.post("/api/auth/login", { config: authLimit }, async (req, reply) => {
    const body = LoginBody.parse(req.body);
    const res = await auth.login(body.username, body.password, clientIp(req), req.headers["user-agent"] ?? "");
    if (res.mfaRequired) return { mfaRequired: true, mfaToken: res.mfaToken };
    setSessionCookie(reply, cfg, res.token);
    const a = auth.resolveSession(res.token)!;
    return { mfaRequired: false, ...mePayload(a) };
  });

  app.post("/api/auth/mfa", { config: authLimit }, async (req, reply) => {
    const body = MfaBody.parse(req.body);
    const { token } = auth.verifyMfa(body.mfaToken, body.code, clientIp(req), req.headers["user-agent"] ?? "");
    setSessionCookie(reply, cfg, token);
    return mePayload(auth.resolveSession(token)!);
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies[sessionCookieName(cfg)];
    if (token) {
      const a = auth.resolveSession(token);
      auth.revokeSession(token);
      if (a) ctx.audit.log({ userId: a.user.id, username: a.user.username, action: "auth.logout", ip: clientIp(req) });
    }
    clearSessionCookie(reply, cfg);
    return { ok: true };
  });

  app.get("/api/auth/me", async (req) => mePayload(guard(req, { allowRestricted: true })));

  app.post("/api/auth/password", { config: authLimit }, async (req) => {
    const a = guard(req, { allowRestricted: true });
    const body = PasswordBody.parse(req.body);
    await auth.changePassword(a, body.current, body.next, clientIp(req));
    return { ok: true };
  });

  app.post("/api/auth/totp/begin", async (req) => {
    // Re-enrolar un 2FA existente exige confirmar con el 2FA actual.
    const a = guard(req, { allowRestricted: true, stepUp: false });
    if (a.user.totp_enabled && !auth.hasRecentStepUp(a)) {
      throw new HttpError(403, "Confirme su identidad con 2FA para continuar", "step_up_required");
    }
    const { secret, uri } = auth.beginTotpEnrollment(a.user);
    const qr = await QRCode.toDataURL(uri, { margin: 1, width: 240, color: { dark: "#050a14", light: "#e6fbff" } });
    return { secret, uri, qr };
  });

  app.post("/api/auth/totp/confirm", { config: authLimit }, async (req) => {
    const a = guard(req, { allowRestricted: true });
    const { code } = CodeBody.parse(req.body);
    const recoveryCodes = auth.confirmTotpEnrollment(a, code, clientIp(req));
    return { recoveryCodes };
  });

  app.post("/api/auth/recovery-codes", async (req) => {
    const a = guard(req, { stepUp: true });
    return { recoveryCodes: auth.regenerateRecoveryCodes(a, clientIp(req)) };
  });

  app.post("/api/auth/step-up", { config: authLimit }, async (req) => {
    const a = guard(req, { allowRestricted: true });
    const body = StepUpBody.parse(req.body);
    const until = body.code
      ? auth.stepUp(a, body.code, clientIp(req))
      : await auth.stepUpWithPassword(a, body.password ?? "", clientIp(req));
    return { stepUpUntil: until };
  });

  app.get("/api/auth/sessions", async (req) => {
    const a = guard(req);
    return auth.listSessions(a.user.id).map((s) => ({ ...s, current: s.id === a.session.id }));
  });

  app.delete<{ Params: { id: string } }>("/api/auth/sessions/:id", async (req) => {
    const a = guard(req);
    const ok = auth.revokeSessionById(req.params.id, a.user.id);
    if (ok) ctx.audit.log({ userId: a.user.id, username: a.user.username, action: "auth.session_revoked", ip: clientIp(req) });
    return { ok };
  });
}
