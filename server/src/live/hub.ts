import zlib from "node:zlib";
import type { AppConfig } from "../config.js";
import type { LiveProfile } from "../exacq/live-profile.js";
import type { Snapshot, SnapshotOpts, VideoSource } from "../exacq/types.js";
import type { Bus, RealtimeMessage } from "../realtime/bus.js";
import { parseJpegInfo } from "../video/jpeg.js";
import { FLAG_BUDGET_LIMITED, FLAG_CACHED, FLAG_NATIVE_FALLBACK, FLAG_SCALED, qualityForTier, type LiveStateName } from "./protocol.js";

/**
 * LiveHub: un único lazo de pedidos al servidor de video por cámara, compartido por todos los
 * visores (WebSocket /api/live, snapshots HTTP con ?w=, MJPEG y el motor de detección).
 *
 * - Pipelining: hasta P pedidos en vuelo por cámara (cuadros por segundo ≈ P / RTT).
 * - Nunca entrega un cuadro más viejo que uno ya entregado; descarta cuadros repetidos (CRC) y
 *   baja el ritmo si la cámara produce menos cuadros que los pedidos.
 * - Por servidor exacq: semáforo con prioridad (vista ampliada primero), gobernador de ancho de
 *   banda / pedidos por segundo que reduce el ritmo de la grilla y disyuntor ante fallas.
 * - Período de gracia tras el último visor y caché del último cuadro (se envía al volver).
 */

export interface LiveCfg {
  gridMaxFps: number;
  focusMaxFps: number;
  pipelineGrid: number;
  pipelineFocus: number;
  frameTimeoutMs: number;
  idleGraceMs: number;
  latestTtlMs: number;
  maxConcurrentPerServer: number;
  maxUpstreamFpsPerServer: number;
  maxUpstreamMbps: number;
}

export function liveCfgFrom(cfg: AppConfig): LiveCfg {
  return {
    gridMaxFps: cfg.LIVE_GRID_MAX_FPS,
    focusMaxFps: cfg.LIVE_FOCUS_MAX_FPS,
    pipelineGrid: Math.max(1, cfg.LIVE_PIPELINE_GRID),
    pipelineFocus: Math.max(1, cfg.LIVE_PIPELINE_FOCUS),
    frameTimeoutMs: Math.max(500, cfg.LIVE_FRAME_TIMEOUT_MS),
    idleGraceMs: Math.max(0, cfg.LIVE_IDLE_GRACE_MS),
    latestTtlMs: Math.max(0, cfg.LIVE_LATEST_TTL_MS),
    maxConcurrentPerServer: Math.max(1, cfg.LIVE_MAX_CONCURRENT_PER_SERVER),
    maxUpstreamFpsPerServer: Math.max(1, cfg.LIVE_MAX_UPSTREAM_FPS_PER_SERVER),
    maxUpstreamMbps: Math.max(1, cfg.LIVE_MAX_UPSTREAM_MBPS),
  };
}

export type Prio = "grid" | "focus";

export interface LiveSpec {
  fps: number;
  /** Ancho pedido (escalón de TIERS); 0 = resolución nativa. */
  tierW: number;
  prio: Prio;
}

export interface LiveFrame {
  key: string;
  data: Buffer;
  w: number;
  h: number;
  /** Instante estimado de captura (epoch ms del servidor): emisión + RTT/2. */
  tCap: number;
  upMs: number;
  tierW: number;
  native: boolean;
  flags: number;
  issueSeq: number;
}

export interface LiveState {
  st: LiveStateName;
  effFps: number;
  limited: boolean;
  code?: string;
}

export interface LiveSink {
  onFrame(f: LiveFrame): void;
  onState(s: LiveState): void;
}

export interface LiveHandle {
  update(spec: Partial<LiveSpec>): void;
  close(): void;
}

/** Lo que el hub necesita del servicio de cámaras (CameraService cumple esta interfaz). */
export interface HubCameras {
  resolve(key: string): { row: { id: string; server_id: string; camera_id: string; enabled: number; online: number }; source: VideoSource };
  row(key: string): { enabled: number; online: number } | undefined;
  liveFrame(key: string, opts: Omit<SnapshotOpts, "live">): Promise<Snapshot>;
  liveProfile?(serverId: string): LiveProfile | null;
}

