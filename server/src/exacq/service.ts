import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/index.js";
import type { Bus } from "../realtime/bus.js";
import type { VaultService } from "../vault/service.js";
import { AvailabilityTracker, type AvailabilityRules } from "./availability.js";
import { ExacqSource } from "./client.js";
import { DemoSource } from "./demo.js";
import type { CameraInfo, Snapshot, SourceStatus, VideoSource } from "./types.js";

export interface CameraRow {
  id: string;
  server_id: string;
  camera_id: string;
  name: string;
  zone: string | null;
  enabled: number;
  motion_enabled: number;
  ai_verify: number;
  sensitivity: number;
  raw: string | null;
  online: number;
  last_seen_at: number | null;
  sort_order: number;
  /** Deshabilitada en el propio exacqVision: nunca alerta ni cuenta. */
  vms_disabled: number;
  alerts_muted_until: number | null;
  offline_since: number | null;
  /** Evento que hoy representa su caída (individual, agrupado, de servidor o de VPN). */
  offline_event_id: number | null;
}

export type OfflineCamera = CameraRow & { reason: "signal" | "removed" };

/** "Silenciada para siempre": 9999-12-31. */
export const MUTE_FOREVER = 253402300799000;

export interface ExacqServerRow {
  id: string;
  name: string;
  base_url: string;
  credential_id: string | null;
  enabled: number;
  snapshot_template: string | null;
  live_template: string | null;
  vpn_profile_id: string | null;
  timezone: string | null;
  created_at: number;
  updated_at: number;
  last_ok_at: number | null;
  last_error: string | null;
}

export interface ExportJob {
  id: string;
  cameraKey: string;
  cameraName: string;
  start: string;
  end: string;
  status: "queued" | "exporting" | "downloading" | "ready" | "error";
  progress: number;
  kind: "mp4" | "mjpeg";
  file?: string;
  filename?: string;
  bytes?: number;
  error?: string;
  createdBy: string;
  createdAt: number;
}

export const cameraKey = (serverId: string, cameraId: string) => `${serverId}:${cameraId}`;

