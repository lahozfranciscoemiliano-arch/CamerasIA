import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { CameraInfo, Clip, LiveStream, Snapshot, SourceStatus, VideoSource } from "./types.js";

const TIMEOUT_MS = 8000;

/**
 * Cliente de la API HTTP del exacqVision Web Service.
 *
 * Endpoints (verificados contra exacqVision Web Service 23.09 en producción):
 *   POST /v1/login.web          u, p, responseVersion=2, s=0      → { sessionId }
 *   POST /v1/logout.web?s=
 *   GET  /v1/config.web?s=&output=json                            → { name, timezone (horas), Cameras: [{ id, name, state, disabled, ... }] }
 *   GET  /v1/video.web?s=&camera=&fmt=jpg                         → image/jpeg (cuadro en vivo)
 *   GET  /v1/search.web?s=&camera=&start=&end=&output=json        → { videoInfo: [{ clips: [{ startTime, endTime }] }] }
 *   GET  /v1/export.web?s=&camera=&start=&end=&format=mp4&name=   → { export_id }
 *   GET  /v1/export.web?export=ID                                 → { progress }
 *   GET  /v1/export.web?export=ID&action=download | action=finish
 *
 * La URL de imagen en vivo (snapshot) y de stream MJPEG varía según versión del Web Service,
 * por eso se configuran como plantillas; si la configurada deja de responder, el cliente prueba
 * las candidatas y guarda la que funcione (ver detectTemplates()).
 */

export const DEFAULT_SNAPSHOT_CANDIDATES = [
  "/v1/video.web?s={session}&camera={camera}&fmt=jpg",
  "/v1/image.web?s={session}&camera={camera}&quality={quality}",
  "/v1/video.web?s={session}&camera={camera}&format=jpeg&quality={quality}",
  "/v1/snapshot.web?s={session}&camera={camera}",
  "/video.web?s={session}&camera={camera}&fmt=jpg",
  "/image.web?s={session}&camera={camera}",
];

export const DEFAULT_LIVE_CANDIDATES = [
  "/v1/video.web?s={session}&camera={camera}&fmt=mjpg",
  "/v1/video.web?s={session}&camera={camera}&format=mjpeg&quality={quality}",
  "/video.web?s={session}&camera={camera}&fmt=mjpg",
];

/**
 * Normaliza la URL que escribe el administrador: agrega http:// si falta y descarta páginas del
 * cliente web pegadas desde el navegador (p. ej. http://192.168.109.58/login.web → http://192.168.109.58).
 */
export function normalizeBaseUrl(input: string): string {
  let s = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  const u = new URL(s);
  u.hash = "";
  u.search = "";
  u.pathname = u.pathname.replace(/\/+$/, "").replace(/\/(v1\/)?[^/]*\.web$/i, "").replace(/\/v1$/i, "") || "/";
  return u.toString().replace(/\/$/, "");
}

/** Traduce los errores de red de fetch (undici sólo dice "fetch failed") a una causa accionable. */
export function describeNetworkError(err: unknown, baseUrl: string, timeoutMs = TIMEOUT_MS): string {
  const e = err as Error & { code?: string; cause?: { code?: string; message?: string; errors?: Array<{ code?: string }> } };
  let port = "";
  let https = false;
  try {
    const u = new URL(baseUrl);
    https = u.protocol === "https:";
    port = u.port || (https ? "443" : "80");
  } catch {
    /* URL inválida: sin puerto */
  }
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return `sin respuesta en ${Math.round(timeoutMs / 1000)} s (¿VPN conectada y con las rutas a la red interna?)`;
  const code = e?.cause?.code ?? e?.cause?.errors?.[0]?.code ?? e?.code ?? "";
  if (code === "ECONNREFUSED")
    return `conexión rechazada en el puerto ${port}${https ? ". El exacqVision Web Service suele atender por http:// (puerto 80): pruebe con http://" : ": revise IP y puerto del Web Service"}`;
  if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") return "tiempo de conexión agotado (¿VPN conectada y con las rutas a la red interna?)";
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return "red inalcanzable desde este servidor (¿VPN conectada y con las rutas a la red interna?)";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "no se pudo resolver el nombre del servidor (use la IP interna)";
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") return "el servidor cortó la conexión";
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|ERR_SSL|EPROTO/.test(code))
    return `fallo HTTPS (${code}): el certificado no es de confianza o el puerto no habla HTTPS. Use http:// si el Web Service no tiene un certificado válido`;
  return e?.cause?.message || code || e?.message || String(err);
}