export interface HubDeps {
  /** Reloj inyectable (pruebas). */
  now?: () => number;
  /** Se llama la primera vez que el hub usa un servidor exacq (prueba automática del perfil). */
  ensureProfile?: (serverId: string) => void;
}

class TimeoutError extends Error {}

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
const errStatus = (e: unknown) => (e as { statusCode?: number })?.statusCode;
const httpError = (status: number, message: string) => Object.assign(new Error(message), { statusCode: status });

function percentile(xs: number[], p: number) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

interface Sub {
  spec: LiveSpec;
  sink: LiveSink;
  lastDeliveredAt: number;
}

interface Waiter {
  tierW: number;
  resolve: (f: LiveFrame) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface Demand {
  fps: number;
  tierW: number;
  prio: Prio;
}

/** Semáforo + gobernador + disyuntor de un servidor de video. */
class ServerGate {
  active = 0;
  capacity: number;
  private queue: Array<{ loop: CameraLoop; prio: Prio; dueAt: number }> = [];
  gridScale = 1;
  upBps = 0;
  reqPerSec = 0;
  private bytesAcc = 0;
  private reqAcc = 0;
  private lastTick: number;
  private rtts: number[] = [];
  rttEwma = 0;
  private outcomes: Array<{ t: number; ok: boolean }> = [];
  breakerUntil = 0;
  private halfOpen = false;
  private halfOpenBusy = false;
  private pumpTimer?: NodeJS.Timeout;
  stale = 0;
  dup = 0;
  errors = 0;
  frames = 0;

  constructor(
    readonly id: string,
    private hub: LiveHub,
  ) {
    this.capacity = hub.cfg.maxConcurrentPerServer;
    this.lastTick = hub.now();
  }

  get queued() {
    return this.queue.length;
  }

  breakerState(): "closed" | "open" | "half-open" {
    if (this.hub.now() < this.breakerUntil) return "open";
    return this.halfOpen ? "half-open" : "closed";
  }

  private allows() {
    const now = this.hub.now();
    if (now < this.breakerUntil) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = setTimeout(() => this.pump(), this.breakerUntil - now + 5);
      this.pumpTimer.unref?.();
      return false;
    }
    return !(this.halfOpen && this.halfOpenBusy);
  }

  private start() {
    this.active++;
    this.reqAcc++;
    if (this.halfOpen) this.halfOpenBusy = true;
  }

  tryAcquire(loop: CameraLoop, prio: Prio, dueAt: number): boolean {
    this.capacity = this.hub.capacityFor(this.id);
    if (this.active < this.capacity && !this.queue.length && this.allows()) {
      this.start();
      return true;
    }
    if (!this.queue.some((q) => q.loop === loop)) this.queue.push({ loop, prio, dueAt });
    this.pump();
    return false;
  }

  dequeue(loop: CameraLoop) {
    this.queue = this.queue.filter((q) => q.loop !== loop);
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    this.pump();
  }

