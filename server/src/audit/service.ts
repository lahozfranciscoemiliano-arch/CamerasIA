import type { Db } from "../db/index.js";
import { sha256 } from "../security/crypto.js";

export interface AuditEntry {
  userId?: number | null;
  username?: string | null;
  action: string;
  target?: string | null;
  ip?: string | null;
  outcome?: "success" | "failure" | "denied";
  details?: Record<string, unknown>;
}

interface AuditRow {
  id: number;
  ts: number;
  user_id: number | null;
  username: string | null;
  action: string;
  target: string | null;
  ip: string | null;
  outcome: string;
  details: string | null;
  prev_hash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

function rowHash(r: Omit<AuditRow, "id" | "hash">): string {
  return sha256(
    JSON.stringify([r.ts, r.user_id, r.username, r.action, r.target, r.ip, r.outcome, r.details, r.prev_hash]),
  );
}

/**
 * Bitácora de auditoría a prueba de manipulación: cada registro incluye el hash del anterior
 * (cadena tipo blockchain). Si alguien edita o borra una fila en la base, verify() lo detecta.
 */
export class AuditService {
  constructor(private db: Db) {}

  log(e: AuditEntry) {
    this.db.tx(() => {
      const last = this.db.get<{ hash: string }>("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1");
      const base = {
        ts: Date.now(),
        user_id: e.userId ?? null,
        username: e.username ?? null,
        action: e.action,
        target: e.target ?? null,
        ip: e.ip ?? null,
        outcome: e.outcome ?? "success",
        details: e.details ? JSON.stringify(e.details) : null,
        prev_hash: last?.hash ?? GENESIS,
      };
      this.db.run(
        `INSERT INTO audit_log(ts, user_id, username, action, target, ip, outcome, details, prev_hash, hash)
         VALUES($ts, $user_id, $username, $action, $target, $ip, $outcome, $details, $prev_hash, $hash)`,
        { ...base, hash: rowHash(base) },
      );
    });
  }

  list(opts: { limit?: number; before?: number; action?: string; username?: string }) {
    const where: string[] = [];
    const params: Record<string, string | number> = { limit: Math.min(opts.limit ?? 100, 500) };
    if (opts.before) {
      where.push("id < $before");
      params.before = opts.before;
    }
    if (opts.action) {
      where.push("action LIKE $action");
      params.action = `${opts.action}%`;
    }
    if (opts.username) {
      where.push("username = $username");
      params.username = opts.username;
    }
    const rows = this.db.all<AuditRow>(
      `SELECT * FROM audit_log ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT $limit`,
      params,
    );
    return rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
  }

  verify(): { ok: boolean; checked: number; brokenAt?: number } {
    let prev = GENESIS;
    let checked = 0;
    for (const r of this.db.raw.prepare("SELECT * FROM audit_log ORDER BY id ASC").iterate() as Iterable<AuditRow>) {
      const { id, hash, ...rest } = r;
      if (rest.prev_hash !== prev || rowHash(rest) !== hash) return { ok: false, checked, brokenAt: id };
      prev = hash;
      checked++;
    }
    return { ok: true, checked };
  }
}
