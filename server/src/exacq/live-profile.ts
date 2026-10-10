import { z } from "zod";

/**
 * Perfil de video en vivo de un servidor exacqVision: qué parámetros de tamaño/calidad acepta
 * `/v1/video.web` (verificados leyendo la cabecera JPEG de la respuesta) y cuánta concurrencia
 * soporta. Lo genera la prueba automática (live-probe.ts) o lo carga un administrador.
 */

/** Parámetros extra de la URL: hasta 4 pares clave=valor con los marcadores {w} {h} {q} {c}. */
export const EXTRA_RE = /^[A-Za-z][A-Za-z0-9_]{0,30}=[A-Za-z0-9{}x._-]{1,20}(&[A-Za-z][A-Za-z0-9_]{0,30}=[A-Za-z0-9{}x._-]{1,20}){0,3}$/;

const extra = z.string().regex(EXTRA_RE, "Parámetros inválidos (formato clave=valor&clave2=valor2)");

export const LiveProfileSchema = z.object({
  v: z.literal(1),
  probedAt: z.number(),
  source: z.enum(["auto", "probe", "manual"]),
  baseline: z
    .object({
      camera: z.string(),
      w: z.number(),
      h: z.number(),
      bytes: z.number(),
      rttMs: z.number(),
      quality: z.number().nullable(),
    })
    .nullable(),
  resize: z
    .object({
      kind: z.enum(["param", "fixed"]),
      extra,
      keepsAspect: z.boolean(),
      verified: z.array(z.object({ reqW: z.number(), gotW: z.number(), gotH: z.number(), bytes: z.number() })),
    })
    .nullable(),
  quality: z.object({ extra, qLow: z.number().nullable(), qHigh: z.number().nullable() }).nullable(),
  pipeline: z.object({ ok: z.boolean(), speedup: z.number() }),
  parallel6Speedup: z.number(),
  recommendedConcurrency: z.number().int().min(1).max(64),
});

export type LiveProfile = z.infer<typeof LiveProfileSchema>;

export const liveProfileKey = (serverId: string) => `live_profile:${serverId}`;

export function parseLiveProfile(v: unknown): LiveProfile | null {
  const r = LiveProfileSchema.safeParse(v);
  return r.success ? r.data : null;
}

const clampInt = (v: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, Number.isFinite(v) ? v : min)));
const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/**
 * Reemplaza sólo {w} {h} {q} y {c} (= 100 − q) por enteros acotados (w 64-3840, h 64-2160, q 10-95).
 * Si falta un valor, el marcador se completa con uno razonable (nunca queda "{w}" en la URL).
 */
export function fillExtra(extraParams: string, p: { w?: number; h?: number; q?: number }): string {
  const w = clampInt(p.w ?? 640, 64, 3840);
  const h = clampInt(p.h ?? even((w * 9) / 16), 64, 2160);
  const q = clampInt(p.q ?? 70, 10, 95);
  return extraParams.replaceAll("{w}", String(w)).replaceAll("{h}", String(h)).replaceAll("{q}", String(q)).replaceAll("{c}", String(100 - q));
}

/** Perfil manual cargado por un administrador (sólo parámetros; el resto queda neutro). */
export function manualProfile(input: { resize?: { extra: string } | null; quality?: { extra: string } | null }, prev: LiveProfile | null): LiveProfile {
  return {
    v: 1,
    probedAt: Date.now(),
    source: "manual",
    baseline: prev?.baseline ?? null,
    resize: input.resize ? { kind: /\{w\}|\{h\}/.test(input.resize.extra) ? "param" : "fixed", extra: input.resize.extra, keepsAspect: true, verified: [] } : null,
    quality: input.quality ? { extra: input.quality.extra, qLow: null, qHigh: null } : null,
    pipeline: prev?.pipeline ?? { ok: true, speedup: 0 },
    parallel6Speedup: prev?.parallel6Speedup ?? 0,
    recommendedConcurrency: prev?.recommendedConcurrency ?? 6,
  };
}

/** Resumen público (sin datos de cámaras) para la interfaz de administración. */
export function publicLiveProfile(p: LiveProfile | null) {
  if (!p) return null;
  return {
    source: p.source,
    probedAt: p.probedAt,
    resize: p.resize ? { kind: p.resize.kind, extra: p.resize.extra } : null,
    quality: p.quality ? { extra: p.quality.extra } : null,
    pipeline: p.pipeline,
    recommendedConcurrency: p.recommendedConcurrency,
    baseline: p.baseline ? { w: p.baseline.w, h: p.baseline.h, bytes: p.baseline.bytes, rttMs: p.baseline.rttMs, quality: p.baseline.quality } : null,
  };
}