  /** Concede lugares libres: primero vista ampliada, luego la cámara de grilla más atrasada. */
  pump() {
    while (this.active < this.capacity && this.queue.length && this.allows()) {
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) {
        const a = this.queue[i]!;
        const b = this.queue[best]!;
        if ((a.prio === "focus" && b.prio !== "focus") || (a.prio === b.prio && a.dueAt < b.dueAt)) best = i;
      }
      const [entry] = this.queue.splice(best, 1);
      this.start();
      entry!.loop.onGrant();
    }
  }

  recordFrame(bytes: number, rttMs: number) {
    this.bytesAcc += bytes;
    this.frames++;
    this.rttEwma = this.rttEwma ? 0.8 * this.rttEwma + 0.2 * rttMs : rttMs;
    this.rtts.push(rttMs);
    if (this.rtts.length > 200) this.rtts.splice(0, this.rtts.length - 200);
  }

  /** Disyuntor: más de 50 % de fallas en 10 s → abierto 3 s; luego un único pedido de prueba. */
  recordOutcome(ok: boolean) {
    const now = this.hub.now();
    if (now < this.breakerUntil) return; // abierto: se ignoran respuestas de pedidos anteriores
    if (this.halfOpen) {
      if (!this.halfOpenBusy) return;
      this.halfOpen = false;
      this.halfOpenBusy = false;
      if (!ok) this.open(now);
      else this.pump();
      return;
    }
    this.outcomes.push({ t: now, ok });
    this.outcomes = this.outcomes.filter((o) => now - o.t <= 10_000);
    const failed = this.outcomes.filter((o) => !o.ok).length;
    if (this.outcomes.length >= 4 && failed / this.outcomes.length > 0.5) this.open(now);
  }

  private open(now: number) {
    this.breakerUntil = now + 3000;
    this.halfOpen = true;
    this.halfOpenBusy = false;
    this.outcomes = [];
  }

  /** Gobernador (cada ~1 s): ajusta la escala de cuadros por segundo de la grilla. */
  tick() {
    const now = this.hub.now();
    const dt = Math.max(1, now - this.lastTick);
    this.lastTick = now;
    const bps = (this.bytesAcc * 1000) / dt;
    const rps = (this.reqAcc * 1000) / dt;
    this.bytesAcc = 0;
    this.reqAcc = 0;
    this.upBps = 0.5 * this.upBps + 0.5 * bps;
    this.reqPerSec = 0.5 * this.reqPerSec + 0.5 * rps;
    const budget = this.hub.cfg.maxUpstreamMbps * 125_000;
    const maxReq = this.hub.cfg.maxUpstreamFpsPerServer;
    if (this.upBps > budget || this.reqPerSec > maxReq || this.rttEwma > 1500) this.gridScale = Math.max(0.25, this.gridScale * 0.8);
    else if (this.upBps < 0.7 * budget && this.reqPerSec < 0.7 * maxReq) this.gridScale = Math.min(1, this.gridScale * 1.1);
  }

  stats(loops: CameraLoop[]) {
    return {
      id: this.id,
      loops: loops.length,
      inFlight: loops.reduce((n, l) => n + l.inFlightCount, 0),
      active: this.active,
      capacity: this.capacity,
      queued: this.queue.length,
      upFps: Math.round(this.reqPerSec * 10) / 10,
      upMbps: Math.round(((this.upBps * 8) / 1e6) * 100) / 100,
      rttP50: percentile(this.rtts, 50),
      rttP95: percentile(this.rtts, 95),
      gridScale: Math.round(this.gridScale * 100) / 100,
      breaker: this.breakerState(),
      frames: this.frames,
      stale: this.stale,
      dup: this.dup,
      errors: this.errors,
    };
  }

  dispose() {
    clearTimeout(this.pumpTimer);
    this.queue = [];
  }
}

/** Lazo de pedidos de una cámara mientras tenga visores (o dentro del período de gracia). */
class CameraLoop {
  readonly subs = new Set<Sub>();
  private pullDemand: (Demand & { expiresAt: number }) | null = null;
  private waiters: Waiter[] = [];
  private inFlight = new Map<number, AbortController>();
  private issueSeq = 0;
  private acceptedSeq = 0;
  private lastIssueAt = -Infinity;
  private backoffUntil = 0;
  private failures = 0;
  rttEwma = 0;
  uniqueFps: number;
  private lastUniqueAt = 0;
  private lastCrc = -1;
  private queued = false;
  private timer?: NodeJS.Timeout;
  private idleSince: number | null = null;
  state: LiveStateName = "starting";
  private stateCode?: string;
  private lastLimited = false;
  nativeW = 0;
  nativeH = 0;
  private resizeMiss = 0;
  resizeIgnored = false;
  avgBytes = 0;
  stopped = false;
  latest?: LiveFrame;
  lastEffFps = 0;
  dup = 0;
  stale = 0;
  errors = 0;

