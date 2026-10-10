import { parseJpegInfo } from "../video/jpeg.js";
import { ExacqError, ExacqSource } from "./client.js";
import type { LiveProfile } from "./live-profile.js";
import type { CameraService } from "./service.js";
import type { Snapshot } from "./types.js";

/**
 * Prueba automática del perfil de video en vivo de un exacqVision Web Service.
 *
 * Los nombres de parámetros de tamaño/calidad de /v1/video.web no están documentados para la
 * versión 23.09: por eso cada candidato se verifica leyendo la cabecera JPEG de la respuesta
 * (tamaño real y tabla de cuantización), nunca se da por bueno sólo porque el servidor respondió.
 *
 * Pedidos estrictamente secuenciales (salvo la medición de concurrencia), con pausa entre ellos,
 * tiempo máximo por pedido, tope de pedidos y de duración total; se aborta ante el primer error
 * de red o de autenticación (no se guarda nada).
 */

/** Lo que la prueba necesita del cliente exacq (ExacqSource cumple esta interfaz). */
export interface ProbeTarget {
  fetchImage(cameraId: string, opts: { extra?: string; w?: number; h?: number; quality?: number; timeoutMs?: number }): Promise<Snapshot>;
  readonly templateHasQuality?: boolean;
}

export interface ProbeStep {
  step: string;
  ok: boolean;
  detail: string;
}

export interface ProbeOptions {
  budgetMs?: number;
  gapMs?: number;
  timeoutMs?: number;
  maxRequests?: number;
  now?: () => number;
}

export const RESIZE_CANDIDATES = ["w={w}", "width={w}", "w={w}&h={h}", "width={w}&height={h}", "size={w}x{h}", "res={w}x{h}", "resolution={w}x{h}", "maxwidth={w}&maxheight={h}"];
export const FIXED_CANDIDATES = ["stream=1", "stream=secondary", "streamid=1"];
export const QUALITY_CANDIDATES = ["quality={q}", "q={q}", "jpegquality={q}", "compression={c}"];

interface Sample {
  w: number;
  h: number;
  bytes: number;
  q: number | null;
  ms: number;
}

