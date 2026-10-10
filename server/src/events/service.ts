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
  "source_down",
  "ai_alert",
  "external",
  "system",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Tipos de infraestructura (NOC); el resto son de seguridad (SOC). */
export const INFRA_TYPES = new Set<string>(["camera_offline", "camera_online", "host_down", "host_up", "vpn_down", "vpn_up", "source_down", "system"]);
export type EventCategory = "security" | "infra";
export const categoryOf = (t: string): EventCategory => (INFRA_TYPES.has(t) ? "infra" : "security");
export const SEV_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
export const maxSeverity = (a: Severity, b: Severity): Severity => (SEV_RANK[b] > SEV_RANK[a] ? b : a);
export const OPEN_STATUSES: readonly EventStatus[] = ["new", "ack", "investigating"];

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
  dedupe_key: string | null;
  occurrences: number;
  last_ts: number | null;
  notified_at: number | null;
  silent: number;
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
  /** Clave de deduplicación: un evento abierto con la misma clave se actualiza en vez de duplicarse. */
  dedupeKey?: string;
  /** Ventana de deduplicación medida desde la última ocurrencia (por defecto, mientras siga abierto). */
  dedupeWindowMs?: number;
  /** También reabre un evento con la misma clave cerrado por el sistema dentro de esta ventana. */
  reopenWithinMs?: number;
  /** Se registra sin notificar ni contar en el badge ni en el nivel de amenaza. */
  silent?: boolean;
  /** Demora la notificación (período de gracia): si se resuelve antes, no se avisa. */
  notifyAfterMs?: number;
}

export interface EventFilter {
  status?: string;
  severity?: string;
  type?: string;
  camera?: string;
  q?: string;
  since?: number;
  until?: number;
  before?: number;
  silent?: boolean;
  category?: EventCategory;
}

export type PublicEvent = ReturnType<EventService["toPublic"]>;
export type NoticeReason = "new" | "escalated" | "recovered";

/** Lo que el EventService necesita del NotificationHub (evita dependencia circular). */
export interface Notifier {
  offer(ev: PublicEvent, reason: NoticeReason, opts?: { delayMs?: number }): void;
}

export interface UpsertResult {
  ev: PublicEvent;
  created: boolean;
  reopened: boolean;
  escalated: boolean;
}

const BULK_CAP = 5000;

const OPEN = "('new','ack','investigating')";
const WEIGHT: Record<Severity, number> = { info: 0, low: 0.25, medium: 2, high: 6, critical: 15 };
const inList = (values: readonly string[]) => `(${values.map((v) => `'${v}'`).join(",")})`;
const INFRA_SQL = inList([...INFRA_TYPES]);

export class EventService {
  private notifier?: Notifier;
  private now: () => number;
  private cameraMuted: (id: string) => boolean;
  private flapThreshold: () => number;

  constructor(
    private db: Db,
    private bus: Bus,
    private snapshotsDir: string,
    private cameraName: (id: string) => string | undefined,
    opts: { cameraMuted?: (id: string) => boolean; now?: () => number; flapThreshold?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.flapThreshold = opts.flapThreshold ?? (() => 3);
    this.cameraMuted = opts.cameraMuted ?? (() => false);
    fs.mkdirSync(snapshotsDir, { recursive: true });
    setInterval(() => this.prune(), 6 * 3600_000).unref();
  }

  /** Se asigna después de construir el NotificationHub (que a su vez lee eventos). */
  setNotifier(n: Notifier | undefined) {
    this.notifier = n;
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
    meta: e.meta ? (JSON.parse(e.meta) as Record<string, unknown>) : null,
    occurrences: e.occurrences ?? 1,
    lastTs: e.last_ts ?? e.ts,
    silent: Boolean(e.silent),
    notifiedAt: e.notified_at ?? null,
    category: categoryOf(e.type),
  });

  /** Crea un evento (compatibilidad): equivale a `upsert(e).ev`. */
  create(e: NewEvent) {
    return this.upsert(e).ev;
  }