  constructor(
    readonly key: string,
    readonly serverId: string,
    private gate: ServerGate,
    private hub: LiveHub,
  ) {
    this.uniqueFps = hub.cfg.focusMaxFps;
  }

  get inFlightCount() {
    return this.inFlight.size;
  }

  /** Demanda combinada de suscriptores y pedidos HTTP recientes (pull). */
  demand(now = this.hub.now()): Demand | null {
    let fps = 0;
    let tier = -1;
    let prio: Prio = "grid";
    const add = (d: Demand) => {
      fps = Math.max(fps, d.fps);
      tier = tier === 0 || d.tierW === 0 ? 0 : Math.max(tier, d.tierW);
      if (d.prio === "focus") prio = "focus";
    };
    for (const s of this.subs) add(s.spec);
    if (this.pullDemand && this.pullDemand.expiresAt > now) add(this.pullDemand);
    else this.pullDemand = null;
    if (tier < 0) return null;
    return { fps: Math.max(0.1, fps), tierW: tier, prio };
  }

  effFps(d: Demand) {
    const scale = d.prio === "grid" ? this.gate.gridScale : 1;
    const eff = Math.min(d.fps * scale, this.uniqueFps * 1.25);
    return Math.max(Math.min(0.5, d.fps), eff);
  }

  private pipeline(d: Demand) {
    const profile = this.hub.profileFor(this.serverId);
    if (profile && !profile.pipeline.ok) return 1;
    return d.prio === "focus" ? this.hub.cfg.pipelineFocus : this.hub.cfg.pipelineGrid;
  }

  limited(d: Demand | null) {
    return Boolean(d && d.prio === "grid" && this.gate.gridScale < 0.999);
  }

  currentState(): LiveState {
    const d = this.demand();
    return { st: this.state, effFps: d ? Math.round(this.effFps(d) * 10) / 10 : 0, limited: this.limited(d), ...(this.stateCode ? { code: this.stateCode } : {}) };
  }

  setState(st: LiveStateName, code?: string, force = false) {
    const d = this.demand();
    const limited = this.limited(d);
    if (!force && st === this.state && code === this.stateCode && limited === this.lastLimited) return;
    this.state = st;
    this.stateCode = code;
    this.lastLimited = limited;
    const s = this.currentState();
    for (const sub of this.subs) {
      try {
        sub.sink.onState(s);
      } catch {
        /* un visor roto no afecta a los demás */
      }
    }
  }

  /** Estado de la cámara en la base (deshabilitada / sin señal). */
  refreshRow() {
    const row = this.hub.cameras.row(this.key);
    if (!row) return this.setState("error", "not_found");
    if (!row.enabled) return this.setState("disabled");
    if (!row.online) return this.setState("offline");
    if (this.state === "offline" || this.state === "disabled" || this.state === "error") this.setState("starting");
  }

  setOnline(online: boolean) {
    if (online) {
      if (this.state === "offline") this.setState("starting");
    } else {
      this.setState("offline");
      this.abortAll();
    }
    this.schedule();
  }

  addPull(d: Demand) {
    const now = this.hub.now();
    const cur = this.pullDemand && this.pullDemand.expiresAt > now ? this.pullDemand : null;
    this.pullDemand = {
      fps: Math.max(cur?.fps ?? 0, d.fps),
      tierW: cur ? (cur.tierW === 0 || d.tierW === 0 ? 0 : Math.max(cur.tierW, d.tierW)) : d.tierW,
      prio: "grid",
      expiresAt: now + 3000,
    };
  }