class BudgetExceeded extends Error {}

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function probeLiveProfile(src: ProbeTarget, cameraIds: string[], opts: ProbeOptions = {}): Promise<{ profile: LiveProfile; steps: ProbeStep[] }> {
  const now = opts.now ?? Date.now;
  const budgetMs = opts.budgetMs ?? 60_000;
  const gapMs = opts.gapMs ?? 300;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const maxRequests = opts.maxRequests ?? 40;
  const t0 = now();
  let requests = 0;
  const steps: ProbeStep[] = [];
  if (!cameraIds.length) throw new ExacqError("No hay cámaras en línea para probar el video en vivo", "not_found");

  /** Un pedido; null = parámetro no soportado (4xx/5xx, HTML/JSON o imagen que no es JPEG). */
  const get = async (camera: string, p: { extra?: string; w?: number; h?: number; q?: number } = {}, concurrent = false): Promise<Sample | null> => {
    if (requests >= maxRequests || now() - t0 > budgetMs) throw new BudgetExceeded();
    if (!concurrent && requests > 0 && gapMs > 0) await sleep(gapMs);
    requests++;
    const t = now();
    let snap: Snapshot;
    try {
      snap = await src.fetchImage(camera, { extra: p.extra, w: p.w, h: p.h, quality: p.q, timeoutMs });
    } catch (e) {
      if (e instanceof ExacqError && (e.kind === "network" || e.kind === "auth" || e.kind === "aborted")) throw e;
      if (!(e instanceof ExacqError)) throw e;
      return null;
    }
    const info = parseJpegInfo(snap.data);
    if (!info) return null;
    return { w: info.width, h: info.height, bytes: snap.data.length, q: info.quality, ms: Math.max(1, now() - t) };
  };

  const profile: LiveProfile = {
    v: 1,
    probedAt: now(),
    source: "probe",
    baseline: null,
    resize: null,
    quality: null,
    pipeline: { ok: false, speedup: 1 },
    parallel6Speedup: 1,
    recommendedConcurrency: 3,
  };

  try {
    // 1) Línea base: la cámara de mayor resolución entre las primeras, 3 cuadros.
    const firsts: Array<{ camera: string; s: Sample }> = [];
    for (const camera of cameraIds.slice(0, 4)) {
      const s = await get(camera);
      if (s) firsts.push({ camera, s });
    }
    if (!firsts.length) throw new ExacqError("Ninguna cámara devolvió una imagen JPEG válida", "protocol");
    firsts.sort((a, b) => b.s.w * b.s.h - a.s.w * a.s.h);
    const main = firsts[0]!.camera;
    const base: Sample[] = [firsts[0]!.s];
    for (let k = 0; k < 2; k++) {
      const s = await get(main);
      if (s) base.push(s);
    }
    const W0 = base[0]!.w;
    const H0 = base[0]!.h;
    const B0 = median(base.map((s) => s.bytes));
    const R0 = median(base.map((s) => s.ms));
    profile.baseline = { camera: main, w: W0, h: H0, bytes: B0, rttMs: R0, quality: base[0]!.q };
    steps.push({ step: "Línea base", ok: true, detail: `${W0}×${H0} · ${Math.round(B0 / 1024)} KB · ${R0} ms${base[0]!.q ? ` · calidad ≈${base[0]!.q}` : ""}` });

    // 2) Pedidos en paralelo: misma cámara (pipelining) y cámaras distintas.
    const timed = async (cams: string[]) => {
      const t = now();
      const r = await Promise.all(cams.map((c) => get(c, {}, true)));
      return { ms: Math.max(1, now() - t), ok: r.every(Boolean) };
    };
    const p3 = await timed([main, main, main]);
    const speedup = p3.ok ? Math.round(((3 * R0) / p3.ms) * 100) / 100 : 1;
    profile.pipeline = { ok: speedup >= 1.6, speedup };
    const distinct = [...new Set(cameraIds)].slice(0, 6);
    let s6 = speedup;
    if (distinct.length >= 2) {
      const p6 = await timed(distinct);
      s6 = p6.ok ? Math.round(((distinct.length * R0) / p6.ms) * 100) / 100 : 1;
    }
    profile.parallel6Speedup = s6;
    profile.recommendedConcurrency = s6 >= 4 ? 12 : s6 >= 2 ? 6 : 3;
    steps.push({ step: "Concurrencia", ok: true, detail: `misma cámara ×${speedup} · ${distinct.length} cámaras ×${s6} → hasta ${profile.recommendedConcurrency} pedidos simultáneos` });

    // 3) Tamaño: parámetros candidatos verificados por la cabecera JPEG.
    const tw = W0 > 640 ? 640 : even(W0 / 2);
    const th = even((tw * H0) / W0);
    const aspect0 = W0 / H0;
    const aspectOk = (s: Sample, reqAspect: number) => Math.abs(s.w / s.h - aspect0) / aspect0 <= 0.03 || Math.abs(s.w / s.h - reqAspect) / reqAspect <= 0.03;
    if (tw >= 64) {
      for (const extra of RESIZE_CANDIDATES) {
        const s = await get(main, { extra, w: tw, h: th });
        const pass = s && s.w <= 1.25 * tw && s.w < W0 && aspectOk(s, tw / th) && s.bytes < 0.6 * B0;
        if (!pass) {
          steps.push({ step: `Tamaño ${extra}`, ok: false, detail: s ? `devolvió ${s.w}×${s.h}` : "no soportado" });
          continue;
        }
        // Confirmar que es paramétrico: a la mitad de ancho debe achicarse otra vez.
        const tw2 = even(tw / 2);
        const th2 = even((tw2 * H0) / W0);
        const s2 = await get(main, { extra, w: tw2, h: th2 });
        if (!s2 || s2.w > 1.25 * tw2) {
          steps.push({ step: `Tamaño ${extra}`, ok: false, detail: `no respeta ${tw2} px` });
          continue;
        }
        profile.resize = {
          kind: "param",
          extra,
          keepsAspect: Math.abs(s.w / s.h - aspect0) / aspect0 <= 0.03,
          verified: [
            { reqW: tw, gotW: s.w, gotH: s.h, bytes: s.bytes },
            { reqW: tw2, gotW: s2.w, gotH: s2.h, bytes: s2.bytes },
          ],
        };
        steps.push({ step: `Tamaño ${extra}`, ok: true, detail: `${tw}→${s.w}×${s.h} (${Math.round(s.bytes / 1024)} KB) · ${tw2}→${s2.w}×${s2.h}` });
        break;
      }
      if (!profile.resize) {
        for (const extra of FIXED_CANDIDATES) {
          const s = await get(main, { extra });
          if (s && s.w < 0.75 * W0) {
            profile.resize = { kind: "fixed", extra, keepsAspect: Math.abs(s.w / s.h - aspect0) / aspect0 <= 0.03, verified: [{ reqW: 0, gotW: s.w, gotH: s.h, bytes: s.bytes }] };
            steps.push({ step: `Flujo secundario ${extra}`, ok: true, detail: `${s.w}×${s.h} (${Math.round(s.bytes / 1024)} KB)` });
            break;
          }
          steps.push({ step: `Flujo secundario ${extra}`, ok: false, detail: s ? `devolvió ${s.w}×${s.h}` : "no soportado" });
        }
      }
    }

    // 4) Calidad (sobre el mejor tamaño): debe bajar la calidad estimada o los bytes.
    if (src.templateHasQuality) {
      steps.push({ step: "Calidad", ok: true, detail: "la URL de imagen ya incluye {quality}" });
    } else {
      const sized = profile.resize?.kind === "param" ? { prefix: profile.resize.extra, w: tw, h: th } : profile.resize ? { prefix: profile.resize.extra } : { prefix: "" };
      for (const extra of QUALITY_CANDIDATES) {
        const full = sized.prefix ? `${sized.prefix}&${extra}` : extra;
        const lo = await get(main, { extra: full, w: sized.w, h: sized.h, q: 30 });
        const hi = lo ? await get(main, { extra: full, w: sized.w, h: sized.h, q: 85 }) : null;
        const pass = Boolean(lo && hi && (lo.q !== null && hi.q !== null ? lo.q <= hi.q - 20 : lo.bytes < 0.7 * hi.bytes));
        if (pass) {
          profile.quality = { extra, qLow: lo!.q, qHigh: hi!.q };
          steps.push({ step: `Calidad ${extra}`, ok: true, detail: `q30 → ${lo!.q ?? "?"} (${Math.round(lo!.bytes / 1024)} KB) · q85 → ${hi!.q ?? "?"} (${Math.round(hi!.bytes / 1024)} KB)` });
          break;
        }
        steps.push({ step: `Calidad ${extra}`, ok: false, detail: lo ? "sin efecto" : "no soportado" });
      }
    }
  } catch (e) {
    if (!(e instanceof BudgetExceeded)) throw e;
    if (!profile.baseline) throw new ExacqError("La prueba superó el tiempo o la cantidad de pedidos permitidos", "protocol");
    steps.push({ step: "Límite", ok: false, detail: `prueba cortada tras ${requests} pedidos: se guarda lo verificado` });
  }
  profile.probedAt = now();
  return { profile, steps };
}

