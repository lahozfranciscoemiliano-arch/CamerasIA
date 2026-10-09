import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export type Row = Record<string, unknown>;
type Params = Record<string, SQLInputValue | undefined | boolean>;

const MIGRATIONS: string[] = [
  // 1 — esquema inicial
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT,
    role TEXT NOT NULL CHECK (role IN ('admin','operator','viewer')),
    password_hash TEXT NOT NULL,
    totp_secret_enc TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    totp_last_step INTEGER NOT NULL DEFAULT 0,
    recovery_codes TEXT NOT NULL DEFAULT '[]',
    must_change_password INTEGER NOT NULL DEFAULT 0,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_login_at INTEGER,
    last_login_ip TEXT
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip TEXT,
    user_agent TEXT,
    mfa_verified INTEGER NOT NULL DEFAULT 0,
    step_up_at INTEGER,
    revoked INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    user_id INTEGER,
    username TEXT,
    action TEXT NOT NULL,
    target TEXT,
    ip TEXT,
    outcome TEXT NOT NULL,
    details TEXT,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL
  );
  CREATE INDEX audit_ts ON audit_log(ts DESC);

  CREATE TABLE vault_entries (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    host TEXT,
    notes TEXT,
    payload_enc TEXT NOT NULL,
    key_version INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used_at INTEGER
  );

  CREATE TABLE vpn_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 443,
    realm TEXT,
    trusted_certs TEXT NOT NULL DEFAULT '[]',
    set_routes INTEGER NOT NULL DEFAULT 1,
    set_dns INTEGER NOT NULL DEFAULT 0,
    half_internet_routes INTEGER NOT NULL DEFAULT 0,
    otp_required INTEGER NOT NULL DEFAULT 0,
    credential_id TEXT REFERENCES vault_entries(id) ON DELETE SET NULL,
    auto_connect INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE exacq_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    credential_id TEXT REFERENCES vault_entries(id) ON DELETE SET NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    snapshot_template TEXT,
    live_template TEXT,
    vpn_profile_id TEXT REFERENCES vpn_profiles(id) ON DELETE SET NULL,
    timezone TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_ok_at INTEGER,
    last_error TEXT
  );

  CREATE TABLE cameras (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    camera_id TEXT NOT NULL,
    name TEXT NOT NULL,
    zone TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    motion_enabled INTEGER NOT NULL DEFAULT 0,
    ai_verify INTEGER NOT NULL DEFAULT 0,
    sensitivity INTEGER NOT NULL DEFAULT 50,
    raw TEXT,
    online INTEGER NOT NULL DEFAULT 0,
    last_seen_at INTEGER,
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX cameras_server ON cameras(server_id);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    type TEXT NOT NULL,
    severity TEXT NOT NULL,
    source TEXT NOT NULL,
    camera_id TEXT,
    title TEXT NOT NULL,
    description TEXT,
    snapshot TEXT,
    ai TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    assigned_to TEXT,
    ack_by TEXT,
    ack_at INTEGER,
    resolved_by TEXT,
    resolved_at INTEGER,
    meta TEXT
  );
  CREATE INDEX events_ts ON events(ts DESC);
  CREATE INDEX events_status ON events(status);
  CREATE INDEX events_camera ON events(camera_id, ts DESC);

  CREATE TABLE event_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id INTEGER,
    username TEXT,
    ts INTEGER NOT NULL,
    text TEXT NOT NULL
  );

  CREATE TABLE monitored_hosts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'other',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_status TEXT,
    last_latency_ms INTEGER,
    last_checked_at INTEGER,
    last_change_at INTEGER
  );

  CREATE TABLE host_checks (
    host_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    latency_ms INTEGER
  );
  CREATE INDEX host_checks_host_ts ON host_checks(host_id, ts DESC);

  CREATE TABLE ai_conversations (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    messages TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE ai_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    feature TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    user_id INTEGER
  );
  CREATE INDEX ai_usage_ts ON ai_usage(ts DESC);

  CREATE TABLE ingest_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

function clean(params?: Params): Record<string, SQLInputValue> | undefined {
  if (!params) return undefined;
  const out: Record<string, SQLInputValue> = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] = v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v;
  }
  return out;
}

export class Db {
  readonly raw: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate() {
    this.raw.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    const row = this.raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
    let version = row?.value ? Number(row.value) : 0;
    while (version < MIGRATIONS.length) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[version]!);
        version += 1;
        this.raw
          .prepare("INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run(String(version));
      });
    }
  }

  get<T = Row>(sql: string, params?: Params): T | undefined {
    const stmt = this.raw.prepare(sql);
    return (params ? stmt.get(clean(params)!) : stmt.get()) as T | undefined;
  }

  all<T = Row>(sql: string, params?: Params): T[] {
    const stmt = this.raw.prepare(sql);
    return (params ? stmt.all(clean(params)!) : stmt.all()) as T[];
  }

  run(sql: string, params?: Params) {
    const stmt = this.raw.prepare(sql);
    return params ? stmt.run(clean(params)!) : stmt.run();
  }

  tx<T>(fn: () => T): T {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.raw.exec("COMMIT");
      return out;
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    }
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.get<{ value: string }>("SELECT value FROM settings WHERE key = $key", { key });
    if (!row) return fallback;
    try {
      return { ...fallback, ...JSON.parse(row.value) } as T;
    } catch {
      return fallback;
    }
  }

  setSetting(key: string, value: unknown) {
    this.run(
      "INSERT INTO settings(key, value) VALUES($key, $value) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      { key, value: JSON.stringify(value) },
    );
  }

  close() {
    this.raw.close();
  }
}
