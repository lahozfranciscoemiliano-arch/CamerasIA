import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export type Row = Record<string, unknown>;
type Params = Record<string, SQLInputValue | undefined | boolean>;

type Migration = { sql: string; rebuildTables?: boolean };

const MIGRATIONS: Migration[] = [
  // 1 — esquema inicial
  { sql: `
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
  ` },
  // 2 — rol Tester, conservando las cuentas y sus sesiones existentes.
  { rebuildTables: true, sql: `
  CREATE TABLE users_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT,
    role TEXT NOT NULL CHECK (role IN ('admin','operator','viewer','tester')),
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
  INSERT INTO users_new (
    id, username, display_name, role, password_hash, totp_secret_enc,
    totp_enabled, totp_last_step, recovery_codes, must_change_password,
    failed_attempts, locked_until, disabled, created_at, updated_at,
    last_login_at, last_login_ip
  ) SELECT
    id, username, display_name, role, password_hash, totp_secret_enc,
    totp_enabled, totp_last_step, recovery_codes, must_change_password,
    failed_attempts, locked_until, disabled, created_at, updated_at,
    last_login_at, last_login_ip
  FROM users;
  -- INSERT conserva los IDs actuales; sqlite_sequence también debe conservar
  -- el máximo histórico para no reutilizar el ID de una cuenta eliminada.
  UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE(
    (SELECT seq FROM sqlite_sequence WHERE name = 'users'), 0
  )) WHERE name = 'users_new';
  INSERT INTO sqlite_sequence(name, seq)
    SELECT 'users_new', seq FROM sqlite_sequence
    WHERE name = 'users'
      AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'users_new');
  DROP TABLE users;
  ALTER TABLE users_new RENAME TO users;
  ` },
  // 3 — alertas: deduplicación, notificación, silencio por cámara y estado en el VMS.
  { sql: `
  ALTER TABLE events ADD COLUMN dedupe_key TEXT;
  ALTER TABLE events ADD COLUMN occurrences INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE events ADD COLUMN last_ts INTEGER;
  ALTER TABLE events ADD COLUMN notified_at INTEGER;
  ALTER TABLE events ADD COLUMN silent INTEGER NOT NULL DEFAULT 0;
  -- Lo histórico no se vuelve a notificar.
  UPDATE events SET last_ts = ts, notified_at = ts;
  UPDATE events SET dedupe_key = 'camera_offline:' || camera_id
    WHERE type = 'camera_offline' AND camera_id IS NOT NULL AND status IN ('new','ack','investigating');
  UPDATE events SET dedupe_key = 'host_down:' || json_extract(meta, '$.hostId')
    WHERE type = 'host_down' AND status IN ('new','ack','investigating')
      AND CASE WHEN json_valid(meta) THEN json_extract(meta, '$.hostId') IS NOT NULL ELSE 0 END;
  UPDATE events SET dedupe_key = 'vpn_down' WHERE type = 'vpn_down' AND severity != 'info' AND status IN ('new','ack','investigating');
  CREATE INDEX events_dedupe_open ON events(dedupe_key)
    WHERE dedupe_key IS NOT NULL AND status IN ('new','ack','investigating');

  ALTER TABLE cameras ADD COLUMN vms_disabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE cameras ADD COLUMN alerts_muted_until INTEGER;
  ALTER TABLE cameras ADD COLUMN offline_since INTEGER;
  ALTER TABLE cameras ADD COLUMN offline_event_id INTEGER;
  -- raw se guarda truncado a 20 000 caracteres: json_valid evita que json_extract aborte la migración.
  UPDATE cameras SET vms_disabled = 1
    WHERE CASE WHEN json_valid(raw)
               THEN (json_extract(raw, '$.disabled') IN (1, '1', 'true') OR json_extract(raw, '$.enabled') = 0)
               ELSE 0 END;
  UPDATE cameras SET offline_event_id = (
      SELECT MAX(e.id) FROM events e
      WHERE e.dedupe_key = 'camera_offline:' || cameras.id AND e.status IN ('new','ack','investigating'))
    WHERE online = 0 AND vms_disabled = 0;
  -- Las deshabilitadas en exacqVision nunca debieron alertar (sin tocar ack_* para no falsear el MTTA).
  UPDATE events SET status = 'resolved', resolved_by = 'sistema',
         resolved_at = CAST(strftime('%s','now') AS INTEGER) * 1000
    WHERE type = 'camera_offline' AND status IN ('new','ack','investigating')
      AND camera_id IN (SELECT id FROM cameras WHERE vms_disabled = 1);
  UPDATE cameras SET online = 0, offline_event_id = NULL WHERE vms_disabled = 1;
  -- Caídas de cámaras que ya están en línea quedaron abiertas: se cierran.
  UPDATE events SET status = 'resolved', resolved_by = 'sistema',
         resolved_at = CAST(strftime('%s','now') AS INTEGER) * 1000
    WHERE type = 'camera_offline' AND status IN ('new','ack','investigating')
      AND camera_id IN (SELECT id FROM cameras WHERE online = 1);
  -- Las recuperaciones informativas (y los cierres manuales de la VPN) ya no quedan abiertas: inflaban el contador.
  UPDATE events SET status = 'resolved', resolved_by = 'sistema', resolved_at = ts, silent = 1
    WHERE (type IN ('camera_online','host_up','vpn_up') OR (type = 'vpn_down' AND severity = 'info')) AND status = 'new';
  ` },
];

/** Versión de esquema que deja aplicada la última migración. */
export const SCHEMA_VERSION = MIGRATIONS.length;

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
    try {
      this.migrate();
    } catch (err) {
      this.raw.close();
      throw err;
    }
  }

  private migrate() {
    this.raw.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    const row = this.raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
    let version = row?.value ? Number(row.value) : 0;
    while (version < MIGRATIONS.length) {
      const migration = MIGRATIONS[version]!;
      // SQLite no permite cambiar foreign_keys dentro de una transacción.
      // Dejarlo activo durante DROP users eliminaría sus sesiones en cascada.
      if (migration.rebuildTables) this.raw.exec("PRAGMA foreign_keys = OFF");
      try {
        this.tx(() => {
          this.raw.exec(migration.sql);
          if (migration.rebuildTables && this.raw.prepare("PRAGMA foreign_key_check").all().length) {
            throw new Error(`La migración ${version + 1} dejaría referencias inválidas en la base de datos`);
          }
          this.raw
            .prepare("INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .run(String(version + 1));
        });
        version += 1;
      } finally {
        if (migration.rebuildTables) this.raw.exec("PRAGMA foreign_keys = ON");
      }
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
