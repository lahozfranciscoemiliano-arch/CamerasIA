import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseJpegInfo } from "../video/jpeg.js";
import { fillExtra, type LiveProfile } from "./live-profile.js";
import type { CameraInfo, Clip, LiveStream, Snapshot, SnapshotOpts, SourceStatus, VideoSource } from "./types.js";

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
  // "http:/x", "http//x", "https:x": esquema mal escrito → que falle la validación en vez de inventar el host "http"
  if (/^https?(:\/?(?!\/)|\/\/)/i.test(s)) throw new TypeError("Esquema mal escrito");
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
  /** Perfil de video en vivo (parámetros de tamaño/calidad verificados para este servidor). */
  liveProfile?: LiveProfile | null;
}

/** Opciones internas de un pedido de imagen. */
interface ImageRequest {
  quality?: number;
  /** Parámetros extra (con marcadores {w} {h} {q} {c}) que se agregan a la URL. */
  extra?: string;
  w?: number;
  h?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Cuadro en vivo: sus fallas no cambian el estado del servidor. */
  live?: boolean;
}

/** Fallas seguidas de cuadros en vivo (todas las cámaras) a partir de las cuales se informa error del servidor. */
const LIVE_FAILURES_TO_MARK = 10;

export interface ExacqHooks {
  /**
   * Se llama cuando el cliente adopta plantillas de video que funcionan, para persistirlas.
   * `reason`: "auto" (autocorrección al fallar la imagen) o "detect" (pedido explícito de un administrador).
   */
  onTemplates?: (t: { snapshot?: string; live?: string }, reason: "auto" | "detect") => void;
}

export class ExacqError extends Error {
  constructor(
    message: string,
    public kind: "network" | "auth" | "protocol" | "not_found" | "aborted" = "protocol",
    /** Código HTTP de la respuesta que originó el error, si la hubo. */
    public status?: number,
  ) {
    super(message);
  }
}

/**
 * ¿La respuesta indica que la URL de imagen no existe en esta versión del Web Service (y conviene
 * probar otra plantilla)? Los 5xx y cortes son transitorios: no justifican cambiar de plantilla.
 */