  /**
   * Crea un evento o, si trae `dedupeKey` y hay uno abierto (o cerrado por el sistema hace poco) con la misma
   * clave, suma una ocurrencia en lugar de duplicarlo. La severidad nunca baja: queda la máxima observada.
   */
  upsert(e: NewEvent): UpsertResult {
    const now = this.now();
    const silent = Boolean(e.silent) || Boolean(e.cameraId && this.cameraMuted(e.cameraId));
    if (e.dedupeKey) {
      const key = e.dedupeKey;
      const hit = this.db.tx(() => {
        let row = this.db.get<EventRow>(`SELECT * FROM events WHERE dedupe_key = $k AND status IN ${OPEN} ORDER BY id DESC LIMIT 1`, { k: key });
        if (row && e.dedupeWindowMs !== undefined && now - (row.last_ts ?? row.ts) > e.dedupeWindowMs) row = undefined;
        let reopened = false;
        if (!row && e.reopenWithinMs) {
          row = this.db.get<EventRow>(
            `SELECT * FROM events WHERE dedupe_key = $k AND status = 'resolved' AND resolved_by = 'sistema' AND resolved_at > $since ORDER BY id DESC LIMIT 1`,
            { k: key, since: now - e.reopenWithinMs },
          );
          reopened = Boolean(row);
        }
        if (!row) return null;
        const severity = maxSeverity(row.severity, e.severity);
        const occurrences = (row.occurrences ?? 1) + 1;
        let meta = row.meta;
        if (reopened) {
          const m: Record<string, unknown> = { ...(row.meta ? JSON.parse(row.meta) : {}), ...(e.meta ?? {}) };
          // Inestable: se cayó y volvió varias veces en la última hora.
          if (occurrences >= this.flapThreshold() && now - row.ts <= 3600_000) m.flapping = true;
          meta = JSON.stringify(m);
        }
        // Al reabrir, título/descripción/silencio pasan a ser los de la nueva caída (p.ej. tras un "microcorte").
        this.db.run(
          `UPDATE events SET occurrences = $occ, last_ts = $now, severity = $sev, meta = $meta,
             title = CASE WHEN $reopen THEN $title ELSE title END,
             description = CASE WHEN $reopen THEN COALESCE($desc, description) ELSE description END,
             silent = CASE WHEN $reopen THEN $silent ELSE silent END,
             status = CASE WHEN $reopen THEN 'new' ELSE status END,
             resolved_by = CASE WHEN $reopen THEN NULL ELSE resolved_by END,
             resolved_at = CASE WHEN $reopen THEN NULL ELSE resolved_at END,
             ack_by = CASE WHEN $reopen THEN NULL ELSE ack_by END,
             ack_at = CASE WHEN $reopen THEN NULL ELSE ack_at END,
             notified_at = CASE WHEN $reopen THEN NULL ELSE notified_at END
           WHERE id = $id`,
          { occ: occurrences, now, sev: severity, meta, reopen: reopened, id: row.id, title: e.title.slice(0, 200), desc: e.description?.slice(0, 4000) ?? null, silent },
        );
        if (reopened) this.systemNote(row.id, `Reabierto (n° ${occurrences})`);
        return { id: row.id, reopened, escalated: SEV_RANK[severity] > SEV_RANK[row.severity] };
      });
      if (hit) {
        const ev = this.get(hit.id)!;
        this.bus.publish("event.update", ev);
        // Reabierto = vuelve a ser una alerta nueva (con su período de gracia); si no, sólo se avisa si escaló.
        if (!ev.silent && hit.reopened) this.notifier?.offer(ev, "new", { delayMs: e.notifyAfterMs });
        else if (hit.escalated && !ev.silent) this.notifier?.offer(ev, "escalated");
        return { ev, created: false, reopened: hit.reopened, escalated: hit.escalated };
      }
    }
    const ts = e.ts ?? now;
    const res = this.db.run(
      `INSERT INTO events(ts, type, severity, source, camera_id, title, description, ai, meta, dedupe_key, occurrences, last_ts, silent)
       VALUES($ts, $type, $sev, $src, $cam, $title, $desc, $ai, $meta, $key, 1, $ts, $silent)`,
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
        key: e.dedupeKey ?? null,
        silent,
      },
    );
    const id = Number(res.lastInsertRowid);
    if (e.snapshot) this.attachSnapshot(id, e.snapshot, ts);
    const ev = this.get(id)!;
    this.bus.publish("event.new", ev);
    if (!silent) this.notifier?.offer(ev, "new", { delayMs: e.notifyAfterMs });
    return { ev, created: true, reopened: false, escalated: false };
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