  addWaiter(tierW: number, timeoutMs: number): Promise<LiveFrame> {
    return new Promise((resolve, reject) => {
      const w: Waiter = {
        tierW,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((x) => x !== w);
          reject(httpError(504, "La cámara no entregó imagen a tiempo"));
        }, timeoutMs),
      };
      this.waiters.push(w);
      this.schedule();
    });
  }

  private rejectWaiters(err: Error) {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  /** Planificador: un único temporizador hasta el próximo pedido debido. */
  schedule() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    const now = this.hub.now();
    const d = this.demand(now);
    if (!d && !this.waiters.length) {
      if (this.idleSince === null) this.idleSince = now;
      const left = this.idleSince + this.hub.cfg.idleGraceMs - now;
      if (left <= 0) return this.hub.stopLoop(this);
      this.timer = setTimeout(() => this.schedule(), Math.max(20, left));
      this.timer.unref?.();
      return;
    }
    this.idleSince = null;
    if (this.state === "offline" || this.state === "disabled" || this.state === "error") {
      // Sin pedidos al servidor: se revisa la base cada 5 s (o al llegar camera.status).
      this.timer = setTimeout(() => {
        this.refreshRow();
        this.schedule();
      }, 5000);
      this.timer.unref?.();
      return;
    }
    const demand = d ?? { fps: 1, tierW: 0, prio: "grid" as Prio };
    const p = this.pipeline(demand);
    if (this.inFlight.size >= p || this.queued) return; // al terminar un pedido se vuelve a planificar
    const eff = this.effFps(demand);
    this.lastEffFps = eff;
    const gap = Math.max(1000 / eff, this.rttEwma / p);
    const due = Math.max(this.lastIssueAt + gap, this.backoffUntil);
    if (now < due) {
      this.timer = setTimeout(() => this.schedule(), Math.max(1, due - now));
      this.timer.unref?.();
      return;
    }
    if (this.gate.tryAcquire(this, demand.prio, due)) this.issue(demand);
    else this.queued = true;
  }

  /** El semáforo concedió un lugar a este lazo. */
  onGrant() {
    this.queued = false;
    const d = this.demand();
    if (this.stopped || (!d && !this.waiters.length) || this.state === "offline" || this.state === "disabled" || this.state === "error") {
      this.gate.release();
      this.schedule();
      return;
    }
    this.issue(d ?? { fps: 1, tierW: 0, prio: "grid" });
  }

  /** Parámetros de tamaño/calidad para el servidor según el perfil y la resolución nativa conocida. */
  private requestFor(d: Demand): { width?: number; height?: number; quality?: number } {
    const profile = this.hub.profileFor(this.serverId);
    const quality = profile?.quality ? qualityForTier(d.tierW) : undefined;
    if (!profile?.resize || this.resizeIgnored || d.tierW === 0) return { quality };
    if (profile.resize.kind === "fixed") {
      const fixedW = profile.resize.verified[0]?.gotW ?? 0;
      if (fixedW && d.tierW > fixedW * 1.25) return { quality };
      return { width: d.tierW, quality };
    }
    if (this.nativeW && this.nativeW <= d.tierW) return { quality };
    const ratio = this.nativeW && this.nativeH ? this.nativeH / this.nativeW : 9 / 16;
    return { width: d.tierW, height: even(d.tierW * ratio), quality };
  }

  private issue(d: Demand) {
    const seq = ++this.issueSeq;
    const t0 = this.hub.now();
    this.lastIssueAt = t0;
    const ac = new AbortController();
    this.inFlight.set(seq, ac);
    const req = this.requestFor(d);
    let timer: NodeJS.Timeout | undefined;
    // Tiempo máximo propio (por si la fuente ignora la señal) y corte inmediato al cancelar.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError("timeout")), this.hub.cfg.frameTimeoutMs + 250);
      ac.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    const upstream = this.hub.cameras.liveFrame(this.key, { ...req, signal: ac.signal, timeoutMs: this.hub.cfg.frameTimeoutMs });
    upstream.catch(() => undefined); // si gana el tiempo máximo, la respuesta tardía se ignora
    Promise.race([upstream, timeout])
      .then(
        (snap) => this.onResponse(seq, snap, t0, d, req.width),
        (err) => this.onError(seq, err, ac),
      )
      .finally(() => {
        clearTimeout(timer);
        if (this.inFlight.get(seq) === ac) this.inFlight.delete(seq);
        this.gate.release();
        this.schedule();
      });
    // Pipelining: puede corresponder otro pedido antes de que vuelva éste.
    this.schedule();
  }

  private onResponse(seq: number, snap: Snapshot, t0: number, d: Demand, requestedW?: number) {
    if (this.stopped || !this.inFlight.has(seq)) return;
    const now = this.hub.now();
    const up = Math.max(1, now - t0);
    this.rttEwma = this.rttEwma ? 0.8 * this.rttEwma + 0.2 * up : up;
    this.gate.recordFrame(snap.data.length, up);
    this.gate.recordOutcome(true);
    if (seq <= this.acceptedSeq) {
      // Llegó después de uno más nuevo: nunca se entrega fuera de orden.
      this.stale++;
      this.gate.stale++;
      return;
    }
    const info = parseJpegInfo(snap.data);
    if (!info) return this.fail(new Error("Cuadro JPEG inválido"), "bad_frame");
    this.acceptedSeq = seq;
    this.failures = 0;
    const crc = zlib.crc32(snap.data);
    const sinceUnique = this.lastUniqueAt ? Math.max(1, now - this.lastUniqueAt) : 0;
    if (crc === this.lastCrc) {
      // Cuadro repetido: la cámara entrega menos cuadros de los pedidos → se baja el ritmo.
      this.dup++;
      this.gate.dup++;
      if (sinceUnique) this.uniqueFps = 0.7 * this.uniqueFps + 0.3 * Math.min(this.uniqueFps, 1000 / sinceUnique);
      if (this.state !== "live") this.setState("live");
      return;
    }
    this.lastCrc = crc;
    if (sinceUnique) this.uniqueFps = Math.min(this.hub.cfg.focusMaxFps * 2, 0.7 * this.uniqueFps + 0.3 * (1000 / sinceUnique));
    this.lastUniqueAt = now;

    const native = !requestedW || info.width > requestedW * 1.25;
    if (requestedW && native) {
      if (++this.resizeMiss >= 3) this.resizeIgnored = true; // el servidor ignora el tamaño pedido
    } else if (requestedW) this.resizeMiss = 0;
    if (native) {
      this.nativeW = info.width;
      this.nativeH = info.height;
    }
    let flags = 0;
    if (!native) flags |= FLAG_SCALED;
    if (requestedW && native) flags |= FLAG_NATIVE_FALLBACK;
    if (this.limited(d)) flags |= FLAG_BUDGET_LIMITED;
    const frame: LiveFrame = { key: this.key, data: snap.data, w: info.width, h: info.height, tCap: t0 + up / 2, upMs: up, tierW: d.tierW, native, flags, issueSeq: seq };
    this.avgBytes = this.avgBytes ? 0.8 * this.avgBytes + 0.2 * snap.data.length : snap.data.length;
    this.latest = frame;
    this.hub.setLatest(frame);
    this.setState("live");
    for (const sub of this.subs) {
      if (now - sub.lastDeliveredAt < (0.9 * 1000) / Math.max(0.1, sub.spec.fps)) continue; // decimación por visor
      sub.lastDeliveredAt = now;
      try {
        sub.sink.onFrame(frame);
      } catch {
        /* un visor roto no afecta a los demás */
      }
    }
    if (this.waiters.length) {
      const keep: Waiter[] = [];
      for (const w of this.waiters) {
        if (frameServes(frame, w.tierW)) {
          clearTimeout(w.timer);
          w.resolve(frame);
        } else keep.push(w);
      }
      this.waiters = keep;
    }
  }

  private onError(seq: number, err: unknown, ac: AbortController) {
    const timedOut = err instanceof TimeoutError;
    if (timedOut) ac.abort();
    else if (ac.signal.aborted || (err as { kind?: string })?.kind === "aborted") return; // cancelado por el hub: no es falla
    if (this.stopped || !this.inFlight.has(seq)) return;
    const status = errStatus(err);
    if (status === 404) {
      this.setState("error", "not_found");
      this.rejectWaiters(httpError(404, "Cámara inexistente"));
      return;
    }
    if (status === 503) {
      this.setState("error", "server_inactive");
      this.rejectWaiters(httpError(503, "El servidor de esta cámara no está activo"));
      return;
    }
    const kind = (err as { kind?: string })?.kind;
    this.gate.recordOutcome(false);
    this.fail(err as Error, timedOut || kind === "network" ? "timeout" : "upstream");
  }

  private fail(_err: Error, code: string) {
    this.failures++;
    this.errors++;
    this.gate.errors++;
    this.backoffUntil = this.hub.now() + Math.min(5000, 250 * 2 ** this.failures);
    if (this.failures >= 3) {
      if (this.state !== "stalled") this.setState("stalled", code);
      this.rejectWaiters(httpError(502, "Sin imagen de la cámara"));
    }
  }

  private abortAll() {
    for (const ac of this.inFlight.values()) ac.abort();
    this.inFlight.clear();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.abortAll();
    this.gate.dequeue(this);
    this.rejectWaiters(httpError(503, "Video en vivo detenido"));
  }

  stats() {
    const d = this.demand();
    return {
      key: this.key,
      server: this.serverId,
      subs: this.subs.size,
      pull: Boolean(this.pullDemand),
      state: this.state,
      prio: d?.prio ?? null,
      targetFps: d ? Math.round(d.fps * 10) / 10 : 0,
      effFps: d ? Math.round(this.effFps(d) * 10) / 10 : 0,
      tierW: d?.tierW ?? null,
      w: this.latest?.w ?? null,
      h: this.latest?.h ?? null,
      native: this.latest?.native ?? null,
      resizeIgnored: this.resizeIgnored,
      avgBytes: Math.round(this.avgBytes),
      rttMs: Math.round(this.rttEwma),
      inFlight: this.inFlight.size,
      dup: this.dup,
      stale: this.stale,
      errors: this.errors,
    };
  }
}

