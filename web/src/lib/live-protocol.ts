/**
 * Protocolo del WebSocket de video en vivo (/api/live). Debe coincidir con server/src/live/protocol.ts.
 *
 * Cuadro binario: cabecera de 32 bytes little-endian + JPEG.
 *   0 u8 versión · 1 u8 tipo · 2 u16 subId · 4 u32 seq · 8 f64 tCap · 16 u32 upMs
 *   20 u16 ancho · 22 u16 alto · 24 u16 flags · 26 u16 descartados · 28 u32 bytes del JPEG
 */

export const PROTOCOL_VERSION = 1;
export const HEADER_BYTES = 32;

export const FLAG_CACHED = 1;
export const FLAG_SCALED = 2;
export const FLAG_BUDGET_LIMITED = 4;
export const FLAG_NATIVE_FALLBACK = 8;

export type Prio = "grid" | "focus";

export interface FrameMeta {
  subId: number;
  seq: number;
  /** Instante de captura estimado (reloj del servidor, epoch ms). */
  tCap: number;
  upMs: number;
  width: number;
  height: number;
  flags: number;
  dropped: number;
}

export interface DecodedFrame extends FrameMeta {
  payload: Uint8Array;
}

/** Lee la cabecera; null si la versión o el largo no coinciden (el cuadro se ignora). */
export function decodeHeader(buf: ArrayBuffer): DecodedFrame | null {
  if (buf.byteLength < HEADER_BYTES) return null;
  const v = new DataView(buf);
  if (v.getUint8(0) !== PROTOCOL_VERSION || v.getUint8(1) !== 1) return null;
  const bytes = v.getUint32(28, true);
  if (bytes !== buf.byteLength - HEADER_BYTES) return null;
  return {
    subId: v.getUint16(2, true),
    seq: v.getUint32(4, true),
    tCap: v.getFloat64(8, true),
    upMs: v.getUint32(16, true),
    width: v.getUint16(20, true),
    height: v.getUint16(22, true),
    flags: v.getUint16(24, true),
    dropped: v.getUint16(26, true),
    payload: new Uint8Array(buf, HEADER_BYTES),
  };
}

export type LiveStateName = "starting" | "live" | "stalled" | "offline" | "disabled" | "error";

export interface ServerState {
  st: LiveStateName;
  effFps: number;
  limited: boolean;
  code?: string;
}

export type ServerMessage =
  | { t: "welcome"; v: number; now: number; limits: { maxSubs: number; maxFocus: number; gridMaxFps: number; focusMaxFps: number } }
  | ({ t: "state"; s: number } & ServerState)
  | { t: "pong"; c: number; s: number }
  | { t: "err"; s?: number; code: string };

/** Anchos de pedido (px); 0 = resolución nativa. */
export const TIERS = [320, 480, 640, 960, 1280, 1920];

export function tierFor(px: number): number {
  if (!Number.isFinite(px) || px <= 0) return 0;
  for (const t of TIERS) if (px <= t) return t;
  return 0;
}

export interface DrawRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/**
 * Rectángulos de dibujo. "cover": recorta al centro para llenar el lienzo (grilla);
 * "contain": imagen completa con bandas (vista ampliada).
 */
export function drawRect(iw: number, ih: number, cw: number, ch: number, fit: "cover" | "contain"): DrawRect {
  if (fit === "contain") {
    const s = Math.min(cw / iw, ch / ih);
    const dw = iw * s;
    const dh = ih * s;
    return { sx: 0, sy: 0, sw: iw, sh: ih, dx: (cw - dw) / 2, dy: (ch - dh) / 2, dw, dh };
  }
  const s = Math.max(cw / iw, ch / ih);
  const sw = cw / s;
  const sh = ch / s;
  return { sx: (iw - sw) / 2, sy: (ih - sh) / 2, sw, sh, dx: 0, dy: 0, dw: cw, dh: ch };
}
