import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { AuditService } from "../audit/service.js";
import type { VaultService } from "../vault/service.js";
import { randomToken, sha256 } from "../security/crypto.js";
import { checkPasswordPolicy, getDummyHash, hashPassword, verifyPassword } from "../security/passwords.js";
import {
  generateRecoveryCodes,
  generateTotpSecret,
  normalizeRecoveryCode,
  otpauthUri,
  verifyTotp,
} from "../security/totp.js";

export type Role = "admin" | "operator" | "viewer";

export interface UserRow {
  id: number;
  username: string;
  display_name: string | null;
  role: Role;
  password_hash: string;
  totp_secret_enc: string | null;
  totp_enabled: number;
  totp_last_step: number;
  recovery_codes: string;
  must_change_password: number;
  failed_attempts: number;
  locked_until: number | null;
  disabled: number;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
  last_login_ip: string | null;
}

export interface SessionRow {
  id: string;
  user_id: number;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  ip: string | null;
  user_agent: string | null;
  mfa_verified: number;
  step_up_at: number | null;
  revoked: number;
}

export interface AuthContext {
  user: UserRow;
  session: SessionRow;
}

export class AuthError extends Error {
  constructor(
    message: string,
    public status = 401,
    public code = "auth_failed",
  ) {
    super(message);
  }
}

interface PendingMfa {
  userId: number;
  expires: number;
  attempts: number;
  ip: string;
}

export const publicUser = (u: UserRow) => ({
  id: u.id,
  username: u.username,
  displayName: u.display_name ?? u.username,
  role: u.role,
  totpEnabled: Boolean(u.totp_enabled),
  mustChangePassword: Boolean(u.must_change_password),
  disabled: Boolean(u.disabled),
  lockedUntil: u.locked_until,
  lastLoginAt: u.last_login_at,
  lastLoginIp: u.last_login_ip,
  createdAt: u.created_at,
});

export class AuthService {
  private pendingMfa = new Map<string, PendingMfa>();
  private pendingEnroll = new Map<number, { secret: string; expires: number }>();

  constructor(
    private db: Db,
    private cfg: AppConfig,
    private audit: AuditService,
    private vault: VaultService,
  ) {
    setInterval(() => this.sweep(), 60_000).unref();
  }

  private sweep() {
    const now = Date.now();
    for (const [k, v] of this.pendingMfa) if (v.expires < now) this.pendingMfa.delete(k);
    for (const [k, v] of this.pendingEnroll) if (v.expires < now) this.pendingEnroll.delete(k);
    this.db.run("DELETE FROM sessions WHERE expires_at < $now OR revoked = 1", { now: now - 24 * 3600_000 });
  }

  getUser(id: number) {
    return this.db.get<UserRow>("SELECT * FROM users WHERE id = $id", { id });
  }

  getUserByName(username: string) {
    return this.db.get<UserRow>("SELECT * FROM users WHERE username = $username", { username });
  }

  async ensureInitialAdmin(log: (m: string) => void) {
    const count = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users")!.n;
    if (count > 0) return;
    const password = this.cfg.ADMIN_INITIAL_PASSWORD || `${randomToken(12)}!9a`;
    await this.createUser({ username: this.cfg.ADMIN_USERNAME, role: "admin", password, displayName: "Administrador", mustChange: true });
    this.audit.log({ action: "user.bootstrap", target: this.cfg.ADMIN_USERNAME });
    log("════════════════════════════════════════════════════════════");
    log(`  Usuario administrador inicial: ${this.cfg.ADMIN_USERNAME}`);
    if (!this.cfg.ADMIN_INITIAL_PASSWORD) log(`  Contraseña temporal:           ${password}`);
    log("  Se exigirá cambio de contraseña y alta de 2FA en el primer ingreso.");
    log("════════════════════════════════════════════════════════════");
  }

  async createUser(input: { username: string; role: Role; password: string; displayName?: string; mustChange?: boolean }) {
    const now = Date.now();
    const hash = await hashPassword(input.password);
    const res = this.db.run(
      `INSERT INTO users(username, display_name, role, password_hash, must_change_password, created_at, updated_at)
       VALUES($username, $display, $role, $hash, $must, $now, $now)`,
      { username: input.username, display: input.displayName, role: input.role, hash, must: input.mustChange ?? true, now },
    );
    return Number(res.lastInsertRowid);
  }

  // ───────────────────────── Login ─────────────────────────