/** ¿El cuadro sirve para un pedido de ese ancho? */
function frameServes(f: LiveFrame, tierW: number) {
  if (f.native) return true;
  if (tierW === 0) return false;
  return f.w >= tierW * 0.75;
}

export class LiveHub {
  readonly now: () => number;
  private loops = new Map<string, CameraLoop>();
  private gates = new Map<string, ServerGate>();
  private latest = new Map<string, LiveFrame>();
  private governor: NodeJS.Timeout;
  private onBus = (msg: RealtimeMessage) => {
    if (msg.topic !== "camera.status") return;
    const data = msg.data as { id?: string; online?: boolean };
    if (data?.id) this.loops.get(data.id)?.setOnline(Boolean(data.online));
  };

  constructor(
    readonly cameras: HubCameras,
    private bus: Bus | null,
    readonly cfg: LiveCfg,
    private deps: HubDeps = {},
  ) {
    this.now = deps.now ?? Date.now;
    bus?.on("message", this.onBus);
    this.governor = setInterval(() => this.tick(), 1000);
    this.governor.unref();
  }

  /** Gobernador y limpieza de la caché de últimos cuadros (también se puede llamar en pruebas). */
  tick() {
    for (const g of this.gates.values()) g.tick();
    const now = this.now();
    for (const [key, f] of this.latest) if (!this.loops.has(key) && now - f.tCap > this.cfg.latestTtlMs) this.latest.delete(key);
  }