/**
 * Orquesta la prueba de perfil por servidor: automática una sola vez (la primera vez que el hub
 * usa un servidor sin perfil) o a pedido (botón "Optimizar video en vivo").
 * Un perfil cargado a mano por un administrador nunca se reemplaza automáticamente.
 */
export class LiveProfiles {
  private attempted = new Set<string>();
  private running = new Map<string, Promise<{ profile: LiveProfile; steps: ProbeStep[]; saved: boolean }>>();

  constructor(
    private cameras: CameraService,
    private opts: {
      log: (m: string) => void;
      /** Perfil guardado (para auditoría). */
      onSaved?: (server: { id: string; name: string }, profile: LiveProfile, reason: "auto" | "probe") => void;
      probe?: ProbeOptions;
    },
  ) {}

  get(serverId: string) {
    return this.cameras.liveProfile(serverId);
  }

  /** Prueba automática en segundo plano si el servidor todavía no tiene perfil (una vez; si falla, a los 10 min). */
  ensure(serverId: string) {
    if (this.attempted.has(serverId) || this.cameras.liveProfile(serverId)) return;
    if (!(this.cameras.sources.get(serverId) instanceof ExacqSource)) return;
    this.attempted.add(serverId);
    void this.probe(serverId, { save: true, reason: "auto" }).catch((e) => {
      this.opts.log(`perfil de video en vivo (${serverId}): ${(e as Error).message}`);
      // Falló (p. ej. VPN caída al arrancar): se vuelve a intentar más tarde, no en cada cuadro.
      setTimeout(() => this.attempted.delete(serverId), 10 * 60_000).unref();
    });
  }

  /** Ejecuta la prueba; con `save` guarda el resultado (salvo perfil manual si es automática). */
  probe(serverId: string, o: { save: boolean; reason: "auto" | "probe" }) {
    const key = `${serverId}:${o.save}`;
    const cur = this.running.get(key);
    if (cur) return cur;
    const p = (async () => {
      const src = this.cameras.sources.get(serverId);
      if (!(src instanceof ExacqSource)) throw new ExacqError("Servidor no activo (¿deshabilitado?)", "not_found");
      const cams = (await src.listCameras()).filter((c) => c.online && !c.disabled).map((c) => c.cameraId);
      const r = await probeLiveProfile(src, cams, this.opts.probe);
      const profile: LiveProfile = { ...r.profile, source: o.reason };
      let saved = false;
      if (o.save && !(o.reason === "auto" && this.cameras.liveProfile(serverId)?.source === "manual")) {
        this.cameras.setLiveProfile(serverId, profile);
        saved = true;
        this.opts.onSaved?.({ id: serverId, name: src.name }, profile, o.reason);
      }
      return { profile, steps: r.steps, saved };
    })().finally(() => this.running.delete(key));
    this.running.set(key, p);
    return p;
  }
}