  /** Paso 1: usuario + contraseña. Devuelve sesión directa o un token intermedio para el 2FA. */
  async login(username: string, password: string, ip: string, userAgent: string) {
    const user = this.getUserByName(username);
    const now = Date.now();
    if (!user) {
      await verifyPassword(password, await getDummyHash());
      this.audit.log({ username, action: "auth.login", ip, outcome: "failure", details: { reason: "unknown_user" } });
      throw new AuthError("Usuario o contraseña incorrectos");
    }
    if (user.disabled) {
      this.audit.log({ userId: user.id, username, action: "auth.login", ip, outcome: "denied", details: { reason: "disabled" } });
      throw new AuthError("Usuario o contraseña incorrectos");
    }
    if (user.locked_until && user.locked_until > now) {
      this.audit.log({ userId: user.id, username, action: "auth.login", ip, outcome: "denied", details: { reason: "locked" } });
      const mins = Math.ceil((user.locked_until - now) / 60_000);
      throw new AuthError(`Cuenta bloqueada temporalmente. Intente en ${mins} min.`, 423, "locked");
    }
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      this.registerFailure(user, ip, "bad_password");
      throw new AuthError("Usuario o contraseña incorrectos");
    }

    if (user.totp_enabled) {
      const mfaToken = randomToken(24);
      this.pendingMfa.set(sha256(mfaToken), { userId: user.id, expires: now + 5 * 60_000, attempts: 0, ip });
      this.audit.log({ userId: user.id, username: user.username, action: "auth.password_ok", ip });
      return { mfaRequired: true as const, mfaToken };
    }

