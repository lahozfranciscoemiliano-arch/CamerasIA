import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthContext, AuthService, Role } from "../auth/service.js";
import type { AppConfig } from "../config.js";

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "error",
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const sessionCookieName = (cfg: AppConfig) => (cfg.cookieSecure ? "__Host-cia_session" : "cia_session");

export function setSessionCookie(reply: FastifyReply, cfg: AppConfig, token: string) {
  reply.setCookie(sessionCookieName(cfg), token, {
    httpOnly: true,
    secure: cfg.cookieSecure,
    sameSite: "strict",
    path: "/",
    maxAge: cfg.SESSION_MAX_HOURS * 3600,
  });
}

export function clearSessionCookie(reply: FastifyReply, cfg: AppConfig) {
  reply.clearCookie(sessionCookieName(cfg), { path: "/", secure: cfg.cookieSecure, sameSite: "strict", httpOnly: true });
}

const RANK: Record<Role, number> = { viewer: 1, tester: 1, operator: 2, admin: 3 };

const hasRole = (actual: Role, required: Role) => {
  if (required === "tester") return actual === "tester" || actual === "admin";
  return (RANK[actual] ?? 0) >= (RANK[required] ?? Infinity);
};

export interface GuardOptions {
  /** Rol mínimo; tester permite diagnósticos a Tester y Administrador. */
  role?: Role;
  /** Admite también Tester en consultas que ya permiten Operador. */
  allowTester?: boolean;
  /** Exige re-autenticación 2FA reciente (acciones sensibles). */
  stepUp?: boolean;
  /** Permite el acceso aunque la sesión tenga pendiente el cambio de clave o el alta de 2FA. */
  allowRestricted?: boolean;
}

export function makeGuard(auth: AuthService, cfg: AppConfig) {
  return function guard(req: FastifyRequest, opts: GuardOptions = {}): AuthContext {
    const token = req.cookies[sessionCookieName(cfg)];
    const ctx = auth.resolveSession(token);
    if (!ctx) throw new HttpError(401, "Sesión no válida o expirada", "unauthenticated");
    req.auth = ctx;
    if (!opts.allowRestricted) {
      const r = auth.restrictions(ctx);
      if (r.mustChangePassword) throw new HttpError(403, "Debe cambiar su contraseña", "must_change_password");
      if (r.mustEnrollTotp) throw new HttpError(403, "Debe activar la verificación en dos pasos (2FA)", "must_enroll_totp");
    }
    if (opts.role && !hasRole(ctx.user.role, opts.role) && !(opts.allowTester && ctx.user.role === "tester")) {
      throw new HttpError(403, "Permisos insuficientes", "forbidden");
    }
    if (opts.stepUp && !auth.hasRecentStepUp(ctx)) {
      throw new HttpError(403, "Confirme su identidad con 2FA para continuar", "step_up_required");
    }
    return ctx;
  };
}

export type Guard = ReturnType<typeof makeGuard>;

export const clientIp = (req: FastifyRequest) => req.ip;
