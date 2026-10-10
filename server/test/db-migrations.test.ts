import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Db, SCHEMA_VERSION } from "../src/db/index.js";

// Fixture del esquema que ya existe en las VPS, antes del rol Tester.
const LEGACY_SCHEMA = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  INSERT INTO meta VALUES ('schema_version', '1');
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
  CREATE TABLE audit_log (id INTEGER PRIMARY KEY, user_id INTEGER, action TEXT);
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
  CREATE TABLE event_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id INTEGER,
    username TEXT,
    ts INTEGER NOT NULL,
    text TEXT NOT NULL
  );
`;

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "camerasia-migration-"));
  const file = path.join(dir, "data.sqlite");
  const raw = new DatabaseSync(file);
  raw.exec(LEGACY_SCHEMA);
  return { file, dir, raw };
}

function plain(rows: Record<string, unknown>[]) {
  return rows.map((row) => ({ ...row }));
}

function closeFixture(raw: DatabaseSync) {
  try { raw.close(); } catch { /* Ya se cerró antes de abrir la base migrada. */ }
}

test("migración Tester conserva cuentas, MFA, sesiones y el máximo histórico de IDs", () => {
  const { file, dir, raw } = fixture();
  let db: Db | undefined;
  try {
    raw.exec(`
      INSERT INTO users VALUES
        (7, 'Admin', 'Administración', 'admin', 'hash-admin', 'enc-admin', 1, 123,
          '["recovery-hash"]', 0, 2, 456, 0, 100, 200, 300, '192.0.2.7'),
        (19, 'Operador', NULL, 'operator', 'hash-operator', NULL, 0, 0,
          '[]', 1, 0, NULL, 1, 101, 201, NULL, NULL),
        (42, 'Visor', 'Consulta', 'viewer', 'hash-viewer', 'enc-viewer', 1, 124,
          '["otro-hash"]', 0, 3, 457, 0, 102, 202, 302, '192.0.2.42'),
        (1000, 'Eliminado', NULL, 'viewer', 'hash-old', NULL, 0, 0,
          '[]', 0, 0, NULL, 0, 103, 203, NULL, NULL);
      DELETE FROM users WHERE id = 1000;
      INSERT INTO sessions VALUES
        ('admin-session', 7, 10, 20, 900, '192.0.2.7', 'fixture-admin', 1, 30, 0),
        ('viewer-session', 42, 11, 21, 901, '192.0.2.42', 'fixture-viewer', 1, 31, 1);
      INSERT INTO audit_log VALUES (1, 1000, 'account.deleted');
    `);
    const users = plain(raw.prepare("SELECT * FROM users ORDER BY id").all());
    const sessions = plain(raw.prepare("SELECT * FROM sessions ORDER BY id").all());
    raw.close();

    db = new Db(file);
    assert.deepEqual(plain(db.all("SELECT * FROM users ORDER BY id")), users);
    assert.deepEqual(plain(db.all("SELECT * FROM sessions ORDER BY id")), sessions);
    assert.equal(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")?.value, String(SCHEMA_VERSION));
    assert.equal(db.get<{ user_id: number }>("SELECT user_id FROM audit_log WHERE id = 1")?.user_id, 1000);
    assert.equal(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys, 1);
    assert.deepEqual(db.all("PRAGMA foreign_key_check"), []);
    assert.equal(db.get<{ table: string }>("PRAGMA foreign_key_list(sessions)")?.table, "users");

    const created = db.run(`INSERT INTO users (username, role, password_hash, created_at, updated_at)
      VALUES ('ChatGPT', 'tester', 'hash-test', 400, 400)`);
    assert.equal(created.lastInsertRowid, 1001);
    assert.throws(() => db!.run(`INSERT INTO users (username, role, password_hash, created_at, updated_at)
      VALUES ('ADMIN', 'tester', 'hash-test', 400, 400)`), /UNIQUE constraint failed/);
    assert.throws(() => db!.run(`INSERT INTO users (username, role, password_hash, created_at, updated_at)
      VALUES ('Inválido', 'superadmin', 'hash-test', 400, 400)`), /CHECK constraint failed/);

    db.close();
    db = new Db(file);
    assert.equal(db.get<{ role: string }>("SELECT role FROM users WHERE id = 1001")?.role, "tester");
    assert.deepEqual(plain(db.all("SELECT * FROM sessions ORDER BY id")), sessions);
    assert.equal(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys, 1);
    assert.equal(db.get<{ count: number }>("SELECT count(*) AS count FROM sqlite_master WHERE name = 'users_new'")?.count, 0);
    assert.throws(() => db!.run(`INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at)
      VALUES ('invalid-session', 999999, 0, 0, 100)`), /FOREIGN KEY constraint failed/);
    db.run("DELETE FROM users WHERE id = 42");
    assert.equal(db.get<{ count: number }>("SELECT count(*) AS count FROM sessions WHERE user_id = 42")?.count, 0);
  } finally {
    db?.close();
    closeFixture(raw);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("migración conserva la secuencia de una tabla de usuarios vacía", () => {
  const { file, dir, raw } = fixture();
  let db: Db | undefined;
  try {
    raw.exec(`INSERT INTO users (id, username, role, password_hash, created_at, updated_at)
      VALUES (50, 'Eliminado', 'viewer', 'hash-old', 0, 0); DELETE FROM users;`);
    raw.close();
    db = new Db(file);
    const created = db.run(`INSERT INTO users (username, role, password_hash, created_at, updated_at)
      VALUES ('Tester', 'tester', 'hash-test', 1, 1)`);
    assert.equal(created.lastInsertRowid, 51);
    assert.deepEqual(db.all("PRAGMA foreign_key_check"), []);
  } finally {
    db?.close();
    closeFixture(raw);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("una migración con referencias inválidas revierte esquema y datos sin avanzar la versión", () => {
  const { file, dir, raw } = fixture();
  let inspection: DatabaseSync | undefined;
  try {
    // Simula una base antigua dañada por una escritura con las FK desactivadas.
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.exec(`
      INSERT INTO users (id, username, role, password_hash, created_at, updated_at)
        VALUES (4, 'Admin', 'admin', 'hash-admin', 0, 0);
      INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at)
        VALUES ('orphan-session', 99, 1, 2, 3);
    `);
    const schema = raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'users'").get();
    const users = plain(raw.prepare("SELECT * FROM users").all());
    const sessions = plain(raw.prepare("SELECT * FROM sessions").all());
    raw.close();
    assert.throws(() => new Db(file), /migración 2.*referencias inválidas/);
    inspection = new DatabaseSync(file);
    assert.deepEqual(inspection.prepare("SELECT sql FROM sqlite_master WHERE name = 'users'").get(), schema);
    assert.deepEqual(plain(inspection.prepare("SELECT * FROM users").all()), users);
    assert.deepEqual(plain(inspection.prepare("SELECT * FROM sessions").all()), sessions);
    assert.equal(inspection.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value, "1");
    assert.equal(inspection.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'users_new'").get()?.count, 0);
    assert.equal(inspection.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'users'").get()?.seq, 4);
  } finally {
    inspection?.close();
    closeFixture(raw);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("una base nueva acepta Tester y mantiene las claves foráneas activas", () => {
  const db = new Db(":memory:");
  try {
    db.run(`INSERT INTO users (username, role, password_hash, created_at, updated_at)
      VALUES ('Tester', 'tester', 'hash-test', 1, 1)`);
    assert.equal(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")?.value, String(SCHEMA_VERSION));
    assert.equal(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys, 1);
    assert.deepEqual(db.all("PRAGMA foreign_key_check"), []);
  } finally {
    db.close();
  }
});

test("migración 3 marca deshabilitadas en el VMS y cierra sus alertas", () => {
  const { file, dir, raw } = fixture();
  let db: Db | undefined;
  try {
    raw.exec(`
      INSERT INTO cameras (id, server_id, camera_id, name, raw, online) VALUES
        ('s:1', 's', '1', 'Deshabilitada 1', '{"id":1,"disabled":1}', 0),
        ('s:2', 's', '2', 'Deshabilitada 2', '{"id":2,"enabled":false}', 0),
        ('s:3', 's', '3', 'JSON truncado', '{"id":3,"disab', 0),
        ('s:4', 's', '4', 'Normal', '{"id":4,"name":"Normal"}', 0);
      INSERT INTO events (id, ts, type, severity, source, camera_id, title, status, meta) VALUES
        (1, 1000, 'camera_offline', 'high', 'sistema', 's:1', 'sin señal 1', 'new', NULL),
        (2, 1001, 'camera_offline', 'high', 'sistema', 's:2', 'sin señal 2', 'ack', NULL),
        (3, 1002, 'camera_offline', 'high', 'sistema', 's:3', 'sin señal 3', 'new', NULL),
        (4, 1003, 'camera_offline', 'high', 'sistema', 's:4', 'sin señal 4', 'new', NULL),
        (5, 1004, 'camera_online', 'info', 'sistema', 's:4', 'volvió', 'new', NULL),
        (6, 1005, 'host_down', 'high', 'noc', NULL, 'equipo caído', 'new', '{"hostId":"h1"}'),
        (7, 1006, 'host_down', 'high', 'noc', NULL, 'meta inválida', 'new', '{"hostId":');
    `);
    raw.close();
    db = new Db(file);
    const vms = db.all<{ id: string; vms_disabled: number }>("SELECT id, vms_disabled FROM cameras ORDER BY id").map((r) => r.vms_disabled);
    assert.deepEqual(vms, [1, 1, 0, 0]);
    const ev = (id: number) => db!.get<Record<string, unknown>>("SELECT * FROM events WHERE id = $id", { id })!;
    for (const id of [1, 2]) {
      assert.equal(ev(id).status, "resolved");
      assert.equal(ev(id).resolved_by, "sistema");
      assert.equal(ev(id).ack_at, null, "no se falsea el MTTA");
    }
    assert.equal(ev(3).status, "new");
    assert.equal(ev(4).status, "new");
    assert.equal(ev(5).status, "resolved");
    assert.equal(ev(5).silent, 1);
    assert.equal(ev(4).dedupe_key, "camera_offline:s:4");
    assert.equal(ev(6).dedupe_key, "host_down:h1");
    assert.equal(ev(7).dedupe_key, null);
    assert.equal(ev(4).last_ts, 1003);
    assert.equal(ev(4).notified_at, 1003, "lo histórico no se vuelve a notificar");
    assert.equal(db.get<{ e: number }>("SELECT offline_event_id AS e FROM cameras WHERE id = 's:4'")!.e, 4);
    assert.equal(db.get<{ e: number | null }>("SELECT offline_event_id AS e FROM cameras WHERE id = 's:1'")!.e, null);
    assert.equal(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")?.value, String(SCHEMA_VERSION));
    db.close();
    db = new Db(file);
    assert.deepEqual(db.all<{ vms_disabled: number }>("SELECT vms_disabled FROM cameras ORDER BY id").map((r) => r.vms_disabled), [1, 1, 0, 0]);
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events")!.n, 7);
  } finally {
    db?.close();
    closeFixture(raw);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