    // Sin 2FA configurado: si la política lo exige, la sesión queda restringida al alta de 2FA.
    this.resetFailures(user, ip);
    const token = this.createSession(user.id, ip, userAgent, false);
    this.audit.log({ userId: user.id, username: user.username, action: "auth.login", ip, details: { mfa: false } });
    return { mfaRequired: false as const, token };
  }

  /** Paso 2: código TOTP o código de recuperación. */
  verifyMfa(mfaToken: string, code: string, ip: string, userAgent: string) {
    const key = sha256(mfaToken);
    const pending = this.pendingMfa.get(key);
    if (!pending || pending.expires < Date.now()) {
      this.pendingMfa.delete(key);
      throw new AuthError("La verificación expiró. Ingrese nuevamente.", 401, "mfa_expired");
    }
    const user = this.getUser(pending.userId);
    if (!user || user.disabled) throw new AuthError("Usuario no disponible");

    const ok = this.checkSecondFactor(user, code);
    if (!ok) {
      pending.attempts += 1;
      if (pending.attempts >= 5) this.pendingMfa.delete(key);
      this.registerFailure(user, ip, "bad_otp");
      throw new AuthError("Código inválido", 401, "mfa_invalid");
    }
    this.pendingMfa.delete(key);
    this.resetFailures(user, ip);
    const token = this.createSession(user.id, ip, userAgent, true);
    this.audit.log({ userId: user.id, username: user.username, action: "auth.login", ip, details: { mfa: ok } });
    return { token };
  }

  /** Valida TOTP (con anti-replay) o consume un código de recuperación. Devuelve el método usado o false. */
  checkSecondFactor(user: UserRow, code: string): "totp" | "recovery" | false {
    if (!user.totp_enabled || !user.totp_secret_enc) return false;
    const secret = this.vault.open(user.totp_secret_enc, `totp:${user.id}`);
    const step = verifyTotp(secret, code, user.totp_last_step);
    if (step !== null) {
      this.db.run("UPDATE users SET totp_last_step = $step WHERE id = $id", { step, id: user.id });
      return "totp";
    }
    const normalized = normalizeRecoveryCode(code);
    if (normalized.length === 12) {
      const hashes: string[] = JSON.parse(user.recovery_codes);
      const h = sha256(normalized);
      const idx = hashes.indexOf(h);
      if (idx >= 0) {
        hashes.splice(idx, 1);
        this.db.run("UPDATE users SET recovery_codes = $codes WHERE id = $id", { codes: JSON.stringify(hashes), id: user.id });
        this.audit.log({ userId: user.id, username: user.username, action: "auth.recovery_code_used", details: { remaining: hashes.length } });
        return "recovery";
      }
    }
    return false;
  }

  private registerFailure(user: UserRow, ip: string, reason: string) {
    const attempts = user.failed_attempts + 1;
    const lock = attempts >= this.cfg.LOGIN_MAX_ATTEMPTS ? Date.now() + this.cfg.LOGIN_LOCK_MINUTES * 60_000 : null;
    this.db.run("UPDATE users SET failed_attempts = $a, locked_until = COALESCE($lock, locked_until) WHERE id = $id", {
      a: lock ? 0 : attempts,
      lock,
      id: user.id,
    });
    this.audit.log({ userId: user.id, username: user.username, action: "auth.login", ip, outcome: "failure", details: { reason, attempts } });
    if (lock) this.audit.log({ userId: user.id, username: user.username, action: "auth.lockout", ip, outcome: "denied", details: { until: lock } });
  }

  private resetFailures(user: UserRow, ip: string) {
    this.db.run("UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = $now, last_login_ip = $ip WHERE id = $id", {
      now: Date.now(),
      ip,
      id: user.id,
    });
  }

  // ───────────────────────── Sesiones ─────────────────────────

  createSession(userId: number, ip: string, userAgent: string, mfaVerified: boolean) {
    const token = randomToken(32);
    const now = Date.now();
    this.db.run(
      `INSERT INTO sessions(id, user_id, created_at, last_seen_at, expires_at, ip, user_agent, mfa_verified, step_up_at)
       VALUES($id, $uid, $now, $now, $exp, $ip, $ua, $mfa, $step)`,
      {
        id: sha256(token),
        uid: userId,
        now,
        exp: now + this.cfg.SESSION_MAX_HOURS * 3600_000,
        ip,
        ua: userAgent.slice(0, 300),
        mfa: mfaVerified,
        step: mfaVerified ? now : null,
      },
    );
    return token;
  }

  /** Resuelve la cookie de sesión; aplica expiración absoluta e inactividad. */
  resolveSession(token: string | undefined): AuthContext | null {
    if (!token) return null;
    const session = this.db.get<SessionRow>("SELECT * FROM sessions WHERE id = $id", { id: sha256(token) });
    if (!session || session.revoked) return null;
    const now = Date.now();
    if (session.expires_at < now || session.last_seen_at + this.cfg.SESSION_IDLE_MINUTES * 60_000 < now) {
      this.db.run("UPDATE sessions SET revoked = 1 WHERE id = $id", { id: session.id });
      return null;
    }
    const user = this.getUser(session.user_id);
    if (!user || user.disabled) return null;
    if (now - session.last_seen_at > 15_000) {
      this.db.run("UPDATE sessions SET last_seen_at = $now WHERE id = $id", { now, id: session.id });
      session.last_seen_at = now;
    }
    return { user, session };
  }

  revokeSession(token: string) {
    this.db.run("UPDATE sessions SET revoked = 1 WHERE id = $id", { id: sha256(token) });
  }

  revokeSessionById(sessionId: string, userId: number) {
    return this.db.run("UPDATE sessions SET revoked = 1 WHERE id = $id AND user_id = $uid", { id: sessionId, uid: userId }).changes > 0;
  }

  revokeAllSessions(userId: number, exceptSessionId?: string) {
    this.db.run("UPDATE sessions SET revoked = 1 WHERE user_id = $uid AND id != $except", { uid: userId, except: exceptSessionId ?? "" });
  }

  listSessions(userId: number) {
    return this.db
      .all<SessionRow>("SELECT * FROM sessions WHERE user_id = $uid AND revoked = 0 AND expires_at > $now ORDER BY last_seen_at DESC", {
        uid: userId,
        now: Date.now(),
      })
      .map((s) => ({ id: s.id, createdAt: s.created_at, lastSeenAt: s.last_seen_at, ip: s.ip, userAgent: s.user_agent, mfa: Boolean(s.mfa_verified) }));
  }

  /** Re-autenticación reciente con 2FA, exigida para acciones sensibles (bóveda, VPN, usuarios). */
  stepUp(ctx: AuthContext, code: string, ip: string) {
    const ok = this.checkSecondFactor(ctx.user, code);
    if (!ok) {
      this.audit.log({ userId: ctx.user.id, username: ctx.user.username, action: "auth.step_up", ip, outcome: "failure" });
      throw new AuthError("Código inválido", 401, "mfa_invalid");
    }
    const now = Date.now();
    this.db.run("UPDATE sessions SET step_up_at = $now, mfa_verified = 1 WHERE id = $id", { now, id: ctx.session.id });
    this.audit.log({ userId: ctx.user.id, username: ctx.user.username, action: "auth.step_up", ip });
    return now + this.cfg.STEP_UP_MINUTES * 60_000;
  }

  /** Alternativa cuando el usuario aún no tiene 2FA (sólo posible si REQUIRE_2FA=false). */
  async stepUpWithPassword(ctx: AuthContext, password: string, ip: string) {
    if (ctx.user.totp_enabled) throw new AuthError("Use su código 2FA", 400, "mfa_required");
    if (!(await verifyPassword(password, ctx.user.password_hash))) {
      this.audit.log({ userId: ctx.user.id, username: ctx.user.username, action: "auth.step_up", ip, outcome: "failure" });
      throw new AuthError("Contraseña incorrecta", 401, "bad_password");
    }
    const now = Date.now();
    this.db.run("UPDATE sessions SET step_up_at = $now WHERE id = $id", { now, id: ctx.session.id });
    this.audit.log({ userId: ctx.user.id, username: ctx.user.username, action: "auth.step_up", ip, details: { method: "password" } });
    return now + this.cfg.STEP_UP_MINUTES * 60_000;
  }

  hasRecentStepUp(ctx: AuthContext) {
    return Boolean(ctx.session.step_up_at && ctx.session.step_up_at + this.cfg.STEP_UP_MINUTES * 60_000 > Date.now());
  }

  // ───────────────────────── 2FA alta/baja ─────────────────────────

  beginTotpEnrollment(user: UserRow) {
    const secret = generateTotpSecret();
    this.pendingEnroll.set(user.id, { secret, expires: Date.now() + 10 * 60_000 });
    return { secret, uri: otpauthUri(secret, user.username) };
  }

  confirmTotpEnrollment(ctx: AuthContext, code: string, ip: string) {
    const pending = this.pendingEnroll.get(ctx.user.id);
    if (!pending || pending.expires < Date.now()) throw new AuthError("La activación expiró, vuelva a empezar", 400, "enroll_expired");
    const step = verifyTotp(pending.secret, code, 0);
    if (step === null) throw new AuthError("Código inválido", 400, "mfa_invalid");
    const codes = generateRecoveryCodes();
    this.db.run(
      `UPDATE users SET totp_secret_enc = $enc, totp_enabled = 1, totp_last_step = $step, recovery_codes = $codes, updated_at = $now WHERE id = $id`,
      {
        enc: this.vault.seal(pending.secret, `totp:${ctx.user.id}`),
        step,
        codes: JSON.stringify(codes.map((c) => sha256(normalizeRecoveryCode(c)))),
        now: Date.now(),
        id: ctx.user.id,
      },
    );
    this.pendingEnroll.delete(ctx.user.id);
    const now = Date.now();
    this.db.run("UPDATE sessions SET mfa_verified = 1, step_up_at = $now WHERE id = $id", { now, id: ctx.session.id });
    this.audit.log({ userId: ctx.user.id, username: ctx.user.username, action: "auth.totp_enabled", ip });
    return codes;
  }

  regenerateRecoveryCodes(ctx: AuthContext, ip: string) {
    const codes = generateRecoveryCodes();
    this.db.run("UPDATE users SET recovery_codes = $codes WHERE id = $id", {
      codes: JSON.stringify(codes.map((c) => sha256(normalizeRecoveryCode(c)))),
      id: ctx.user.id,
    });
    this.audit.log({ userId: ctx.user.id, username: ctx.user.username, action: "auth.recovery_regenerated", ip });
    return codes;
  }

  resetTotp(targetUserId: number) {
    this.db.run(
      "UPDATE users SET totp_secret_enc = NULL, totp_enabled = 0, totp_last_step = 0, recovery_codes = '[]', updated_at = $now WHERE id = $id",
      { now: Date.now(), id: targetUserId },
    );
    this.revokeAllSessions(targetUserId);
  }

  // ───────────────────────── Contraseñas ─────────────────────────

  async changePassword(ctx: AuthContext, current: string, next: string, ip: string) {
    if (!(await verifyPassword(current, ctx.user.password_hash))) {
      this.audit.log({ userId: ctx.user.id, username: ctx.user.username, action: "auth.password_change", ip, outcome: "failure" });
      throw new AuthError("La contraseña actual no es correcta", 400, "bad_password");
    }
    const issues = checkPasswordPolicy(next, ctx.user.username);
    if (issues.length) throw new AuthError(issues.join(". "), 400, "weak_password");
    if (await verifyPassword(next, ctx.user.password_hash)) throw new AuthError("La nueva contraseña debe ser distinta", 400, "weak_password");
    this.db.run("UPDATE users SET password_hash = $h, must_change_password = 0, updated_at = $now WHERE id = $id", {
      h: await hashPassword(next),
      now: Date.now(),
      id: ctx.user.id,
    });
    this.revokeAllSessions(ctx.user.id, ctx.session.id);
    this.audit.log({ userId: ctx.user.id, username: ctx.user.username, action: "auth.password_change", ip });
  }

  async adminSetPassword(targetId: number, password: string) {
    const target = this.getUser(targetId);
    if (!target) throw new AuthError("Usuario inexistente", 404, "not_found");
    const issues = checkPasswordPolicy(password, target.username);
    if (issues.length) throw new AuthError(issues.join(". "), 400, "weak_password");
    this.db.run("UPDATE users SET password_hash = $h, must_change_password = 1, failed_attempts = 0, locked_until = NULL, updated_at = $now WHERE id = $id", {
      h: await hashPassword(password),
      now: Date.now(),
      id: targetId,
    });
    this.revokeAllSessions(targetId);
  }

  /** Estado de "restricciones" que el frontend usa para forzar cambio de clave / alta de 2FA. */
  restrictions(ctx: AuthContext) {
    return {
      mustChangePassword: Boolean(ctx.user.must_change_password),
      mustEnrollTotp: this.cfg.REQUIRE_2FA && !ctx.user.totp_enabled,
    };
  }
}