export const publicCamera = (r: CameraRow, sourceName?: string, sourceKind?: string) => ({
  id: r.id,
  serverId: r.server_id,
  serverName: sourceName ?? r.server_id,
  sourceKind: sourceKind ?? "exacq",
  cameraId: r.camera_id,
  name: r.name,
  zone: r.zone,
  enabled: Boolean(r.enabled),
  motionEnabled: Boolean(r.motion_enabled),
  aiVerify: Boolean(r.ai_verify),
  sensitivity: r.sensitivity,
  online: Boolean(r.online),
  lastSeenAt: r.last_seen_at,
  sortOrder: r.sort_order,
  vmsDisabled: Boolean(r.vms_disabled),
  alertsMutedUntil: r.alerts_muted_until && r.alerts_muted_until > Date.now() ? r.alerts_muted_until : null,
  offlineSince: r.offline_since ?? null,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class CameraService {
  readonly sources = new Map<string, VideoSource>();
  private snapCache = new Map<string, Promise<Snapshot>>();
  private snapTs = new Map<string, number>();
  readonly exports = new Map<string, ExportJob>();
  private syncTimer?: NodeJS.Timeout;
  private tracker: AvailabilityTracker;
  private now: () => number;
  private syncing?: Promise<void>;

  constructor(
    private db: Db,
    private vault: VaultService,
    private bus: Bus,
    private opts: {
      demo: boolean;
      exportsDir: string;
      log: (msg: string) => void;
      /** Cámaras confirmadas sin señal en una misma sincronización de una fuente (con histéresis). */
      onCamerasOffline?: (src: { id: string; name: string }, cams: OfflineCamera[]) => void;
      onCamerasOnline?: (cams: CameraRow[]) => void;
      /** Fuente confirmada caída: un único aviso por servidor, no uno por cámara. */
      onSourceDown?: (src: { id: string; name: string }, affected: CameraRow[], err: string, since: number) => void;
      onSourceUp?: (src: { id: string; name: string }, stillOffline: CameraRow[], downMs: number) => void;
      /** Cámaras que pasaron a estar deshabilitadas en exacqVision. */
      onVmsDisabled?: (cams: CameraRow[]) => void;
      /** Reglas de histéresis vigentes (la app usa 3 sincronizaciones y 60 s). */
      availability?: () => AvailabilityRules;
      now?: () => number;
      /** Plantillas de video adoptadas por un servidor (para auditoría). */
      onTemplatesAdopted?: (server: { id: string; name: string }, t: { snapshot?: string; live?: string }, reason: "auto" | "detect") => void;
      onSourceStatus?: (sourceId: string, name: string, status: SourceStatus) => void;
    },
  ) {
    fs.mkdirSync(opts.exportsDir, { recursive: true });
    this.now = opts.now ?? Date.now;
    this.tracker = new AvailabilityTracker(
      // Sin reglas explícitas no hay histéresis (comportamiento anterior); la app pasa las de settings.alerts.
      opts.availability ?? (() => ({ cameraMinSyncs: 1, cameraAfterMs: 0, sourceMinSyncs: 1, sourceAfterMs: 0 })),
    );
  }

  async start() {
    await this.reload();
    await this.sync().catch((e) => this.opts.log(`sync inicial: ${(e as Error).message}`));
    this.syncTimer = setInterval(() => void this.sync().catch(() => undefined), 30_000);
    this.syncTimer.unref();
    setInterval(() => this.cleanupExports(), 3600_000).unref();
  }

  stop() {
    clearInterval(this.syncTimer);
    for (const s of this.sources.values()) void s.dispose?.();
  }

  servers() {
    return this.db.all<ExacqServerRow>("SELECT * FROM exacq_servers ORDER BY name");
  }

  async reload() {
    for (const s of this.sources.values()) await s.dispose?.().catch(() => undefined);
    this.sources.clear();
    if (this.opts.demo) this.sources.set("demo", new DemoSource());
    for (const srv of this.servers()) {
      if (!srv.enabled) continue;
      const source = new ExacqSource(
        {
          id: srv.id,
          name: srv.name,
          baseUrl: srv.base_url,
          snapshotTemplate: srv.snapshot_template,
          liveTemplate: srv.live_template,
          timezone: srv.timezone,
        },
        () => {
          if (!srv.credential_id) return undefined;
          const s = this.vault.getSecret(srv.credential_id);
          return s?.username && s.password ? { username: s.username, password: s.password } : undefined;
        },
        (st) => {
          this.db.run("UPDATE exacq_servers SET last_ok_at = COALESCE($ok, last_ok_at), last_error = $err WHERE id = $id", {
            ok: st.ok ? Date.now() : null,
            err: st.ok ? null : st.detail,
            id: srv.id,
          });
          this.opts.onSourceStatus?.(srv.id, srv.name, st);
        },
        {
          // El cliente detectó URLs de video que funcionan: se guardan para los próximos reinicios.
          onTemplates: (t, reason) => {
            this.db.run(
              `UPDATE exacq_servers SET snapshot_template = COALESCE($snap, snapshot_template), live_template = COALESCE($live, live_template),
               updated_at = $now WHERE id = $id`,
              { snap: t.snapshot ?? null, live: t.live ?? null, now: Date.now(), id: srv.id },
            );
            this.opts.log(`exacqVision ${srv.name}: plantilla de video adoptada (${reason}) ${JSON.stringify(t)}`);
            this.opts.onTemplatesAdopted?.({ id: srv.id, name: srv.name }, t, reason);
          },
        },
      );
      this.sources.set(srv.id, source);
    }
  }

  /**
   * Descubre cámaras de cada fuente y actualiza su estado con histéresis: una cámara (o un servidor) sólo
   * se da por caída tras varias sincronizaciones seguidas y un tiempo mínimo; la recuperación es inmediata.
   * Los avisos se entregan agrupados por fuente (una llamada por sincronización), nunca uno por cámara.
   */
  sync(): Promise<void> {
    // Una sola sincronización a la vez (timer, VPN y rutas pueden pedirla juntas): las concurrentes comparten resultado.
    this.syncing ??= this.runSync().finally(() => {
      this.syncing = undefined;
    });
    return this.syncing;
  }

  private async runSync() {
    const list = [...this.sources.values()];
    // Hora de inicio: las sincronizaciones arrancan cada 30 s exactos, la respuesta puede demorar distinto.
    const now = this.now();
    const results = await Promise.allSettled(list.map((src) => src.listCameras()));
    results.forEach((r, i) => {
      const src = list[i]!;
      // Se usa el resultado de ESTA sincronización (no status().ok, que un snapshot fallido puede alterar).
      if (r.status === "rejected") this.sourceFailed(src, r.reason, now);
      else this.sourceListed(src, r.value, now);
    });
  }

  private publishStatus(row: CameraRow, src: VideoSource) {
    this.bus.publish("camera.status", publicCamera(row, src.name, src.kind));
  }

  private sourceFailed(src: VideoSource, reason: unknown, now: number) {
    const state = this.tracker.sourceFailed(src.id, now);
    if (state !== "confirm_down") return;
    const since = this.tracker.sourceFailingSince(src.id) ?? now;
    const affected = this.db.all<CameraRow>("SELECT * FROM cameras WHERE server_id = $sid AND online = 1 AND vms_disabled = 0", { sid: src.id });
    this.db.run("UPDATE cameras SET online = 0, offline_since = COALESCE(offline_since, $since) WHERE server_id = $sid AND online = 1 AND vms_disabled = 0", {
      sid: src.id,
      since,
    });
    const rows = affected.map((c) => ({ ...c, online: 0, offline_since: c.offline_since ?? since }));
    for (const row of rows) this.publishStatus(row, src);
    this.tracker.resetSource(src.id);
    const err = reason instanceof Error ? reason.message : String(reason ?? "sin respuesta");
    this.opts.onSourceDown?.({ id: src.id, name: src.name }, rows, err, since);
  }

  private sourceListed(src: VideoSource, cams: CameraInfo[], now: number) {
    const downSince = this.tracker.sourceFailingSince(src.id);
    const recovered = this.tracker.sourceOk(src.id) === "recovered";
    const offline: OfflineCamera[] = [];
    const online: CameraRow[] = [];
    const disabled: CameraRow[] = [];
    const seen = new Set<string>();

    // Cámara sin señal (o ausente del listado): se confirma con histéresis. Sólo se informa si estaba en línea
    // o si su caída todavía no está representada por ningún evento (p.ej. tras reponerse su servidor).
    const observeOffline = (row: CameraRow, reason: OfflineCamera["reason"]) => {
      if (this.tracker.cameraObserved(row.id, false, now) !== "confirm_offline") return;
      if (!row.online && row.offline_event_id !== null) return;
      const since = row.offline_since ?? this.tracker.firstOfflineAt(row.id) ?? now;
      if (row.online) this.db.run("UPDATE cameras SET online = 0, offline_since = $since WHERE id = $id", { since, id: row.id });
      const updated = { ...row, online: 0, offline_since: since };
      if (row.online) this.publishStatus(updated, src);
      offline.push({ ...updated, reason });
    };

    cams.forEach((c, idx) => {
      const id = cameraKey(src.id, c.cameraId);
      seen.add(id);
      const dis = Boolean(c.disabled);
      const prev = this.db.get<CameraRow>("SELECT * FROM cameras WHERE id = $id", { id });
      if (!prev) {
        // Visibilidad (enabled) es decisión del usuario; el estado en el VMS lo mantiene la sincronización.
        const demoDefaults = src.kind === "demo" && ["1", "3", "7"].includes(c.cameraId);
        this.db.run(
          `INSERT INTO cameras(id, server_id, camera_id, name, enabled, motion_enabled, ai_verify, raw, online, last_seen_at, sort_order, vms_disabled)
           VALUES($id, $sid, $cid, $name, 1, $motion, 0, $raw, $online, $seen, $order, $dis)`,
          {
            id,
            sid: src.id,
            cid: c.cameraId,
            name: c.name,
            motion: demoDefaults,
            raw: JSON.stringify(c.raw ?? null).slice(0, 20_000),
            online: c.online && !dis,
            seen: c.online ? now : null,
            order: idx,
            dis,
          },
        );
        if (!dis && !c.online) this.tracker.cameraObserved(id, false, now);
        return;
      }
      // El nombre lo puede cambiar el administrador en CamerasIA: sólo se corrige si quedó vacío o
      // difiere en espacios del que informa el VMS (versiones anteriores no los recortaban).
      const fixName = !prev.name.trim() || (prev.name !== c.name && prev.name.trim().replace(/\s+/g, " ") === c.name);
      this.db.run("UPDATE cameras SET name = $name, raw = $raw, vms_disabled = $dis WHERE id = $id", {
        name: fixName ? c.name : prev.name,
        raw: JSON.stringify(c.raw ?? null).slice(0, 20_000),
        dis,
        id,
      });
      if (dis) {
        // Deshabilitada en exacqVision: no se sigue su estado ni alerta. Al pasar a deshabilitada se cierra su caída.
        if (!prev.vms_disabled) {
          this.db.run("UPDATE cameras SET online = 0, offline_since = NULL, offline_event_id = NULL WHERE id = $id", { id });
          this.tracker.reset(id);
          disabled.push({ ...prev, vms_disabled: 1 });
          this.publishStatus({ ...prev, vms_disabled: 1, online: 0, offline_since: null, offline_event_id: null }, src);
        }
        return;
      }
      const row = { ...prev, vms_disabled: 0 };
      if (!c.online) return observeOffline(row, "signal");
      this.tracker.cameraObserved(id, true, now);
      this.db.run("UPDATE cameras SET online = 1, offline_since = NULL, last_seen_at = $now WHERE id = $id", { now, id });
      if (!prev.online) {
        const up = { ...row, online: 1, offline_since: null, last_seen_at: now };
        this.publishStatus(up, src);
        online.push(up);
      }
    });

    // Cámaras que ya no figuran en el servidor → se tratan como sin señal (con la misma histéresis).
    for (const cam of this.db.all<CameraRow>("SELECT * FROM cameras WHERE server_id = $sid AND vms_disabled = 0", { sid: src.id })) {
      if (!seen.has(cam.id)) observeOffline(cam, "removed");
    }

    const ref = { id: src.id, name: src.name };
    if (disabled.length) this.opts.onVmsDisabled?.(disabled);
    if (online.length) this.opts.onCamerasOnline?.(online);
    if (offline.length) this.opts.onCamerasOffline?.(ref, offline);
    if (recovered) {
      const still = this.db.all<CameraRow>("SELECT * FROM cameras WHERE server_id = $sid AND online = 0 AND vms_disabled = 0", { sid: src.id });
      this.opts.onSourceUp?.(ref, still, downSince ? now - downSince : 0);
    }
  }

  /** Cámaras de las fuentes activas. Por defecto oculta las deshabilitadas en exacqVision. */
  list(opts: { includeVmsDisabled?: boolean } = {}) {
    const activeSources = [...this.sources.keys()];
    return this.db
      .all<CameraRow>(`SELECT * FROM cameras ${opts.includeVmsDisabled ? "" : "WHERE vms_disabled = 0"} ORDER BY sort_order, name`)
      .filter((c) => activeSources.includes(c.server_id))
      .map((c) => {
        const src = this.sources.get(c.server_id)!;
        return publicCamera(c, src.name, src.kind);
      });
  }

  /** Silencia (o reactiva con `null`) las alertas de una cámara hasta el instante indicado. */
  setMute(key: string, until: number | null) {
    this.db.run("UPDATE cameras SET alerts_muted_until = $until WHERE id = $id", { until, id: key });
    const row = this.row(key);
    const src = row ? this.sources.get(row.server_id) : undefined;
    if (row) this.bus.publish("camera.status", publicCamera(row, src?.name, src?.kind));
    return row;
  }

  isMuted(key: string) {
    const r = this.db.get<{ until: number | null }>("SELECT alerts_muted_until AS until FROM cameras WHERE id = $id", { id: key });
    return Boolean(r?.until && r.until > this.now());
  }

  row(key: string) {
    return this.db.get<CameraRow>("SELECT * FROM cameras WHERE id = $id", { id: key });
  }

  resolve(key: string) {
    const row = this.row(key);
    if (!row) throw Object.assign(new Error("Cámara inexistente"), { statusCode: 404 });
    const source = this.sources.get(row.server_id);
    if (!source) throw Object.assign(new Error("El servidor de esta cámara no está activo"), { statusCode: 503 });
    return { row, source };
  }

  /** Snapshot con caché corta compartida entre visores y el motor de detección. */
  async snapshot(key: string, maxAgeMs = 400): Promise<Snapshot> {
    const ts = this.snapTs.get(key) ?? 0;
    const cached = this.snapCache.get(key);
    if (cached && Date.now() - ts < maxAgeMs) return cached;
    const { row, source } = this.resolve(key);
    const p = source.snapshot(row.camera_id);
    this.snapCache.set(key, p);
    this.snapTs.set(key, Date.now());
    p.catch(() => {
      if (this.snapCache.get(key) === p) this.snapCache.delete(key);
    });
    return p;
  }

  /** Stream MJPEG: usa el stream nativo del servidor si está configurado; si no, lo sintetiza desde snapshots. */
  async stream(key: string, req: FastifyRequest, reply: FastifyReply, fps: number) {
    const { row, source } = this.resolve(key);
    let closed = false;
    reply.raw.on("close", () => {
      closed = true;
    });
    const native = source.liveStream ? await source.liveStream(row.camera_id).catch(() => null) : null;
    reply.hijack();
    if (native) {
      reply.raw.writeHead(200, { "Content-Type": native.contentType, "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
      reply.raw.on("close", () => native.abort());
      try {
        for await (const chunk of native.body) {
          if (closed) break;
          reply.raw.write(chunk);
        }
      } catch {
        /* cliente desconectado */
      }
      reply.raw.end();
      return;
    }
    const boundary = "ciaframe";
    reply.raw.writeHead(200, {
      "Content-Type": `multipart/x-mixed-replace; boundary=${boundary}`,
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
      "X-Accel-Buffering": "no",
      Connection: "close",
    });
    const interval = 1000 / Math.min(Math.max(fps, 0.2), 10);
    let failures = 0;
    while (!closed) {
      const t0 = Date.now();
      try {
        const snap = await this.snapshot(key, interval * 0.8);
        failures = 0;
        reply.raw.write(`--${boundary}\r\nContent-Type: ${snap.contentType}\r\nContent-Length: ${snap.data.length}\r\n\r\n`);
        reply.raw.write(snap.data);
        reply.raw.write("\r\n");
      } catch {
        failures++;
        if (failures > 10) break;
      }
      await sleep(Math.max(50, interval - (Date.now() - t0)) * (failures ? 2 : 1));
    }
    reply.raw.end();
  }

  /** Reproducción simulada (sólo DEMO): cuadros generados para el instante grabado. */
  async replay(key: string, start: Date, speed: number, req: FastifyRequest, reply: FastifyReply) {
    const { row, source } = this.resolve(key);
    if (!(source instanceof DemoSource)) throw Object.assign(new Error("Reproducción directa sólo en modo demo"), { statusCode: 400 });
    let closed = false;
    reply.raw.on("close", () => {
      closed = true;
    });
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "multipart/x-mixed-replace; boundary=ciaframe", "Cache-Control": "no-store", Connection: "close" });
    const t0 = Date.now();
    while (!closed) {
      const t = start.getTime() + (Date.now() - t0) * speed;
      if (t > Date.now()) break;
      const frame = source.render(row.camera_id, t);
      reply.raw.write(`--ciaframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
      reply.raw.write(frame);
      reply.raw.write("\r\n");
      await sleep(250);
    }
    reply.raw.end();
  }

  async searchRecordings(key: string, start: Date, end: Date) {
    const { row, source } = this.resolve(key);
    return source.searchRecordings(row.camera_id, start, end);
  }

  startExport(key: string, start: Date, end: Date, user: string): ExportJob {
    const { row, source } = this.resolve(key);
    const id = crypto.randomUUID();
    const job: ExportJob = {
      id,
      cameraKey: key,
      cameraName: row.name,
      start: start.toISOString(),
      end: end.toISOString(),
      status: "queued",
      progress: 0,
      kind: source.kind === "demo" ? "mjpeg" : "mp4",
      createdBy: user,
      createdAt: Date.now(),
    };
    this.exports.set(id, job);
    if (source.kind === "demo") {
      job.status = "ready";
      job.progress = 100;
      return job;
    }
    void this.runExport(job, source, row.camera_id, start, end);
    return job;
  }

  private async runExport(job: ExportJob, source: VideoSource, cameraId: string, start: Date, end: Date) {
    let exportId: string | undefined;
    try {
      if (!source.startExport || !source.exportProgress || !source.downloadExport) throw new Error("La fuente no soporta exportación");
      job.status = "exporting";
      const safeName = `${job.cameraName}_${start.toISOString().slice(0, 16)}`.replace(/[^a-zA-Z0-9_-]/g, "_");
      exportId = await source.startExport(cameraId, start, end, safeName);
      let last = -1;
      let stalled = 0;
      while (true) {
        await sleep(2500);
        const p = await source.exportProgress(exportId);
        job.progress = Math.min(99, p);
        if (p >= 100) break;
        stalled = p === last ? stalled + 1 : 0;
        last = p;
        if (stalled > 40) throw new Error("La exportación no avanza");
      }
      job.status = "downloading";
      const file = path.join(this.opts.exportsDir, `${job.id}.mp4`);
      const res = await source.downloadExport(exportId, file);
      job.file = path.basename(file);
      job.filename = res.filename;
      job.bytes = res.bytes;
      job.progress = 100;
      job.status = "ready";
    } catch (e) {
      job.status = "error";
      job.error = (e as Error).message;
    } finally {
      if (exportId) await source.finishExport?.(exportId);
    }
  }

  private cleanupExports() {
    const cutoff = Date.now() - 24 * 3600_000;
    for (const [id, job] of this.exports) {
      if (job.createdAt < cutoff) {
        if (job.file) fs.rm(path.join(this.opts.exportsDir, job.file), () => undefined);
        this.exports.delete(id);
      }
    }
  }

  sourceStatuses() {
    return [...this.sources.values()].map((s) => ({ id: s.id, name: s.name, kind: s.kind, ...s.status() }));
  }
}