  profileFor(serverId: string): LiveProfile | null {
    return this.cameras.liveProfile?.(serverId) ?? null;
  }

  capacityFor(serverId: string) {
    return Math.max(1, this.profileFor(serverId)?.recommendedConcurrency ?? this.cfg.maxConcurrentPerServer);
  }

  private gateFor(serverId: string) {
    let g = this.gates.get(serverId);
    if (!g) {
      g = new ServerGate(serverId, this);
      this.gates.set(serverId, g);
    }
    return g;
  }

  private loopFor(key: string): CameraLoop {
    let loop = this.loops.get(key);
    if (loop) return loop;
    const { row, source } = this.cameras.resolve(key); // lanza 404/503
    loop = new CameraLoop(key, row.server_id, this.gateFor(row.server_id), this);
    this.loops.set(key, loop);
    if (source.kind === "exacq") this.deps.ensureProfile?.(row.server_id);
    return loop;
  }

  setLatest(f: LiveFrame) {
    this.latest.set(f.key, f);
  }

  stopLoop(loop: CameraLoop) {
    loop.stop();
    if (this.loops.get(loop.key) === loop) this.loops.delete(loop.key);
  }

  private fresh(key: string) {
    const f = this.loops.get(key)?.latest ?? this.latest.get(key);
    return f && this.now() - f.tCap <= this.cfg.latestTtlMs ? f : undefined;
  }

