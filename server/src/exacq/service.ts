import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/index.js";
import type { Bus } from "../realtime/bus.js";
import type { VaultService } from "../vault/service.js";
import type { LiveHub } from "../live/hub.js";
import { pipeLatestMultipart } from "../live/mjpeg.js";
import { ExacqSource } from "./client.js";
import { DemoSource } from "./demo.js";
import { liveProfileKey, parseLiveProfile, type LiveProfile } from "./live-profile.js";
import type { Snapshot, SnapshotOpts, SourceStatus, VideoSource } from "./types.js";

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
}

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
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class CameraService {
  readonly sources = new Map<string, VideoSource>();
  private snapCache = new Map<string, Promise<Snapshot>>();
  private snapTs = new Map<string, number>();
  readonly exports = new Map<string, ExportJob>();
  private syncTimer?: NodeJS.Timeout;
  /** LiveHub (video en vivo compartido); null si LIVE_ENABLED=false o en pruebas sin hub. */
  live: LiveHub | null = null;
  /** Caché de perfiles de video en vivo por servidor (tabla settings, clave live_profile:<id>). */
  private liveProfiles = new Map<string, LiveProfile | null>();

  constructor(
    private db: Db,
    private vault: VaultService,
    private bus: Bus,
    private opts: {
      demo: boolean;
      exportsDir: string;
      log: (msg: string) => void;
      onCameraStatusChange?: (cam: CameraRow, online: boolean) => void;
      /** Plantillas de video adoptadas por un servidor (para auditoría). */
      onTemplatesAdopted?: (server: { id: string; name: string }, t: { snapshot?: string; live?: string }, reason: "auto" | "detect") => void;
      onSourceStatus?: (sourceId: string, name: string, status: SourceStatus) => void;
    },
  ) {
    fs.mkdirSync(opts.exportsDir, { recursive: true });
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
          liveProfile: this.liveProfile(srv.id),
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
            // Los parámetros de video en vivo se verificaron con la URL anterior: se vuelven a probar
            // (salvo un perfil cargado a mano por un administrador).
            if (t.snapshot && this.liveProfile(srv.id)?.source !== "manual") this.setLiveProfile(srv.id, null);
          },
        },
      );
      this.sources.set(srv.id, source);
    }
  }

  /** Descubre cámaras de cada fuente y actualiza estado online/offline. */
  async sync() {
    const results = await Promise.allSettled(
      [...this.sources.values()].map(async (src) => ({ src, cams: await src.listCameras() })),
    );
    const now = Date.now();
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      const { src, cams } = r.value;
      const seen = new Set<string>();
      cams.forEach((c, idx) => {
        const id = cameraKey(src.id, c.cameraId);
        seen.add(id);
        const prev = this.db.get<CameraRow>("SELECT * FROM cameras WHERE id = $id", { id });
        if (!prev) {
          const demoDefaults = src.kind === "demo" && ["1", "3", "7"].includes(c.cameraId);
          this.db.run(
            `INSERT INTO cameras(id, server_id, camera_id, name, enabled, motion_enabled, ai_verify, raw, online, last_seen_at, sort_order)
             VALUES($id, $sid, $cid, $name, $enabled, $motion, 0, $raw, $online, $seen, $order)`,
            {
              id,
              enabled: !c.disabled,
              sid: src.id,
              cid: c.cameraId,
              name: c.name,
              motion: demoDefaults,
              raw: JSON.stringify(c.raw ?? null).slice(0, 20_000),
              online: c.online,
              seen: c.online ? now : null,
              order: idx,
            },
          );
          return;
        }
        // El nombre lo puede cambiar el administrador en CamerasIA: sólo se corrige si quedó vacío o
        // difiere en espacios del que informa el VMS (versiones anteriores no los recortaban).
        const fixName = !prev.name.trim() || (prev.name !== c.name && prev.name.trim().replace(/\s+/g, " ") === c.name);
        this.db.run("UPDATE cameras SET name = $name, raw = $raw, online = $online, last_seen_at = COALESCE($seen, last_seen_at) WHERE id = $id", {
          name: fixName ? c.name : prev.name,
          raw: JSON.stringify(c.raw ?? null).slice(0, 20_000),
          online: c.online,
          seen: c.online ? now : null,
          id,
        });
        if (Boolean(prev.online) !== c.online) {
          const row = { ...prev, online: c.online ? 1 : 0 };
          this.bus.publish("camera.status", publicCamera(row, src.name, src.kind));
          this.opts.onCameraStatusChange?.(row, c.online);
        }
      });
      // Cámaras que desaparecieron del servidor → offline
      for (const cam of this.db.all<CameraRow>("SELECT * FROM cameras WHERE server_id = $sid AND online = 1", { sid: src.id })) {
        if (!seen.has(cam.id)) {
          this.db.run("UPDATE cameras SET online = 0 WHERE id = $id", { id: cam.id });
          this.opts.onCameraStatusChange?.({ ...cam, online: 0 }, false);
        }
      }
    }
    // Fuentes que fallaron: sus cámaras quedan offline
    const failed = [...this.sources.values()].filter((s) => !s.status().ok);
    for (const src of failed) {
      for (const cam of this.db.all<CameraRow>("SELECT * FROM cameras WHERE server_id = $sid AND online = 1", { sid: src.id })) {
        this.db.run("UPDATE cameras SET online = 0 WHERE id = $id", { id: cam.id });
        this.opts.onCameraStatusChange?.({ ...cam, online: 0 }, false);
      }
    }
  }

  list() {
    const activeSources = [...this.sources.keys()];
    return this.db
      .all<CameraRow>("SELECT * FROM cameras ORDER BY sort_order, name")
      .filter((c) => activeSources.includes(c.server_id))
      .map((c) => {
        const src = this.sources.get(c.server_id)!;
        return publicCamera(c, src.name, src.kind);
      });
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

  /** Perfil de video en vivo guardado para un servidor (null: sin probar). */
  liveProfile(serverId: string): LiveProfile | null {
    if (!this.liveProfiles.has(serverId)) {
      this.liveProfiles.set(serverId, parseLiveProfile(this.db.getSetting<unknown>(liveProfileKey(serverId), null)));
    }
    return this.liveProfiles.get(serverId) ?? null;
  }

  /** Guarda (o borra con null) el perfil de video en vivo y lo aplica a la fuente activa. */
  setLiveProfile(serverId: string, profile: LiveProfile | null) {
    if (profile) this.db.setSetting(liveProfileKey(serverId), profile);
    else this.db.run("DELETE FROM settings WHERE key = $key", { key: liveProfileKey(serverId) });
    this.liveProfiles.set(serverId, profile);
    const src = this.sources.get(serverId);
    if (src instanceof ExacqSource) src.setLiveProfile(profile);
  }

  /** Cuadro en vivo para el LiveHub: tamaño/calidad según el perfil del servidor, cancelable. */
  async liveFrame(key: string, opts: Omit<SnapshotOpts, "live"> = {}): Promise<Snapshot> {
    const { row, source } = this.resolve(key);
    return source.snapshot(row.camera_id, { ...opts, live: true });
  }

  /**
   * Snapshot con caché corta compartida entre visores y el motor de detección. Si el LiveHub tiene
   * un cuadro reciente de la cámara se usa ese (con `allowScaled` aunque sea reducido; si no, sólo
   * si es de resolución nativa: descargas y análisis IA conservan la resolución completa).
   */
  async snapshot(key: string, maxAgeMs = 400, opts: { allowScaled?: boolean } = {}): Promise<Snapshot> {
    const f = this.live?.peek(key);
    if (f && Date.now() - f.tCap <= maxAgeMs && (opts.allowScaled || f.native)) {
      return { data: f.data, contentType: "image/jpeg", ts: f.tCap, width: f.w, height: f.h };
    }
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

  /**
   * Stream MJPEG: usa el stream nativo del servidor si está configurado; si no, lo sintetiza con el
   * LiveHub (o con snapshots si no hay hub). Siempre con contrapresión: si el cliente no consume,
   * se conserva sólo el último cuadro (la demora no crece mientras la vista siga abierta).
   */
  async stream(key: string, req: FastifyRequest, reply: FastifyReply, fps: number, opts: { tierW?: number } = {}) {
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
          if (!reply.raw.write(chunk)) {
            // Contrapresión: se espera a que el cliente consuma (o se desconecte).
            await new Promise<void>((resolve) => {
              const done = () => {
                reply.raw.off("drain", done);
                reply.raw.off("close", done);
                resolve();
              };
              reply.raw.on("drain", done);
              reply.raw.on("close", done);
            });
          }
        }
      } catch {
        /* cliente desconectado */
      }
      native.abort();
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
    const out = pipeLatestMultipart(reply.raw, boundary);
    const rate = Math.min(Math.max(fps, 0.2), 10);
    if (this.live) {
      let stalls = 0;
      const sub = this.live.subscribe(
        key,
        { fps: rate, tierW: opts.tierW ?? 0, prio: "focus" },
        {
          onFrame: (f) => {
            stalls = 0;
            out.push(f.data, "image/jpeg");
          },
          onState: (st) => {
            // Cámara inexistente/deshabilitada o sin cuadros por mucho tiempo: se corta el stream.
            if (st.st === "error" || st.st === "disabled" || (st.st === "stalled" && ++stalls > 5)) reply.raw.end();
          },
        },
      );
      await new Promise<void>((resolve) => {
        if (closed || reply.raw.writableEnded) return resolve();
        reply.raw.once("close", () => resolve());
        reply.raw.once("finish", () => resolve());
      });
      sub.close();
      out.close();
      if (!reply.raw.writableEnded) reply.raw.end();
      return;
    }
    const interval = 1000 / rate;
    let failures = 0;
    while (!closed) {
      const t0 = Date.now();
      try {
        const snap = await this.snapshot(key, interval * 0.8);
        failures = 0;
        out.push(snap.data, snap.contentType);
      } catch {
        failures++;
        if (failures > 10) break;
      }
      await sleep(Math.max(50, interval - (Date.now() - t0)) * (failures ? 2 : 1));
    }
    out.close();
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
