import { api } from "./api";
import { decodeHeader, type DecodedFrame, type FrameMeta, type Prio, type ServerMessage, type ServerState } from "./live-protocol";

/**
 * Cliente único del video en vivo: un solo WebSocket (/api/live) para todas las cámaras visibles,
 * que sobrevive a la navegación entre páginas. Decodifica fuera del hilo principal
 * (createImageBitmap), pinta en un único requestAnimationFrame y confirma (ack) cada cuadro
 * pintado: el servidor nunca envía más de lo que el navegador alcanza a mostrar.
 * Si el WebSocket no está disponible (proxy, navegador), las vistas pasan a HTTP (modo "fallback").
 */

export type LiveMode = "ws" | "fallback";

export type LiveImageSource = ImageBitmap | HTMLImageElement;

export interface LiveSubOptions {
  fps: number;
  maxW: number;
  prio: Prio;
}

export interface LiveSubHandlers {
  /** Se llama dentro del requestAnimationFrame. Devolver true conserva la imagen (el llamador la cierra). */
  draw(img: LiveImageSource, meta: FrameMeta & { ageMs: number; decodeMs: number }): boolean | void;
  onState?(s: ServerState): void;
  onError?(code: string): void;
  /** Tamaño del lienzo en píxeles (para decodificar ya reducido si el cuadro es mucho más grande). */
  targetSize?(): { w: number; h: number } | null;
}

export interface LiveSubscription {
  update(opts: Partial<LiveSubOptions>): void;
  close(): void;
}

interface ClientSub {
  id: number;
  cam: string;
  opts: LiveSubOptions;
  h: LiveSubHandlers;
  gen: number;
  decoding: boolean;
  pending: DecodedFrame | null;
  ready: { img: LiveImageSource; meta: FrameMeta; decodeMs: number; gen: number } | null;
  lastPaintedSeq: number;
  closed: boolean;
}

const now = () => performance.timeOrigin + performance.now();
const supported = () => typeof WebSocket !== "undefined" && typeof Blob !== "undefined";
const hasBitmap = () => typeof createImageBitmap === "function";

function closeImage(img: LiveImageSource) {
  if ("close" in img && typeof img.close === "function") img.close();
  else if (img instanceof HTMLImageElement && img.src.startsWith("blob:")) URL.revokeObjectURL(img.src);
}

/** Decodificación de respaldo (Safari < 15): <img> + decode(). */
async function decodeWithImage(blob: Blob): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = URL.createObjectURL(blob);
  try {
    await img.decode();
    return img;
  } catch (e) {
    URL.revokeObjectURL(img.src);
    throw e;
  }
}

class LiveClient {
  private ws: WebSocket | null = null;
  private opened = false;
  private subs = new Map<number, ClientSub>();
  private nextId = 1;
  private attempts = 0;
  private earlyFailures: number[] = [];
  /** Respaldo HTTP activo hasta que el WebSocket vuelva a abrir (se reintenta cada 60 s). */
  private fallback = false;
  private retryPending = false;
  private permanentFallback = !supported();
  private closeTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private paintRaf = 0;
  private paintTimer?: ReturnType<typeof setTimeout>;
  private acks: Array<[number, number, number]> = [];
  private offsets: number[] = [];
  private offset = 0;
  private modeListeners = new Set<() => void>();
  private stopped = false;

  /** Modo actual: WebSocket o respaldo HTTP. */
  get mode(): LiveMode {
    return this.permanentFallback || this.fallback ? "fallback" : "ws";
  }

  /** Diferencia de reloj servidor − navegador (ms), mediana de los últimos pings. */
  get clockOffset() {
    return this.offset;
  }

  onModeChange(fn: () => void) {
    this.modeListeners.add(fn);
    return () => this.modeListeners.delete(fn);
  }

  private emitMode() {
    for (const fn of this.modeListeners) fn();
  }

