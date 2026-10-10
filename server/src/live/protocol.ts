import { z } from "zod";

/**
 * Protocolo del WebSocket /api/live.
 *
 * Servidor → cliente, binario: cabecera de 32 bytes little-endian + JPEG.
 *   0 u8 versión (1) · 1 u8 tipo (1 = JPEG) · 2 u16 subId · 4 u32 seq · 8 f64 tCap (epoch ms)
 *   16 u32 upMs · 20 u16 ancho · 22 u16 alto · 24 u16 flags · 26 u16 descartados · 28 u32 bytes del JPEG
 * Cliente → servidor y servidor → cliente, texto: JSON (ver los esquemas de abajo).
 */

export const PROTOCOL_VERSION = 1;
export const HEADER_BYTES = 32;
export const KIND_JPEG = 1;

/** Bits de flags de un cuadro. */
export const FLAG_CACHED = 1;
export const FLAG_SCALED = 2;
export const FLAG_BUDGET_LIMITED = 4;
export const FLAG_NATIVE_FALLBACK = 8;

/** Anchos de pedido: se redondea hacia arriba; 0 = resolución nativa. */
export const TIERS = [320, 480, 640, 960, 1280, 1920] as const;

export function tierFor(px: number): number {
  if (!Number.isFinite(px) || px <= 0) return 0;
  for (const t of TIERS) if (px <= t) return t;
  return 0;
}

/** Calidad JPEG pedida según el ancho (si el servidor permite elegirla). */
export function qualityForTier(tierW: number): number {
  if (tierW === 0 || tierW >= 1280) return 75;
  if (tierW <= 480) return 60;
  if (tierW <= 640) return 65;
  return 70;
}

export interface FrameHeader {
  subId: number;
  seq: number;
  tCap: number;
  upMs: number;
  width: number;
  height: number;
  flags: number;
  dropped: number;
}

const u16 = (v: number) => Math.max(0, Math.min(0xffff, Math.round(v) || 0));
const u32 = (v: number) => Math.max(0, Math.min(0xffffffff, Math.round(v) || 0));

/** Arma el mensaje binario (una sola copia del JPEG). */
export function encodeFrame(h: FrameHeader, jpeg: Buffer): Buffer {
  const hdr = Buffer.allocUnsafe(HEADER_BYTES);
  hdr.writeUInt8(PROTOCOL_VERSION, 0);
  hdr.writeUInt8(KIND_JPEG, 1);
  hdr.writeUInt16LE(u16(h.subId), 2);
  hdr.writeUInt32LE(u32(h.seq), 4);
  hdr.writeDoubleLE(h.tCap, 8);
  hdr.writeUInt32LE(u32(h.upMs), 16);
  hdr.writeUInt16LE(u16(h.width), 20);
  hdr.writeUInt16LE(u16(h.height), 22);
  hdr.writeUInt16LE(u16(h.flags), 24);
  hdr.writeUInt16LE(u16(h.dropped), 26);
  hdr.writeUInt32LE(jpeg.length, 28);
  return Buffer.concat([hdr, jpeg], HEADER_BYTES + jpeg.length);
}

/** Lee la cabecera (pruebas y herramientas); null si no es válida. */
export function decodeFrame(buf: Buffer): (FrameHeader & { version: number; kind: number; payload: Buffer }) | null {
  if (buf.length < HEADER_BYTES) return null;
  const version = buf.readUInt8(0);
  const kind = buf.readUInt8(1);
  const bytes = buf.readUInt32LE(28);
  if (version !== PROTOCOL_VERSION || bytes !== buf.length - HEADER_BYTES) return null;
  return {
    version,
    kind,
    subId: buf.readUInt16LE(2),
    seq: buf.readUInt32LE(4),
    tCap: buf.readDoubleLE(8),
    upMs: buf.readUInt32LE(16),
    width: buf.readUInt16LE(20),
    height: buf.readUInt16LE(22),
    flags: buf.readUInt16LE(24),
    dropped: buf.readUInt16LE(26),
    payload: buf.subarray(HEADER_BYTES),
  };
}

const subId = z.number().int().min(1).max(65535);
const prio = z.enum(["grid", "focus"]);
const fps = z.number().finite().min(0).max(1000);
const maxW = z.number().int().min(0).max(7680);

export const ClientMessage = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), v: z.number().int() }),
  z.object({ t: z.literal("sub"), s: subId, cam: z.string().min(1).max(200), fps, maxW: maxW.default(0), prio: prio.default("grid") }),
  z.object({ t: z.literal("upd"), s: subId, fps: fps.optional(), maxW: maxW.optional(), prio: prio.optional() }),
  z.object({ t: z.literal("unsub"), s: subId }),
  z.object({ t: z.literal("ack"), a: z.array(z.tuple([subId, z.number().int().min(0), z.number().min(0)])).max(256) }),
  z.object({ t: z.literal("ping"), c: z.number().finite() }),
]);

export type ClientMessage = z.infer<typeof ClientMessage>;

export type LiveStateName = "starting" | "live" | "stalled" | "offline" | "disabled" | "error";
