import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { CameraInfo, Clip, LiveStream, Snapshot, SourceStatus, VideoSource } from "./types.js";

/**
 * Cliente de la API HTTP del exacqVision Web Service.
 *
 * Endpoints verificados (usados en producción por proyectos de la comunidad, p.ej. ExacqMan):
 *   POST /v1/login.web          u, p, responseVersion=2, s=0      → { sessionId }
 *   POST /v1/logout.web?s=
 *   GET  /v1/config.web?s=&output=json                            → { Cameras: [{ id, ... }] }
 *   GET  /v1/search.web?s=&camera=&start=&end=&output=json        → { videoInfo: [{ clips: [{ startTime, endTime }] }] }
 *   GET  /v1/export.web?s=&camera=&start=&end=&format=mp4&name=   → { export_id }
 *   GET  /v1/export.web?export=ID                                 → { progress }
 *   GET  /v1/export.web?export=ID&action=download | action=finish
 *
 * La URL de imagen en vivo (snapshot) y de stream MJPEG varía según versión del Web Service,
 * por eso se configuran como plantillas (ver DEFAULT_SNAPSHOT_CANDIDATES y detectTemplates()).
 */

export const DEFAULT_SNAPSHOT_CANDIDATES = [
  "/v1/image.web?s={session}&camera={camera}&quality={quality}",
  "/v1/video.web?s={session}&camera={camera}&format=jpeg&quality={quality}",
  "/v1/video.web?s={session}&camera={camera}&fmt=jpg",
  "/v1/snapshot.web?s={session}&camera={camera}",
  "/image.web?s={session}&camera={camera}",
  "/video.web?s={session}&camera={camera}&fmt=jpg",
];

export const DEFAULT_LIVE_CANDIDATES = [
  "/v1/video.web?s={session}&camera={camera}&format=mjpeg&quality={quality}",
  "/v1/video.web?s={session}&camera={camera}&fmt=mjpg",
  "/video.web?s={session}&camera={camera}&fmt=mjpg",
];

export interface ExacqServerConfig {
  id: string;
  name: string;
  baseUrl: string;
  snapshotTemplate?: string | null;
  liveTemplate?: string | null;
  timezone?: string | null;
}