  subscribe(cam: string, opts: LiveSubOptions, h: LiveSubHandlers): LiveSubscription {
    this.stopped = false;
    clearTimeout(this.closeTimer);
    let id = this.nextId;
    for (let i = 0; i < 65535 && this.subs.has(id); i++) id = (id % 65535) + 1;
    this.nextId = (id % 65535) + 1;
    const sub: ClientSub = { id, cam, opts: { ...opts }, h, gen: 0, decoding: false, pending: null, ready: null, lastPaintedSeq: 0, closed: false };
    this.subs.set(id, sub);
    if (this.ws && this.opened) this.sendSub(sub);
    else this.ensureSocket();
    return {
      update: (o) => {
        if (sub.closed) return;
        const next = { ...sub.opts, ...o };
        if (next.fps === sub.opts.fps && next.maxW === sub.opts.maxW && next.prio === sub.opts.prio) return;
        sub.opts = next;
        this.send({ t: "upd", s: sub.id, fps: next.fps, maxW: next.maxW, prio: next.prio });
      },
      close: () => {
        if (sub.closed) return;
        sub.closed = true;
        if (sub.ready) closeImage(sub.ready.img);
        sub.ready = null;
        sub.pending = null;
        this.subs.delete(sub.id);
        this.send({ t: "unsub", s: sub.id });
        // El socket se cierra 15 s después de la última suscripción (cambios de página, ronda).
        if (!this.subs.size) {
          clearTimeout(this.closeTimer);
          this.closeTimer = setTimeout(() => this.closeSocket(), 15_000);
        }
      },
    };
  }