const isTemplateMismatch = (e: unknown) =>
  e instanceof ExacqError &&
  e.kind === "protocol" &&
  (e.status === undefined || (e.status >= 200 && e.status < 500 && ![401, 403, 408, 429].includes(e.status)));


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
  /** Plantilla de imagen que sí funciona cuando la configurada no (se guarda con "Detectar video"). */
  workingSnapshotTemplate?: string;
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
  /** Último intento de autocorrección por cámara (una cámara sin video no bloquea a las demás). */
  private healAttempts = new Map<string, number>();
  /** Cuadros en vivo fallidos seguidos (se reinicia con el primer cuadro correcto). */
  private liveFailures = 0;

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

  /**
   * fetch con tiempo máximo. Si el llamador pasa su propia señal, se combina con el tiempo máximo
   * (`timeout = null` deja sólo la señal: streams MJPEG de larga duración).
   * `live`: los cuadros en vivo no cambian el estado del servidor al fallar.
   */
  private async fetchRaw(url: string, init: RequestInit = {}, timeout: number | null = TIMEOUT_MS, opts: { live?: boolean } = {}) {
    const caller = init.signal ?? undefined;
    const signal = timeout === null ? caller : caller ? AbortSignal.any([caller, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
    try {
      return await fetch(url, { ...init, signal, redirect: "manual" });
    } catch (err) {
      if (caller?.aborted) throw new ExacqError("Pedido cancelado", "aborted");
      const e = new ExacqError(`No se pudo contactar ${this.cfg.baseUrl}: ${describeNetworkError(err, this.cfg.baseUrl, timeout ?? TIMEOUT_MS)}`, "network");
      if (!opts.live) this.markError(e);
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

  private applyTemplates(t: { snapshot?: string; live?: string }, reason: "auto" | "detect") {
    const adopted: { snapshot?: string; live?: string } = {};
    if (t.snapshot) adopted.snapshot = this.cfg.snapshotTemplate = t.snapshot;
    if (t.live) adopted.live = this.cfg.liveTemplate = t.live;
    if (adopted.snapshot || adopted.live) this.hooks.onTemplates?.(adopted, reason);
  }

  /**
   * Cuadro en vivo. Si la plantilla activa no existe en esta versión (404/400/otro formato), prueba
   * las candidatas conocidas y adopta y guarda la primera que funcione. Nunca reemplaza una
   * plantilla personalizada por el administrador ni reacciona a errores transitorios (5xx, red).
   */
  async snapshot(cameraId: string, opts: SnapshotOpts = {}): Promise<Snapshot> {
    const template = this.activeSnapshotTemplate();
    const req = this.imageRequest(opts);
    try {
      return await this.snapshotWith(template, cameraId, req);
    } catch (e) {
      if (!isTemplateMismatch(e)) throw e;
      const healed = await this.healSnapshotTemplate(cameraId, template);
      if (!healed) throw e;
      return this.snapshotWith(healed, cameraId, req);
    }
  }

  /** Perfil de video en vivo vigente (null: cuadros a resolución nativa). */
  get liveProfile(): LiveProfile | null {
    return this.cfg.liveProfile ?? null;
  }

  setLiveProfile(p: LiveProfile | null) {
    this.cfg.liveProfile = p;
  }

  /** Traduce las opciones de un cuadro a parámetros de URL según el perfil de video en vivo. */
  private imageRequest(opts: SnapshotOpts): ImageRequest {
    const req: ImageRequest = { quality: opts.quality, signal: opts.signal, timeoutMs: opts.timeoutMs, live: opts.live };
    const p = opts.live ? this.cfg.liveProfile : null;
    if (p) {
      const extras: string[] = [];
      if (opts.width && p.resize) {
        extras.push(p.resize.extra);
        req.w = opts.width;
        req.h = opts.height;
      }
      if (opts.quality && p.quality) extras.push(p.quality.extra);
      if (extras.length) req.extra = extras.join("&");
    }
    return req;
  }

  /**
   * Cuadro con la plantilla activa y parámetros extra, sin autocorrección de plantilla ni cambio de
   * estado del servidor (lo usa la prueba de perfil de video en vivo).
   */
  async fetchImage(cameraId: string, opts: { extra?: string; w?: number; h?: number; quality?: number; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Snapshot> {
    return this.snapshotWith(this.activeSnapshotTemplate(), cameraId, { ...opts, live: true });
  }

  /** ¿La plantilla activa ya acepta la calidad ({quality})? */
  get templateHasQuality() {
    return this.activeSnapshotTemplate().includes("{quality}");
  }

  /** Sólo se autocorrigen la plantilla por defecto o una adoptada de la lista conocida. */
  private canAutoHeal() {
    return !this.cfg.snapshotTemplate || DEFAULT_SNAPSHOT_CANDIDATES.includes(this.cfg.snapshotTemplate);
  }

  /** Prueba las candidatas (salvo `skip`) contra una cámara. `network` = no se pudo completar la prueba. */
  private async probeSnapshotCandidates(cameraId: string, skip?: string): Promise<{ template: string | null; network: boolean }> {
    for (const tpl of DEFAULT_SNAPSHOT_CANDIDATES) {
      if (tpl === skip) continue;
      try {
        await this.snapshotWith(tpl, cameraId);
        return { template: tpl, network: false };
      } catch (err) {
        if (!(err instanceof ExacqError) || err.kind === "network" || err.kind === "auth") return { template: null, network: true };
      }
    }
    return { template: null, network: false };
  }

  private async healSnapshotTemplate(cameraId: string, failed: string): Promise<string | null> {
    const current = this.activeSnapshotTemplate();
    if (current !== failed) return current; // otra petición ya la reemplazó
    if (!this.canAutoHeal()) return null;
    if (this.healing) return this.healing;
    if (Date.now() - (this.healAttempts.get(cameraId) ?? 0) < HEAL_INTERVAL_MS) return null;
    this.healing = (async () => {
      const r = await this.probeSnapshotCandidates(cameraId, failed);
      if (r.template) {
        this.healAttempts.clear();
        this.applyTemplates({ snapshot: r.template }, "auto");
        return r.template;
      }
      // Sólo se espera para reintentar si la prueba fue concluyente (no por un corte de red).
      if (!r.network) {
        if (this.healAttempts.size > 1000) this.healAttempts.clear();
        this.healAttempts.set(cameraId, Date.now());
      }
      return null;
    })().finally(() => {
      this.healing = null;
    });
    return this.healing;
  }

  private async snapshotWith(template: string, cameraId: string, req: ImageRequest = {}): Promise<Snapshot> {
    try {
      const snap = await this.snapshotOnce(template, cameraId, req);
      if (req.live) this.liveFailures = 0;
      return snap;
    } catch (e) {
      // Los cuadros en vivo son muchos: sólo una racha larga de fallas indica un problema del servidor.
      if (req.live && !(e instanceof ExacqError && e.kind === "aborted") && ++this.liveFailures >= LIVE_FAILURES_TO_MARK) {
        this.liveFailures = 0;
        this.markError(e);
      }
      throw e;
    }
  }

  private async snapshotOnce(template: string, cameraId: string, req: ImageRequest): Promise<Snapshot> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const s = await this.sessionId();
      let url = this.fill(template, s, cameraId, req.quality);
      if (req.extra) url += (url.includes("?") ? "&" : "?") + fillExtra(req.extra, { w: req.w, h: req.h, q: req.quality });
      const res = await this.fetchRaw(this.url(url), { signal: req.signal }, req.timeoutMs ?? TIMEOUT_MS, { live: req.live });
      const ct = res.headers.get("content-type") ?? "";
      if (res.ok && ct.startsWith("image/")) {
        let data: Buffer;
        try {
          data = Buffer.from(await res.arrayBuffer());
        } catch (err) {
          if (req.signal?.aborted) throw new ExacqError("Pedido cancelado", "aborted");
          throw new ExacqError(`Imagen incompleta: ${describeNetworkError(err, this.cfg.baseUrl, req.timeoutMs ?? TIMEOUT_MS)}`, "network");
        }
        const info = req.live ? parseJpegInfo(data) : null;
        return { data, contentType: ct.split(";")[0]!, ts: Date.now(), ...(info ? { width: info.width, height: info.height } : {}) };
      }
      await res.body?.cancel().catch(() => undefined);
      if (attempt === 0 && (res.status === 401 || res.status === 403 || ct.includes("json") || ct.includes("html"))) {
        this.session = null;
        continue;
      }
      throw new ExacqError(`Snapshot HTTP ${res.status} (${ct || "sin content-type"})`, "protocol", res.status);
    }
    throw new ExacqError("No se obtuvo imagen: revise la plantilla de snapshot del servidor", "protocol");
  }

  async liveStream(cameraId: string): Promise<(LiveStream & { body: Readable }) | null> {
    return this.cfg.liveTemplate ? this.liveWith(this.cfg.liveTemplate, cameraId) : null;
  }

  private async liveWith(template: string, cameraId: string): Promise<(LiveStream & { body: Readable }) | null> {
    const s = await this.sessionId();
    const ac = new AbortController();
    const res = await this.fetchRaw(this.url(this.fill(template, s, cameraId)), { signal: ac.signal }, null);
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
      this.applyTemplates({ snapshot: result.snapshot ?? undefined, live: result.live ?? undefined }, "detect");
      result.applied = Boolean(result.snapshot || result.live);
    }
    return result;
  }

  /**
   * Diagnóstico paso a paso para el botón "Probar": conexión → login → cámaras → imagen.
   * Es de sólo lectura: si la URL de imagen no responde, informa cuál funciona pero no la guarda.
   */
  async diagnose(): Promise<Diagnosis> {
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

    // Login nuevo (no la sesión en caché) para verificar de verdad las credenciales guardadas.
    const login = await run(
      "Inicio de sesión",
      async () => {
        const old = this.session;
        this.session = null;
        const fresh = await this.login();
        if (old && old !== fresh) void this.logoutSession(old);
        return fresh;
      },
      () => "Credenciales aceptadas",
    );
    if (!login) return out;

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
    const active = this.activeSnapshotTemplate();
    out.snapshotTemplate = active;
    const snap = await run(
      `Imagen en vivo (${cam.name})`,
      () => this.snapshotWith(active, cam.cameraId),
      (img) => `${Math.round(img.data.length / 1024)} KB ${img.contentType}`,
    );
    if (!snap) {
      const probe = await this.probeSnapshotCandidates(cam.cameraId, active);
      if (probe.template) {
        out.workingSnapshotTemplate = probe.template;
        const step = steps[steps.length - 1]!;
        if (this.canAutoHeal()) {
          // El video funcionará igual: la primera imagen que pida un visor adopta esta URL.
          step.ok = true;
          step.detail = `La URL configurada no responde en esta versión; se usará automáticamente ${probe.template}`;
        } else {
          step.detail += ` · Funciona ${probe.template}: un administrador puede guardarla con "Detectar video".`;
        }
      }
    }
    out.ok = steps.every((s) => s.ok);
    return out;
  }

  private async logoutSession(session: string) {
    await this.fetchRaw(this.url(`v1/logout.web?${new URLSearchParams({ s: session })}`), { method: "POST" })
      .then((r) => r.body?.cancel())
      .catch(() => undefined);
  }

  async dispose() {
    if (!this.session) return;
    const s = this.session;
    this.session = null;
    await this.logoutSession(s);
  }
}