export interface ExacqServerConfig {
  id: string;
  name: string;
  baseUrl: string;
  snapshotTemplate?: string | null;
  liveTemplate?: string | null;
  timezone?: string | null;
}

export interface ExacqHooks {
  /** Se llama cuando el cliente detecta (y empieza a usar) plantillas de video que funcionan: persistirlas. */
  onTemplates?: (t: { snapshot?: string; live?: string }) => void;
}

export class ExacqError extends Error {
  constructor(
    message: string,
    public kind: "network" | "auth" | "protocol" | "not_found" = "protocol",
  ) {
    super(message);
  }
}


/**
 * Formatea una fecha como ISO-8601 local con offset en la zona del servidor (igual que el cliente oficial).
 * `zone` es una zona IANA o el desfase en horas que informa config.web (p. ej. -3).
 */
export function formatExacqTime(d: Date, zone?: string | number | null): string {
  if (typeof zone === "number" && Number.isFinite(zone)) {
    const offsetMin = Math.round(Math.abs(zone) > 14 ? zone : zone * 60);
    const local = new Date(Math.floor(d.getTime() / 1000) * 1000 + offsetMin * 60_000).toISOString().slice(0, 19);
    return `${local}${fmtOffset(offsetMin)}`;
  }
  const tz = (typeof zone === "string" && zone) || Intl.DateTimeFormat().resolvedOptions().timeZone;
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
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${fmtOffset(offsetMin)}`;
}

function fmtOffset(offsetMin: number) {
  const abs = Math.abs(offsetMin);
  return `${offsetMin >= 0 ? "+" : "-"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

const truthy = (v: unknown) => v === true || v === 1 || v === "1" || v === "true";

export function parseCameraList(json: unknown): CameraInfo[] {
  const root = json as Record<string, unknown>;
  const list = (root?.Cameras ?? root?.cameras ?? []) as Array<Record<string, unknown>>;
  if (!Array.isArray(list)) return [];
  return list
    .filter((c) => c && (c.id !== undefined || c.Id !== undefined))
    .map((c) => {
      const id = String(c.id ?? c.Id);
      const label = [c.name, c.Name, c.label, c.description, c.displayName].find((v) => typeof v === "string" && v.trim() !== "");
      const name = typeof label === "string" ? label.trim().replace(/\s+/g, " ") : `Cámara ${id}`;
      // exacqVision 23.x: disabled = 1 → cámara deshabilitada en el servidor; state ≠ 0 → sin video.
      const disabled = truthy(c.disabled) || c.enabled === false || c.enabled === 0;
      let online: boolean;
      if (disabled) online = false;
      else if (typeof c.state === "number") online = c.state === 0;
      else {
        const statusRaw = c.status ?? c.Status ?? c.online ?? c.connected ?? c.enabled;
        online =
          statusRaw === undefined
            ? true
            : typeof statusRaw === "boolean"
              ? statusRaw
              : typeof statusRaw === "number"
                ? statusRaw > 0
                : !/off|fail|disconn|error|lost|down|0/i.test(String(statusRaw));
      }
      return { cameraId: id, name, online, disabled, raw: c };
    });
}

/** Desfase horario (horas) que informa config.web, si lo trae. */
export function parseServerOffset(json: unknown): number | null {
  const tz = (json as { timezone?: unknown })?.timezone;
  return typeof tz === "number" && Number.isFinite(tz) && Math.abs(tz) <= 14 * 60 ? tz : null;
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

export interface DiagnosisStep {
  step: string;
  ok: boolean;
  detail: string;
  ms?: number;
}

export interface Diagnosis {
  ok: boolean;
  steps: DiagnosisStep[];
  serverName?: string;
  cameras?: number;
  online?: number;
  disabled?: number;
  sample?: Array<{ id: string; name: string; online: boolean }>;
  snapshotTemplate?: string;
  /** Sugerencia accionable (p. ej. usar http:// en vez de https://). */
  suggestion?: { baseUrl: string; reason: string };
}

/** Cada cuánto, como máximo, se re-detecta la plantilla de snapshot cuando la actual falla. */
const HEAL_INTERVAL_MS = 10 * 60_000;

export class ExacqSource implements VideoSource {
  readonly kind = "exacq" as const;
  private session: string | null = null;
  private loggingIn: Promise<string> | null = null;
  private lastOkAt: number | null = null;
  private lastError = "Sin conexión todavía";
  private latencyMs?: number;
  /** Desfase horario (horas) informado por config.web; se usa si el servidor no tiene zona configurada. */
  private serverOffset: number | null = null;
  private healing: Promise<string | null> | null = null;
  private lastHealAt = 0;

  constructor(
    private cfg: ExacqServerConfig,
    private credentials: () => { username: string; password: string } | undefined,
    private onStatus?: (s: SourceStatus) => void,
    private hooks: ExacqHooks = {},
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

  private get zone() {
    return this.cfg.timezone || this.serverOffset;
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
      const e = new ExacqError(`No se pudo contactar ${this.cfg.baseUrl}: ${describeNetworkError(err, this.cfg.baseUrl, timeout)}`, "network");
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
      if (!res.ok) {
        await res.body?.cancel();
        throw new ExacqError(
          res.status === 404 ? "Login HTTP 404: el servidor no tiene /v1/login.web (¿la URL apunta al exacqVision Web Service?)" : `Login HTTP ${res.status}`,
          res.status === 404 ? "protocol" : "auth",
        );
      }
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
    return parseCameraList(
      await this.rawConfig((config) => {
        const root = config as Record<string, unknown> | null;
        if (!Array.isArray(root?.Cameras ?? root?.cameras)) {
          throw new ExacqError("v1/config.web no contiene un array Cameras/cameras compatible: revise el JSON del servidor", "protocol");
        }
      }),
    );
  }

  /** JSON crudo de config.web (útil para diagnosticar nombres de campos de su versión). */
  async rawConfig(validate?: (json: unknown) => void) {
    const json = await this.getJson("v1/config.web", { output: "json" }, true, validate);
    this.serverOffset = parseServerOffset(json) ?? this.serverOffset;
    return json;
  }

  private fill(template: string, session: string, camera: string, quality = 70) {
    return template
      .replaceAll("{session}", encodeURIComponent(session))
      .replaceAll("{camera}", encodeURIComponent(camera))
      .replaceAll("{quality}", String(quality))
      .replaceAll("{ts}", String(Date.now()))
      .replace(/^\//, "");
  }

  private activeSnapshotTemplate() {
    return this.cfg.snapshotTemplate || DEFAULT_SNAPSHOT_CANDIDATES[0]!;
  }

  private applyTemplates(t: { snapshot?: string; live?: string }) {
    if (t.snapshot) this.cfg.snapshotTemplate = t.snapshot;
    if (t.live) this.cfg.liveTemplate = t.live;
    if (t.snapshot || t.live) this.hooks.onTemplates?.(t);
  }

  /**
   * Cuadro en vivo. Si la plantilla activa no devuelve imagen (404/400/otro formato), prueba las
   * candidatas conocidas (como máximo cada 10 min) y adopta y guarda la primera que funcione.
   */
  async snapshot(cameraId: string, opts: { quality?: number; forceHeal?: boolean } = {}): Promise<Snapshot> {
    const template = this.activeSnapshotTemplate();
    try {
      return await this.snapshotWith(template, cameraId, opts.quality);
    } catch (e) {
      if (!(e instanceof ExacqError) || e.kind !== "protocol") throw e;
      const healed = await this.healSnapshotTemplate(cameraId, template, opts.forceHeal);
      if (!healed) throw e;
      return this.snapshotWith(healed, cameraId, opts.quality);
    }
  }

  private async healSnapshotTemplate(cameraId: string, failed: string, force = false): Promise<string | null> {
    const current = this.activeSnapshotTemplate();
    if (current !== failed) return current; // otra petición ya la reemplazó
    if (!this.healing) {
      if (!force && Date.now() - this.lastHealAt < HEAL_INTERVAL_MS) return null;
      this.lastHealAt = Date.now();
      this.healing = (async () => {
        for (const tpl of DEFAULT_SNAPSHOT_CANDIDATES) {
          if (tpl === failed) continue;
          try {
            await this.snapshotWith(tpl, cameraId);
            this.applyTemplates({ snapshot: tpl });
            return tpl;
          } catch (err) {
            if (err instanceof ExacqError && err.kind === "network") return null;
          }
        }
        return null;
      })().finally(() => {
        this.healing = null;
      });
    }
    return this.healing;
  }

  private async snapshotWith(template: string, cameraId: string, quality?: number): Promise<Snapshot> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const s = await this.sessionId();
      const res = await this.fetchRaw(this.url(this.fill(template, s, cameraId, quality)));
      const ct = res.headers.get("content-type") ?? "";
      if (res.ok && ct.startsWith("image/")) {
        return { data: Buffer.from(await res.arrayBuffer()), contentType: ct.split(";")[0]!, ts: Date.now() };
      }
      await res.body?.cancel();
      if (attempt === 0 && (res.status === 401 || res.status === 403 || ct.includes("json") || ct.includes("html"))) {
        this.session = null;
        continue;
      }
      throw new ExacqError(`Snapshot HTTP ${res.status} (${ct || "sin content-type"})`, "protocol");
    }
    throw new ExacqError("No se obtuvo imagen: revise la plantilla de snapshot del servidor", "protocol");
  }

  async liveStream(cameraId: string): Promise<(LiveStream & { body: Readable }) | null> {
    return this.cfg.liveTemplate ? this.liveWith(this.cfg.liveTemplate, cameraId) : null;
  }

  private async liveWith(template: string, cameraId: string): Promise<(LiveStream & { body: Readable }) | null> {
    const s = await this.sessionId();
    const ac = new AbortController();
    const res = await this.fetchRaw(this.url(this.fill(template, s, cameraId)), { signal: ac.signal });
    const ct = res.headers.get("content-type") ?? "";
    if (!res.ok || !ct.startsWith("multipart/") || !res.body) {
      ac.abort();
      return null;
    }
    return { body: Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>), contentType: ct, abort: () => ac.abort() };
  }

  async searchRecordings(cameraId: string, start: Date, end: Date) {
    if (this.zone == null) await this.rawConfig().catch(() => undefined);
    const json = await this.getJson("v1/search.web", {
      camera: cameraId,
      start: formatExacqTime(start, this.zone),
      end: formatExacqTime(end, this.zone),
      output: "json",
    });
    return parseClips(json);
  }

  async startExport(cameraId: string, start: Date, end: Date, name: string) {
    if (this.zone == null) await this.rawConfig().catch(() => undefined);
    const json = (await this.getJson("v1/export.web", {
      camera: cameraId,
      start: formatExacqTime(start, this.zone),
      end: formatExacqTime(end, this.zone),
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

  /**
   * Prueba plantillas candidatas contra una cámara; con `apply` adopta y guarda (hook onTemplates)
   * las que entregan imagen / MJPEG.
   */
  async detectTemplates(cameraId: string, opts: { apply?: boolean } = { apply: true }) {
    const result: { snapshot: string | null; live: string | null; applied: boolean; tried: Array<{ template: string; result: string }> } = {
      snapshot: null,
      live: null,
      applied: false,
      tried: [],
    };
    for (const tpl of DEFAULT_SNAPSHOT_CANDIDATES) {
      try {
        await this.snapshotWith(tpl, cameraId);
        result.snapshot = tpl;
        result.tried.push({ template: tpl, result: "OK (image/*)" });
        break;
      } catch (e) {
        result.tried.push({ template: tpl, result: (e as Error).message });
      }
    }
    for (const tpl of DEFAULT_LIVE_CANDIDATES) {
      try {
        const live = await this.liveWith(tpl, cameraId);
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
    if (opts.apply) {
      this.applyTemplates({ snapshot: result.snapshot ?? undefined, live: result.live ?? undefined });
      result.applied = Boolean(result.snapshot || result.live);
    }
    return result;
  }

  /**
   * Diagnóstico paso a paso para el botón "Probar": conexión → login → cámaras → imagen.
   * Con `heal`, si la URL de imagen no responde se re-detecta y guarda en el acto.
   */
  async diagnose(opts: { heal?: boolean } = {}): Promise<Diagnosis> {
    const steps: DiagnosisStep[] = [];
    const out: Diagnosis = { ok: false, steps };
    const run = async <T>(step: string, fn: () => Promise<T>, detail: (v: T) => string): Promise<T | undefined> => {
      const t0 = Date.now();
      try {
        const v = await fn();
        steps.push({ step, ok: true, detail: detail(v), ms: Date.now() - t0 });
        return v;
      } catch (e) {
        steps.push({ step, ok: false, detail: (e as Error).message, ms: Date.now() - t0 });
        return undefined;
      }
    };

    const reach = await run(
      "Conexión",
      async () => {
        const res = await this.fetchRaw(this.url(""));
        await res.body?.cancel();
        return res.status;
      },
      (st) => `${this.cfg.baseUrl} responde (HTTP ${st})`,
    );
    if (reach === undefined) {
      if (this.cfg.baseUrl.startsWith("https://")) {
        const alt = new URL(this.cfg.baseUrl);
        alt.protocol = "http:";
        alt.port = "";
        const altUrl = alt.toString().replace(/\/$/, "");
        try {
          const r = await fetch(altUrl + "/", { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
          await r.body?.cancel();
          out.suggestion = { baseUrl: altUrl, reason: `${altUrl} sí responde (HTTP ${r.status}): el Web Service atiende por http://.` };
        } catch {
          /* tampoco responde por http */
        }
      }
      return out;
    }

    if (!(await run("Inicio de sesión", () => this.sessionId(), () => "Credenciales aceptadas"))) return out;

    const cams = await run(
      "Cámaras (config.web)",
      () => this.listCameras(),
      (c) => `${c.length} cámaras · ${c.filter((x) => x.online).length} con video · ${c.filter((x) => x.disabled).length} deshabilitadas en exacqVision`,
    );
    if (!cams) return out;
    out.cameras = cams.length;
    out.online = cams.filter((c) => c.online).length;
    out.disabled = cams.filter((c) => c.disabled).length;
    out.sample = cams.slice(0, 8).map((c) => ({ id: c.cameraId, name: c.name, online: c.online }));

    const cam = cams.find((c) => c.online) ?? cams[0];
    if (!cam) {
      steps.push({ step: "Imagen en vivo", ok: false, detail: "El servidor no informó cámaras (¿el usuario tiene permisos sobre ellas?)" });
      return out;
    }
    const before = this.activeSnapshotTemplate();
    await run(
      `Imagen en vivo (${cam.name})`,
      () => this.snapshot(cam.cameraId, { forceHeal: opts.heal }),
      (snap) =>
        `${Math.round(snap.data.length / 1024)} KB ${snap.contentType}` +
        (this.activeSnapshotTemplate() !== before ? ` · URL de video detectada y guardada: ${this.activeSnapshotTemplate()}` : ""),
    );
    out.snapshotTemplate = this.activeSnapshotTemplate();
    out.ok = steps.every((s) => s.ok);
    return out;
  }

  async dispose() {
    if (!this.session) return;
    await this.fetchRaw(this.url(`v1/logout.web?${new URLSearchParams({ s: this.session })}`), { method: "POST" }).catch(() => undefined);
    this.session = null;
  }
}