  /** Cierre de sesión: corta todo. */
  shutdown() {
    this.stopped = true;
    for (const sub of this.subs.values()) {
      sub.closed = true;
      if (sub.ready) closeImage(sub.ready.img);
    }
    this.subs.clear();
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.closeTimer);
    this.retryPending = false;
    this.closeSocket();
    this.earlyFailures = [];
    this.attempts = 0;
  }

  private send(msg: unknown) {
    if (this.ws && this.opened && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private sendSub(sub: ClientSub) {
    sub.gen++;
    sub.lastPaintedSeq = 0;
    sub.pending = null;
    this.send({ t: "sub", s: sub.id, cam: sub.cam, fps: sub.opts.fps, maxW: sub.opts.maxW, prio: sub.opts.prio });
  }

  private closeSocket() {
    clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = null;
    this.opened = false;
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.onopen = null;
      try {
        ws.close(1000);
      } catch {
        /* ya cerrado */
      }
    }
  }

  private ensureSocket() {
    if (this.ws || this.stopped || !this.subs.size || this.permanentFallback || this.retryPending) return;
    clearTimeout(this.reconnectTimer);
    this.connect();
  }

  private connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}://${location.host}/api/live`);
    } catch {
      this.permanentFallback = true;
      this.emitMode();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.opened = false;
    ws.onopen = () => {
      const wasFallback = this.fallback;
      this.opened = true;
      this.attempts = 0;
      this.earlyFailures = [];
      this.fallback = false;
      ws.send(JSON.stringify({ t: "hello", v: 1 }));
      for (const sub of this.subs.values()) this.sendSub(sub);
      this.ping();
      this.pingTimer = setInterval(() => this.ping(), 10_000);
      if (wasFallback) this.emitMode();
    };
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) this.onFrame(e.data);
      else this.onText(String(e.data));
    };
    ws.onerror = () => undefined;
    ws.onclose = (e) => this.onClose(e);
  }

  private ping() {
    this.send({ t: "ping", c: now() });
  }

  private onClose(e: CloseEvent) {
    const wasOpened = this.opened;
    clearInterval(this.pingTimer);
    this.ws = null;
    this.opened = false;
    if (this.stopped) return;
    if (!wasOpened) {
      // Handshake rechazado: el navegador no informa el código HTTP. /api/auth/me dispara el
      // manejo de sesión vencida de api.ts (vuelve al login) si corresponde.
      const t = now();
      this.earlyFailures = [...this.earlyFailures.filter((x) => t - x < 15_000), t];
      if (this.earlyFailures.length === 1) void api.get("/api/auth/me").catch(() => undefined);
      if (this.fallback || this.earlyFailures.length >= 3) {
        // Bloqueado (proxy sin WebSocket, etc.): las vistas siguen por HTTP y el WebSocket se
        // reintenta en segundo plano cada 60 s; al abrir, vuelven solas al WebSocket.
        const changed = !this.fallback;
        this.fallback = true;
        this.earlyFailures = [];
        if (changed) this.emitMode();
        this.retryPending = true;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
          this.retryPending = false;
          this.ensureSocket();
        }, 60_000);
        return;
      }
    } else if (e.code === 4401 || e.code === 4403) {
      void api.get("/api/auth/me").catch(() => undefined);
    }
    if (!this.subs.size) return;
    const delay = Math.min(10_000, 500 * 2 ** this.attempts++) * (0.75 + Math.random() * 0.5);
    this.reconnectTimer = setTimeout(() => this.ensureSocket(), delay);
  }

  private onText(text: string) {
    let m: ServerMessage;
    try {
      m = JSON.parse(text) as ServerMessage;
    } catch {
      return;
    }
    if (m.t === "pong") {
      const t = now();
      const rtt = t - m.c;
      this.offsets = [...this.offsets.slice(-4), m.s - (m.c + rtt / 2)];
      const sorted = [...this.offsets].sort((a, b) => a - b);
      this.offset = sorted[Math.floor(sorted.length / 2)] ?? 0;
    } else if (m.t === "welcome") {
      if (!this.offsets.length) this.offset = m.now - now();
    } else if (m.t === "state") {
      this.subs.get(m.s)?.h.onState?.({ st: m.st, effFps: m.effFps, limited: m.limited, code: m.code });
    } else if (m.t === "err" && m.s !== undefined) {
      const sub = this.subs.get(m.s);
      if (!sub) return;
      if (m.code === "too_many_focus" && sub.opts.prio === "focus") {
        // Tope de vistas ampliadas: se sigue como grilla.
        sub.opts = { ...sub.opts, prio: "grid" };
        this.sendSub(sub);
        return;
      }
      sub.h.onError?.(m.code);
    }
  }

  private onFrame(buf: ArrayBuffer) {
    const f = decodeHeader(buf);
    if (!f) return;
    const sub = this.subs.get(f.subId);
    if (!sub || sub.closed) return;
    if (sub.decoding) {
      sub.pending = f; // sólo el último
      return;
    }
    void this.decode(sub, f);
  }

  private async decode(sub: ClientSub, f: DecodedFrame) {
    sub.decoding = true;
    const gen = sub.gen;
    const t0 = performance.now();
    const blob = new Blob([f.payload as BlobPart], { type: "image/jpeg" });
    try {
      let img: LiveImageSource;
      if (hasBitmap()) {
        const target = sub.h.targetSize?.();
        // Reducir al decodificar si el cuadro es mucho más grande que el lienzo.
        if (target && target.w > 0 && f.width > target.w * 1.5) {
          img = await createImageBitmap(blob, { resizeWidth: Math.round(target.w), resizeHeight: Math.max(1, Math.round((target.w * f.height) / Math.max(1, f.width))), resizeQuality: "medium" });
        } else img = await createImageBitmap(blob);
      } else img = await decodeWithImage(blob);
      if (sub.closed || gen !== sub.gen || f.seq < sub.lastPaintedSeq) closeImage(img);
      else {
        if (sub.ready) closeImage(sub.ready.img);
        sub.ready = { img, meta: f, decodeMs: performance.now() - t0, gen };
        this.requestPaint();
      }
    } catch {
      // JPEG corrupto: se confirma igual para que el servidor siga enviando.
      if (!sub.closed && gen === sub.gen) {
        this.acks.push([sub.id, f.seq, 0]);
        this.requestPaint();
      }
    } finally {
      sub.decoding = false;
      const next = sub.pending;
      sub.pending = null;
      if (next && !sub.closed) void this.decode(sub, next);
    }
  }

  /** Un único rAF para todas las cámaras (con un respaldo por si el navegador no anima). */
  private requestPaint() {
    if (this.paintRaf) return;
    this.paintRaf = requestAnimationFrame(() => this.paint());
    clearTimeout(this.paintTimer);
    this.paintTimer = setTimeout(() => this.paint(), 500);
  }

  private paint() {
    if (this.paintRaf) cancelAnimationFrame(this.paintRaf);
    this.paintRaf = 0;
    clearTimeout(this.paintTimer);
    const t = now();
    for (const sub of this.subs.values()) {
      const r = sub.ready;
      if (!r) continue;
      sub.ready = null;
      if (r.gen !== sub.gen) {
        closeImage(r.img);
        continue;
      }
      let keep = false;
      try {
        keep = sub.h.draw(r.img, { ...r.meta, ageMs: Math.max(0, t + this.offset - r.meta.tCap), decodeMs: r.decodeMs }) === true;
      } catch {
        keep = false;
      }
      if (!keep) closeImage(r.img);
      sub.lastPaintedSeq = r.meta.seq;
      this.acks.push([sub.id, r.meta.seq, Math.round(r.decodeMs)]);
    }
    if (this.acks.length) {
      this.send({ t: "ack", a: this.acks.slice(0, 256) });
      this.acks = [];
    }
  }
}

export const liveClient = new LiveClient();