  /**
   * Actualiza campos de IA / clasificación de un evento existente (p.ej. tras la verificación con Claude).
   * Con `keepMax` (re-verificación) nunca baja la severidad: si la nueva es menor sólo se guarda el análisis.
   * Si la severidad sube y el evento sigue abierto, se notifica como escalamiento.
   */
  enrich(
    id: number,
    patch: { type?: EventType; severity?: Severity; title?: string; description?: string; ai?: unknown; meta?: Record<string, unknown>; keepMax?: boolean },
  ) {
    const cur = this.row(id);
    if (!cur) return;
    const lower = Boolean(patch.keepMax && patch.severity !== undefined && SEV_RANK[patch.severity] < SEV_RANK[cur.severity]);
    const severity = lower ? cur.severity : (patch.severity ?? cur.severity);
    const meta = patch.meta ? JSON.stringify({ ...(cur.meta ? JSON.parse(cur.meta) : {}), ...patch.meta }) : cur.meta;
    this.db.run("UPDATE events SET type = $type, severity = $sev, title = $title, description = $desc, ai = $ai, meta = $meta WHERE id = $id", {
      id,
      type: lower ? cur.type : (patch.type ?? cur.type),
      sev: severity,
      title: (lower ? cur.title : (patch.title ?? cur.title)).slice(0, 200),
      desc: (lower ? cur.description : (patch.description ?? cur.description))?.slice(0, 4000),
      ai: patch.ai !== undefined ? JSON.stringify(patch.ai) : cur.ai,
      meta,
    });
    const ev = this.get(id)!;
    this.bus.publish("event.update", ev);
    const escalated = SEV_RANK[severity] > SEV_RANK[cur.severity];
    if (escalated && OPEN_STATUSES.includes(ev.status) && !ev.silent) this.notifier?.offer(ev, "escalated");
    return ev;
  }