  private normalize(spec: Partial<LiveSpec>, prev?: LiveSpec): LiveSpec {
    const prio: Prio = spec.prio ?? prev?.prio ?? "grid";
    const max = prio === "focus" ? this.cfg.focusMaxFps : this.cfg.gridMaxFps;
    const fps = Math.min(max, Math.max(0.1, Number(spec.fps ?? prev?.fps ?? 1) || 1));
    const tierW = Math.max(0, Math.round(Number(spec.tierW ?? prev?.tierW ?? 0) || 0));
    return { fps, tierW, prio };
  }

  /** Suscripción continua (WebSocket, MJPEG). */
  subscribe(key: string, spec: Partial<LiveSpec>, sink: LiveSink): LiveHandle {
    let loop: CameraLoop;
    try {
      loop = this.loopFor(key);
    } catch (e) {
      sink.onState({ st: "error", effFps: 0, limited: false, code: errStatus(e) === 503 ? "server_inactive" : "not_found" });
      return { update: () => undefined, close: () => undefined };
    }
    const sub: Sub = { spec: this.normalize(spec), sink, lastDeliveredAt: 0 };
    loop.refreshRow();
    loop.subs.add(sub);
    loop.uniqueFps = Math.max(loop.uniqueFps, sub.spec.fps);
    sink.onState(loop.currentState());
    const cached = this.fresh(key);
    if (cached) {
      sub.lastDeliveredAt = this.now();
      sink.onFrame({ ...cached, flags: cached.flags | FLAG_CACHED });
    }
    loop.schedule();
    let closed = false;
    return {
      update: (s) => {
        if (closed) return;
        sub.spec = this.normalize(s, sub.spec);
        loop.uniqueFps = Math.max(loop.uniqueFps, sub.spec.fps);
        loop.schedule();
      },
      close: () => {
        if (closed) return;
        closed = true;
        loop.subs.delete(sub);
        loop.schedule();
      },
    };
  }

  /**
   * Cuadro puntual (HTTP con ?w=, detección): comparte el lazo de la cámara y lo mantiene activo
   * hasta 3 s después del último pedido.
   */
  async pull(key: string, opts: { tierW: number; fps: number; maxAgeMs: number; timeoutMs?: number }): Promise<LiveFrame> {
    const loop = this.loopFor(key);
    loop.refreshRow();
    if (loop.state === "disabled") throw httpError(409, "Cámara deshabilitada");
    if (loop.state === "offline") throw httpError(503, "Cámara sin señal");
    if (loop.state === "error") throw httpError(404, "Cámara inexistente");
    const tierW = Math.max(0, Math.round(opts.tierW) || 0);
    loop.addPull({ fps: Math.min(this.cfg.gridMaxFps, Math.max(0.1, opts.fps || 1)), tierW, prio: "grid" });
    const f = this.fresh(key);
    if (f && this.now() - f.tCap <= opts.maxAgeMs && frameServes(f, tierW)) {
      loop.schedule();
      return f;
    }
    return loop.addWaiter(tierW, opts.timeoutMs ?? this.cfg.frameTimeoutMs);
  }

  /** Último cuadro conocido (si no venció). */
  peek(key: string): LiveFrame | undefined {
    return this.fresh(key);
  }

  stats() {
    const loops = [...this.loops.values()];
    return {
      servers: [...this.gates.values()].map((g) => g.stats(loops.filter((l) => l.serverId === g.id))),
      cameras: loops.map((l) => l.stats()),
    };
  }

  stop() {
    clearInterval(this.governor);
    this.bus?.off("message", this.onBus);
    for (const loop of this.loops.values()) loop.stop();
    this.loops.clear();
    for (const g of this.gates.values()) g.dispose();
  }
}
