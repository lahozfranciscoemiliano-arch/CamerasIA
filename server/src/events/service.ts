import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db/index.js";
import type { Bus } from "../realtime/bus.js";

export const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const EVENT_STATUSES = ["new", "ack", "investigating", "resolved", "false_positive"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const EVENT_TYPES = [
  "motion",
  "person",
  "vehicle",
  "intrusion",
  "loitering",
  "tamper",
  "camera_offline",
  "camera_online",
  "host_down",
  "host_up",
  "vpn_up",
  "vpn_down",
  "ai_alert",
  "external",
  "system",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface EventRow {
  id: number;
  ts: number;
  type: EventType;
  severity: Severity;
  source: string;
  camera_id: string | null;
  title: string;
  description: string | null;
  snapshot: string | null;
  ai: string | null;
  status: EventStatus;
  assigned_to: string | null;
  ack_by: string | null;
  ack_at: number | null;
  resolved_by: string | null;
  resolved_at: number | null;
  meta: string | null;
}

export interface NewEvent {
  type: EventType;
  severity: Severity;
  source: string;
  cameraId?: string | null;
  title: string;
  description?: string | null;
  snapshot?: Buffer | null;
  ai?: unknown;
  meta?: Record<string, unknown>;
  ts?: number;
}

const OPEN = "('new','ack','investigating')";
const WEIGHT: Record<Severity, number> = { info: 0, low: 0.25, medium: 2, high: 6, critical: 15 };

export class EventService {
  constructor(
    private db: Db,
    private bus: Bus,
    private snapshotsDir: string,
    private cameraName: (id: string) => string | undefined,
  ) {
    fs.mkdirSync(snapshotsDir, { recursive: true });
    setInterval(() => this.prune(), 6 * 3600_000).unref();
  }

  toPublic = (e: EventRow) => ({
    id: e.id,
    ts: e.ts,
    type: e.type,
    severity: e.severity,
    source: e.source,
    cameraId: e.camera_id,
    cameraName: e.camera_id ? (this.cameraName(e.camera_id) ?? e.camera_id) : null,
    title: e.title,
    description: e.description,
    hasSnapshot: Boolean(e.snapshot),
    ai: e.ai ? JSON.parse(e.ai) : null,
    status: e.status,
    assignedTo: e.assigned_to,
    ackBy: e.ack_by,
    ackAt: e.ack_at,
    resolvedBy: e.resolved_by,
    resolvedAt: e.resolved_at,
    meta: e.meta ? JSON.parse(e.meta) : null,
  });

  create(e: NewEvent) {
    const ts = e.ts ?? Date.now();
    const res = this.db.run(
      `INSERT INTO events(ts, type, severity, source, camera_id, title, description, ai, meta)
       VALUES($ts, $type, $sev, $src, $cam, $title, $desc, $ai, $meta)`,
      {
        ts,
        type: e.type,
        sev: e.severity,
        src: e.source,
        cam: e.cameraId,
        title: e.title.slice(0, 200),
        desc: e.description?.slice(0, 4000),
        ai: e.ai ? JSON.stringify(e.ai) : null,
        meta: e.meta ? JSON.stringify(e.meta) : null,
      },
    );
    const id = Number(res.lastInsertRowid);
    if (e.snapshot) this.attachSnapshot(id, e.snapshot, ts);
    const ev = this.get(id)!;
    this.bus.publish("event.new", ev);
    return ev;
  }

  attachSnapshot(id: number, data: Buffer, ts = Date.now()) {
    const day = new Date(ts).toISOString().slice(0, 10);
    const rel = path.join(day, `${id}.jpg`);
    fs.mkdirSync(path.join(this.snapshotsDir, day), { recursive: true });
    fs.writeFileSync(path.join(this.snapshotsDir, rel), data);
    this.db.run("UPDATE events SET snapshot = $s WHERE id = $id", { s: rel, id });
  }

  snapshotPath(id: number) {
    const row = this.db.get<{ snapshot: string | null }>("SELECT snapshot FROM events WHERE id = $id", { id });
    if (!row?.snapshot) return null;
    const full = path.resolve(this.snapshotsDir, row.snapshot);
    if (!full.startsWith(path.resolve(this.snapshotsDir) + path.sep) || !fs.existsSync(full)) return null;
    return full;
  }

  row(id: number) {
    return this.db.get<EventRow>("SELECT * FROM events WHERE id = $id", { id });
  }

  get(id: number) {
    const r = this.row(id);
    return r ? this.toPublic(r) : undefined;
  }

  /** Actualiza campos de IA / clasificación de un evento existente (p.ej. tras la verificación con Claude). */
  enrich(id: number, patch: { type?: EventType; severity?: Severity; title?: string; description?: string; ai?: unknown }) {
    const cur = this.row(id);
    if (!cur) return;
    this.db.run("UPDATE events SET type = $type, severity = $sev, title = $title, description = $desc, ai = $ai WHERE id = $id", {
      id,
      type: patch.type ?? cur.type,
      sev: patch.severity ?? cur.severity,
      title: (patch.title ?? cur.title).slice(0, 200),
      desc: (patch.description ?? cur.description)?.slice(0, 4000),
      ai: patch.ai !== undefined ? JSON.stringify(patch.ai) : cur.ai,
    });
    const ev = this.get(id)!;
    this.bus.publish("event.update", ev);
    return ev;
  }

  setStatus(id: number, status: EventStatus, user: string) {
    const now = Date.now();
    const cur = this.row(id);
    if (!cur) return undefined;
    this.db.run(
      `UPDATE events SET status = $status,
         ack_by = CASE WHEN $status != 'new' AND ack_by IS NULL THEN $user ELSE ack_by END,
         ack_at = CASE WHEN $status != 'new' AND ack_at IS NULL THEN $now ELSE ack_at END,
         resolved_by = CASE WHEN $status IN ('resolved','false_positive') THEN $user ELSE NULL END,
         resolved_at = CASE WHEN $status IN ('resolved','false_positive') THEN $now ELSE NULL END
       WHERE id = $id`,
      { status, user, now, id },
    );
    const ev = this.get(id)!;
    this.bus.publish("event.update", ev);
    return ev;
  }

  assign(id: number, assignee: string | null) {
    this.db.run("UPDATE events SET assigned_to = $a WHERE id = $id", { a: assignee, id });
    const ev = this.get(id);
    if (ev) this.bus.publish("event.update", ev);
    return ev;
  }

  /** Cierra automáticamente eventos abiertos de un tipo para una cámara (p.ej. offline → online). */
  autoResolve(type: EventType, cameraId: string | null, metaKey?: string) {
    const rows = this.db.all<EventRow>(
      `SELECT * FROM events WHERE type = $type AND status IN ${OPEN} AND ($cam IS NULL OR camera_id = $cam) ORDER BY id DESC LIMIT 20`,
      { type, cam: cameraId },
    );
    for (const r of rows) {
      if (metaKey && !(r.meta ?? "").includes(metaKey)) continue;
      this.setStatus(r.id, "resolved", "sistema");
    }
  }

  addNote(id: number, userId: number, username: string, text: string) {
    this.db.run("INSERT INTO event_notes(event_id, user_id, username, ts, text) VALUES($id, $uid, $u, $ts, $text)", {
      id,
      uid: userId,
      u: username,
      ts: Date.now(),
      text: text.slice(0, 2000),
    });
    return this.notes(id);
  }

  notes(id: number) {
    return this.db.all("SELECT id, username, ts, text FROM event_notes WHERE event_id = $id ORDER BY ts", { id });
  }

  list(f: {
    status?: string;
    severity?: string;
    type?: string;
    camera?: string;
    q?: string;
    since?: number;
    until?: number;
    limit?: number;
    before?: number;
  }) {
    const where: string[] = [];
    const p: Record<string, string | number> = { limit: Math.min(f.limit ?? 100, 500) };
    if (f.status === "open") where.push(`status IN ${OPEN}`);
    else if (f.status) {
      where.push("status = $status");
      p.status = f.status;
    }
    if (f.severity) {
      const list = f.severity.split(",").filter((s) => (SEVERITIES as readonly string[]).includes(s));
      if (list.length) where.push(`severity IN (${list.map((s) => `'${s}'`).join(",")})`);
    }
    if (f.type) {
      const list = f.type.split(",").filter((s) => (EVENT_TYPES as readonly string[]).includes(s));
      if (list.length) where.push(`type IN (${list.map((s) => `'${s}'`).join(",")})`);
    }
    if (f.camera) {
      where.push("camera_id = $camera");
      p.camera = f.camera;
    }
    if (f.q) {
      where.push("(title LIKE $q OR description LIKE $q)");
      p.q = `%${f.q}%`;
    }
    if (f.since) {
      where.push("ts >= $since");
      p.since = f.since;
    }
    if (f.until) {
      where.push("ts <= $until");
      p.until = f.until;
    }
    if (f.before) {
      where.push("id < $before");
      p.before = f.before;
    }
    return this.db
      .all<EventRow>(`SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ts DESC, id DESC LIMIT $limit`, p)
      .map(this.toPublic);
  }

  /** Nivel de amenaza 1-5 a partir de eventos abiertos recientes ponderados por severidad. */
  threatLevel() {
    const rows = this.db.all<{ severity: Severity; n: number }>(
      `SELECT severity, COUNT(*) AS n FROM events WHERE status IN ${OPEN} AND ts > $since GROUP BY severity`,
      { since: Date.now() - 2 * 3600_000 },
    );
    // Los eventos de baja severidad (movimiento rutinario) suman poco y con tope, para que un sitio con
    // mucha actividad normal no quede en "crítico"; lo que pesa son los eventos medios/altos/críticos abiertos.
    const score = Math.round(
      rows.reduce((acc, r) => acc + (r.severity === "low" ? Math.min(3, WEIGHT.low * r.n) : WEIGHT[r.severity] * r.n), 0),
    );
    const level = score < 4 ? 1 : score < 10 ? 2 : score < 20 ? 3 : score < 40 ? 4 : 5;
    const labels = ["", "NORMAL", "VIGILANCIA", "ELEVADO", "ALTO", "CRÍTICO"];
    return { level, label: labels[level]!, score };
  }

  stats(hours = 24) {
    const since = Date.now() - hours * 3600_000;
    const bucketMs = hours <= 24 ? 3600_000 : 6 * 3600_000;
    const bySeverity = this.db.all<{ severity: string; n: number }>("SELECT severity, COUNT(*) AS n FROM events WHERE ts > $since GROUP BY severity", { since });
    const byType = this.db.all<{ type: string; n: number }>("SELECT type, COUNT(*) AS n FROM events WHERE ts > $since GROUP BY type ORDER BY n DESC", { since });
    const byCamera = this.db.all<{ camera_id: string; n: number }>(
      "SELECT camera_id, COUNT(*) AS n FROM events WHERE ts > $since AND camera_id IS NOT NULL GROUP BY camera_id ORDER BY n DESC LIMIT 8",
      { since },
    );
    const timeline = this.db.all<{ bucket: number; severity: string; n: number }>(
      "SELECT CAST(ts / $b AS INTEGER) * $b AS bucket, severity, COUNT(*) AS n FROM events WHERE ts > $since GROUP BY bucket, severity ORDER BY bucket",
      { since, b: bucketMs },
    );
    const open = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE status IN ${OPEN}`)!.n;
    const openCritical = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE status IN ${OPEN} AND severity IN ('high','critical')`)!.n;
    const mtta = this.db.get<{ avg: number | null }>("SELECT AVG(ack_at - ts) AS avg FROM events WHERE ack_at IS NOT NULL AND ts > $since", { since })!.avg;
    const aiVerified = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE ts > $since AND ai IS NOT NULL", { since })!.n;
    return {
      hours,
      bucketMs,
      total: bySeverity.reduce((a, r) => a + r.n, 0),
      open,
      openCritical,
      mttaMs: mtta,
      aiVerified,
      bySeverity: Object.fromEntries(bySeverity.map((r) => [r.severity, r.n])),
      byType: byType.map((r) => ({ type: r.type, count: r.n })),
      byCamera: byCamera.map((r) => ({ cameraId: r.camera_id, cameraName: this.cameraName(r.camera_id) ?? r.camera_id, count: r.n })),
      timeline,
      threat: this.threatLevel(),
    };
  }

  private prune() {
    const cutoff = Date.now() - 90 * 24 * 3600_000;
    this.db.run("DELETE FROM events WHERE ts < $cutoff", { cutoff });
    const snapCutoff = new Date(Date.now() - 30 * 24 * 3600_000).toISOString().slice(0, 10);
    for (const dir of fs.readdirSync(this.snapshotsDir)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(dir) && dir < snapCutoff) fs.rmSync(path.join(this.snapshotsDir, dir), { recursive: true, force: true });
    }
  }
}