  setStatus(id: number, status: EventStatus, user: string) {
    const now = this.now();
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

  private systemNote(id: number, text: string) {
    this.db.run("INSERT INTO event_notes(event_id, user_id, username, ts, text) VALUES($id, NULL, 'sistema', $ts, $text)", {
      id,
      ts: this.now(),
      text: text.slice(0, 2000),
    });
  }

  /**
   * Cierre automático por el sistema (recuperación): no completa ack_* (no falsea el MTTA), deja una nota en la
   * bitácora y, si el evento se había notificado, avisa la recuperación.
   */
  resolveBySystem(id: number, note?: string, patch: { severity?: Severity; title?: string; silent?: boolean } = {}) {
    const cur = this.row(id);
    if (!cur || !OPEN_STATUSES.includes(cur.status)) return undefined;
    this.db.run(
      `UPDATE events SET status = 'resolved', resolved_by = 'sistema', resolved_at = $now,
         severity = COALESCE($sev, severity), title = COALESCE($title, title), silent = COALESCE($silent, silent)
       WHERE id = $id`,
      { now: this.now(), sev: patch.severity ?? null, title: patch.title?.slice(0, 200) ?? null, silent: patch.silent ?? null, id },
    );
    if (note) this.systemNote(id, note);
    const ev = this.get(id)!;
    this.bus.publish("event.update", ev);
    if (cur.notified_at && !ev.silent) this.notifier?.offer(ev, "recovered");
    return ev;
  }

  /** Cierra (por el sistema) todos los eventos abiertos con esa clave de deduplicación (búsqueda indexada, sin tope). */
  resolveByKey(dedupeKey: string, note?: string | ((row: EventRow) => string), patch?: { severity?: Severity; title?: string; silent?: boolean }) {
    const rows = this.db.all<EventRow>(`SELECT * FROM events WHERE dedupe_key = $k AND status IN ${OPEN} ORDER BY id`, { k: dedupeKey });
    return rows.map((r) => this.resolveBySystem(r.id, typeof note === "function" ? note(r) : note, patch)).filter((e): e is PublicEvent => e !== undefined);
  }

  /** Compatibilidad: cierra eventos abiertos de un tipo para una cámara o un equipo (`metaKey` = hostId). */
  autoResolve(type: EventType, cameraId: string | null, metaKey?: string) {
    const rows = this.db.all<{ id: number }>(
      `SELECT id FROM events WHERE type = $type AND status IN ${OPEN} AND ($cam IS NULL OR camera_id = $cam)
         AND ($host IS NULL OR (CASE WHEN json_valid(meta) THEN json_extract(meta, '$.hostId') ELSE NULL END) = $host)`,
      { type, cam: cameraId, host: metaKey ?? null },
    );
    for (const r of rows) this.resolveBySystem(r.id);
  }

  /** Marca eventos como notificados (no se vuelven a avisar tras un reinicio). */
  markNotified(ids: number[]) {
    const list = ids.filter((id) => Number.isInteger(id));
    if (!list.length) return;
    this.db.run(`UPDATE events SET notified_at = $now WHERE notified_at IS NULL AND id IN (${list.join(",")})`, { now: this.now() });
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

  /** Arma el WHERE compartido por la lista y las acciones masivas (valores parametrizados o validados contra listas fijas). */
  private where(f: EventFilter) {
    const where: string[] = [];
    const p: Record<string, string | number> = {};
    if (f.status === "open") where.push(`status IN ${OPEN}`);
    else if (f.status) {
      where.push("status = $status");
      p.status = f.status;
    }
    if (f.severity) {
      const list = f.severity.split(",").filter((s) => (SEVERITIES as readonly string[]).includes(s));
      if (list.length) where.push(`severity IN ${inList(list)}`);
    }
    if (f.type) {
      const list = f.type.split(",").filter((s) => (EVENT_TYPES as readonly string[]).includes(s));
      if (list.length) where.push(`type IN ${inList(list)}`);
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
    if (f.silent !== undefined) where.push(f.silent ? "silent = 1" : "silent = 0");
    if (f.category === "infra") where.push(`type IN ${INFRA_SQL}`);
    else if (f.category === "security") where.push(`type NOT IN ${INFRA_SQL}`);
    return { sql: where.length ? where.join(" AND ") : "1 = 1", params: p };
  }

  list(f: EventFilter & { limit?: number }) {
    const w = this.where(f);
    return this.db
      .all<EventRow>(`SELECT * FROM events WHERE ${w.sql} ORDER BY ts DESC, id DESC LIMIT $limit`, { ...w.params, limit: Math.min(f.limit ?? 100, 500) })
      .map(this.toPublic);
  }

  /**
   * Cambio de estado masivo en una sola sentencia. Sólo cambia lo que corresponde: "ack" únicamente desde "new"
   * (no reabre eventos que se resolvieron entretanto); "resolved"/"false_positive" desde cualquier estado abierto.
   */
  bulkStatus(opts: { ids?: number[]; filter?: EventFilter; status: "ack" | "resolved" | "false_positive"; user: string; dryRun?: boolean }) {
    const from = opts.status === "ack" ? "('new')" : OPEN;
    const w = this.where(opts.filter ?? {});
    let sql = `${w.sql} AND status IN ${from}`;
    if (opts.ids) {
      const ids = opts.ids.filter((id) => Number.isInteger(id));
      if (!ids.length) return { count: 0, ids: [] as number[] };
      sql += ` AND id IN (${ids.join(",")})`;
    }
    if (opts.dryRun) {
      const n = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE ${sql}`, w.params)!.n;
      return { count: Math.min(n, BULK_CAP), ids: [] as number[] };
    }
    const now = this.now();
    const set =
      opts.status === "ack"
        ? "status = 'ack', ack_by = COALESCE(ack_by, $user), ack_at = COALESCE(ack_at, $now)"
        : "status = $newStatus, ack_by = COALESCE(ack_by, $user), ack_at = COALESCE(ack_at, $now), resolved_by = $user, resolved_at = $now";
    const rows = this.db.all<{ id: number }>(
      `UPDATE events SET ${set} WHERE id IN (SELECT id FROM events WHERE ${sql} ORDER BY id DESC LIMIT ${BULK_CAP}) RETURNING id`,
      { ...w.params, user: opts.user, now, ...(opts.status === "ack" ? {} : { newStatus: opts.status }) },
    );
    const ids = rows.map((r) => r.id).sort((a, b) => b - a);
    if (ids.length) this.bus.publish("event.bulk", { ids, status: opts.status, by: opts.user, at: now });
    return { count: ids.length, ids };
  }

  /**
   * Nivel de amenaza 1-5 a partir de eventos abiertos recientes ponderados por severidad.
   * La infraestructura suma con tope (a lo sumo "VIGILANCIA"): una caída no es una amenaza de seguridad.
   */
  threatLevel() {
    const rows = this.db.all<{ severity: Severity; infra: number; n: number }>(
      `SELECT severity, (type IN ${INFRA_SQL}) AS infra, COUNT(*) AS n FROM events
       WHERE status IN ${OPEN} AND silent = 0 AND ts > $since GROUP BY severity, infra`,
      { since: this.now() - 2 * 3600_000 },
    );
    // Los eventos de baja severidad (movimiento rutinario) suman poco y con tope, para que un sitio con
    // mucha actividad normal no quede en "crítico"; lo que pesa son los eventos medios/altos/críticos abiertos.
    let security = 0;
    let infra = 0;
    for (const r of rows) {
      if (r.infra) infra += WEIGHT[r.severity] * r.n;
      else security += r.severity === "low" ? Math.min(3, WEIGHT.low * r.n) : WEIGHT[r.severity] * r.n;
    }
    const score = Math.round(security + Math.min(6, infra));
    const level = score < 4 ? 1 : score < 10 ? 2 : score < 20 ? 3 : score < 40 ? 4 : 5;
    const labels = ["", "NORMAL", "VIGILANCIA", "ELEVADO", "ALTO", "CRÍTICO"];
    return { level, label: labels[level]!, score };
  }

  stats(hours = 24) {
    const since = this.now() - hours * 3600_000;
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
    const counts = this.db.get<{ open: number; critical: number; alerting: number; security: number; infra: number }>(
      `SELECT COUNT(*) AS open,
         COALESCE(SUM(silent = 0 AND severity IN ('high','critical')), 0) AS critical,
         COALESCE(SUM(silent = 0 AND severity IN ('medium','high','critical')), 0) AS alerting,
         COALESCE(SUM(silent = 0 AND type NOT IN ${INFRA_SQL}), 0) AS security,
         COALESCE(SUM(silent = 0 AND type IN ${INFRA_SQL}), 0) AS infra
       FROM events WHERE status IN ${OPEN}`,
    )!;
    // MTTA: sólo reconocimientos humanos (los cierres automáticos del sistema o de la IA no cuentan).
    const mtta = this.db.get<{ avg: number | null }>(
      "SELECT AVG(ack_at - ts) AS avg FROM events WHERE ack_at IS NOT NULL AND COALESCE(ack_by, '') NOT IN ('sistema', 'IA') AND ts > $since",
      { since },
    )!.avg;
    const aiVerified = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE ts > $since AND ai IS NOT NULL", { since })!.n;
    return {
      hours,
      bucketMs,
      total: bySeverity.reduce((a, r) => a + r.n, 0),
      open: counts.open,
      openCritical: counts.critical,
      openAlerting: counts.alerting,
      openSecurity: counts.security,
      openInfra: counts.infra,
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