export class ExacqError extends Error {
  constructor(
    message: string,
    public kind: "network" | "auth" | "protocol" | "not_found" = "protocol",
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 8000;

/** Formatea una fecha como ISO-8601 local con offset en la zona del servidor (igual que el cliente oficial). */
export function formatExacqTime(d: Date, timeZone?: string | null): string {
  const tz = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  const local = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  const offsetMin = Math.round((local - Math.floor(d.getTime() / 1000) * 1000) / 60_000);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const off = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${off}`;
}

export function parseCameraList(json: unknown): CameraInfo[] {
  const root = json as Record<string, unknown>;
  const list = (root?.Cameras ?? root?.cameras ?? []) as Array<Record<string, unknown>>;
  if (!Array.isArray(list)) return [];
  return list
    .filter((c) => c && (c.id !== undefined || c.Id !== undefined))
    .map((c) => {
      const id = String(c.id ?? c.Id);
      const name = String(c.name ?? c.Name ?? c.label ?? c.description ?? c.displayName ?? `Cámara ${id}`);
      const statusRaw = c.status ?? c.Status ?? c.online ?? c.connected ?? c.enabled;
      const online =
        statusRaw === undefined
          ? true
          : typeof statusRaw === "boolean"
            ? statusRaw
            : typeof statusRaw === "number"
              ? statusRaw > 0
              : !/off|fail|disconn|error|lost|down|0/i.test(String(statusRaw));
      return { cameraId: id, name, online, raw: c };
    });
}

export function parseClips(json: unknown): Clip[] {
  const info = (json as { videoInfo?: Array<{ clips?: Array<{ startTime: string; endTime: string }> }> })?.videoInfo ?? [];
  const clips: Clip[] = [];
  for (const v of info) {
    for (const c of v.clips ?? []) {
      const s = new Date(c.startTime);
      const e = new Date(c.endTime);
      if (!Number.isNaN(s.getTime()) && !Number.isNaN(e.getTime())) clips.push({ start: s.toISOString(), end: e.toISOString() });
    }
  }
  return clips.sort((a, b) => a.start.localeCompare(b.start));
}

export class ExacqSource implements VideoSource {
  readonly kind = "exacq" as const;
  private session: string | null = null;
  private loggingIn: Promise<string> | null = null;
  private lastOkAt: number | null = null;
  private lastError = "Sin conexión todavía";
  private latencyMs?: number;

  constructor(
    private cfg: ExacqServerConfig,
    private credentials: () => { username: string; password: string } | undefined,
    private onStatus?: (s: SourceStatus) => void,
  ) {}

  get id() {
    return this.cfg.id;
  }
  get name() {
    return this.cfg.name;
  }

  status(): SourceStatus {
    return { ok: this.lastError === "", detail: this.lastError || "Conectado", lastOkAt: this.lastOkAt, latencyMs: this.latencyMs };
  }

  private url(pathAndQuery: string) {
    return new URL(pathAndQuery, this.cfg.baseUrl.endsWith("/") ? this.cfg.baseUrl : this.cfg.baseUrl + "/").toString();
  }

  private markOk(latency: number) {
    this.lastOkAt = Date.now();
    this.latencyMs = latency;
    const changed = this.lastError !== "";
    this.lastError = "";
    if (changed) this.onStatus?.(this.status());
  }

  private markError(err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const changed = this.lastError !== msg;
    this.lastError = msg;
    if (changed) this.onStatus?.(this.status());
  }

  private async fetchRaw(url: string, init: RequestInit = {}, timeout = TIMEOUT_MS) {
    try {
      return await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeout), redirect: "manual" });
    } catch (err) {
      const e = new ExacqError(`No se pudo contactar ${this.cfg.baseUrl}: ${(err as Error).message}. ¿VPN conectada?`, "network");
      this.markError(e);
      throw e;
    }
  }

  async login(): Promise<string> {
    if (this.loggingIn) return this.loggingIn;
    this.loggingIn = (async () => {
      const t0 = Date.now();
      const cred = this.credentials();
      if (!cred) throw new ExacqError(`El servidor ${this.cfg.name} no tiene credenciales asignadas en la bóveda`, "auth");
      const body = new URLSearchParams({ u: cred.username, p: cred.password, responseVersion: "2", s: "0" });
      const res = await this.fetchRaw(this.url("v1/login.web"), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!res.ok) throw new ExacqError(`Login HTTP ${res.status}`, "auth");
      let json: { sessionId?: string; success?: boolean };
      try {
        json = (await res.json()) as typeof json;
      } catch {
        throw new ExacqError("El login no devolvió JSON: ¿la URL apunta al exacqVision Web Service?", "protocol");
      }
      if (!json?.sessionId || json.success === false) {
        throw new ExacqError("Credenciales de exacqVision rechazadas", "auth");
      }
      this.session = json.sessionId;
      this.markOk(Date.now() - t0);
      return json.sessionId;
    })();
    try {
      return await this.loggingIn;
    } catch (err) {
      this.session = null;
      this.markError(err);
      throw err;
    } finally {
      this.loggingIn = null;
    }
  }

  private async sessionId() {
    return this.session ?? (await this.login());
  }

  /** GET JSON con re-login automático si la sesión expiró. */
  private async getJson(path: string, params: Record<string, string>, retry = true, validate?: (json: unknown) => void): Promise<unknown> {
    const t0 = Date.now();
    try {
      const s = await this.sessionId();
      const qs = new URLSearchParams({ ...params, s });
      const res = await this.fetchRaw(this.url(`${path}?${qs}`));
      if (res.status === 401 || res.status === 403) {
        this.session = null;
        if (retry) return await this.getJson(path, params, false, validate);
        throw new ExacqError("Sesión de exacqVision rechazada", "auth");
      }
      if (!res.ok) throw new ExacqError(`${path} → HTTP ${res.status}`);
      const text = await res.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        this.session = null;
        if (retry) return await this.getJson(path, params, false, validate);
        throw new ExacqError(`${path} devolvió una respuesta no JSON`);
      }
      if ((json as { success?: boolean })?.success === false) {
        this.session = null;
        if (retry) return await this.getJson(path, params, false, validate);
        throw new ExacqError(`${path} devolvió success=false`, "auth");
      }
      validate?.(json);
      this.markOk(Date.now() - t0);
      return json;
    } catch (err) {
      this.markError(err);
      throw err;
    }
  }

  async listCameras() {
    const json = await this.getJson("v1/config.web", { output: "json" }, true, (config) => {
      const root = config as Record<string, unknown> | null;
      if (!Array.isArray(root?.Cameras ?? root?.cameras)) {
        throw new ExacqError("v1/config.web no contiene un array Cameras/cameras compatible: revise el JSON del servidor", "protocol");
      }
    });
    return parseCameraList(json);
  }

  /** Devuelve el JSON crudo de config.web (útil para diagnosticar nombres de campos de su versión). */
  async rawConfig() {
    return this.getJson("v1/config.web", { output: "json" });
  }

  private fill(template: string, session: string, camera: string, quality = 70) {
    return template
      .replaceAll("{session}", encodeURIComponent(session))
      .replaceAll("{camera}", encodeURIComponent(camera))
      .replaceAll("{quality}", String(quality))
      .replaceAll("{ts}", String(Date.now()));
  }

  async snapshot(cameraId: string, opts: { quality?: number } = {}, template = this.cfg.snapshotTemplate ?? DEFAULT_SNAPSHOT_CANDIDATES[0]!): Promise<Snapshot> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const s = await this.sessionId();
      const res = await this.fetchRaw(this.url(this.fill(template, s, cameraId, opts.quality).replace(/^\//, "")));
      const ct = res.headers.get("content-type") ?? "";
      if (res.ok && ct.startsWith("image/")) {
        return { data: Buffer.from(await res.arrayBuffer()), contentType: ct.split(";")[0]!, ts: Date.now() };
      }
      await res.body?.cancel();
      if (res.status === 401 || res.status === 403 || ct.includes("json") || ct.includes("html")) {
        this.session = null;
        continue;
      }
      throw new ExacqError(`Snapshot HTTP ${res.status} (${ct || "sin content-type"})`);
    }
    throw new ExacqError("No se obtuvo imagen: revise la plantilla de snapshot del servidor", "protocol");
  }

  async liveStream(cameraId: string): Promise<(LiveStream & { body: Readable }) | null> {
    if (!this.cfg.liveTemplate) return null;
    const s = await this.sessionId();
    const ac = new AbortController();
    const res = await this.fetchRaw(this.url(this.fill(this.cfg.liveTemplate, s, cameraId).replace(/^\//, "")), { signal: ac.signal });
    const ct = res.headers.get("content-type") ?? "";
    if (!res.ok || !ct.startsWith("multipart/") || !res.body) {
      ac.abort();
      return null;
    }
    return { body: Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>), contentType: ct, abort: () => ac.abort() };
  }

  async searchRecordings(cameraId: string, start: Date, end: Date) {
    const json = await this.getJson("v1/search.web", {
      camera: cameraId,
      start: formatExacqTime(start, this.cfg.timezone),
      end: formatExacqTime(end, this.cfg.timezone),
      output: "json",
    });
    return parseClips(json);
  }

  async startExport(cameraId: string, start: Date, end: Date, name: string) {
    const json = (await this.getJson("v1/export.web", {
      camera: cameraId,
      start: formatExacqTime(start, this.cfg.timezone),
      end: formatExacqTime(end, this.cfg.timezone),
      format: "mp4",
      name,
    })) as { export_id?: string };
    if (!json.export_id) throw new ExacqError("El servidor no devolvió export_id");
    return String(json.export_id);
  }

  async exportProgress(exportId: string) {
    const res = await this.fetchRaw(this.url(`v1/export.web?${new URLSearchParams({ export: exportId })}`));
    const json = (await res.json()) as { progress?: number | string };
    return Number(json.progress ?? 0);
  }

  async downloadExport(exportId: string, dest: string) {
    const res = await this.fetchRaw(this.url(`v1/export.web?${new URLSearchParams({ export: exportId, action: "download" })}`), {}, 10 * 60_000);
    if (!res.ok || !res.body) throw new ExacqError(`Descarga de exportación HTTP ${res.status}`);
    const cd = res.headers.get("content-disposition") ?? "";
    const filename = cd.split("filename=")[1]?.replace(/"/g, "").trim() || `export_${exportId}.mp4`;
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>), fs.createWriteStream(dest));
    return { bytes: fs.statSync(dest).size, filename };
  }

  async finishExport(exportId: string) {
    await this.fetchRaw(this.url(`v1/export.web?${new URLSearchParams({ export: exportId, action: "finish" })}`)).catch(() => undefined);
  }

  /** Prueba plantillas candidatas contra una cámara y devuelve la primera que entrega imagen / MJPEG. */
  async detectTemplates(cameraId: string) {
    const result: { snapshot: string | null; live: string | null; tried: Array<{ template: string; result: string }> } = {
      snapshot: null,
      live: null,
      tried: [],
    };
    for (const tpl of DEFAULT_SNAPSHOT_CANDIDATES) {
      try {
        await this.snapshot(cameraId, {}, tpl);
        result.snapshot = tpl;
        result.tried.push({ template: tpl, result: "OK (image/*)" });
        break;
      } catch (e) {
        result.tried.push({ template: tpl, result: (e as Error).message });
      }
    }
    const saved = this.cfg.liveTemplate;
    for (const tpl of DEFAULT_LIVE_CANDIDATES) {
      this.cfg.liveTemplate = tpl;
      try {
        const live = await this.liveStream(cameraId);
        if (live) {
          // La prueba sólo inspecciona las cabeceras y cancela el cuerpo.
          // fromWeb emite AbortError al cancelar: no hay un consumidor que lo maneje.
          live.body.on("error", () => undefined);
          live.abort();
          live.body.destroy();
          result.live = tpl;
          result.tried.push({ template: tpl, result: "OK (multipart)" });
          break;
        }
        result.tried.push({ template: tpl, result: "No es multipart" });
      } catch (e) {
        result.tried.push({ template: tpl, result: (e as Error).message });
      }
    }
    this.cfg.liveTemplate = saved;
    return result;
  }

  async dispose() {
    if (!this.session) return;
    await this.fetchRaw(this.url(`v1/logout.web?${new URLSearchParams({ s: this.session })}`), { method: "POST" }).catch(() => undefined);
    this.session = null;
  }
}
