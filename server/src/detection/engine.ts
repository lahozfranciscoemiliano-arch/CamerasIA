import type { Db } from "../db/index.js";
import type { CameraRow, CameraService } from "../exacq/service.js";
import type { EventService, EventType, Severity } from "../events/service.js";
import type { AiService, VisionResult } from "../ai/service.js";
import type { LiveHub } from "../live/hub.js";
import { compareGrids, lumaGrid } from "./motion.js";

const THREAT_TO_SEVERITY: Record<VisionResult["threat_level"], Severity> = {
  none: "info",
  low: "low",
  medium: "medium",
  high: "high",
  critical: "critical",
};

export interface DetectionRules {
  motionDedupeMin: number;
  aiReverifyMin: number;
  tamperConfirmFrames: number;
  tamperGlobalCameras: number;
  tamperGlobalWindowSec: number;
  tamperDedupeMin: number;
}

const DEFAULT_RULES: DetectionRules = {
  motionDedupeMin: 10,
  aiReverifyMin: 5,
  tamperConfirmFrames: 3,
  tamperGlobalCameras: 3,
  tamperGlobalWindowSec: 15,
  tamperDedupeMin: 30,
};

interface PendingTamper {
  cam: CameraRow;
  ts: number;
  snapshot: Buffer;
}

/**
 * Motor de detección en dos etapas:
 *  1) Movimiento / sabotaje local (gratis): diferencia de luminancia entre cuadros consecutivos.
 *  2) Verificación con IA (Claude visión) sólo cuando hay movimiento: clasifica, asigna severidad
 *     y descarta falsas alarmas (sombras, lluvia, insectos, cambios de luz).
 * Para no saturar: el movimiento repetido suma ocurrencias a un mismo evento, y el sabotaje se confirma en
 * varios cuadros seguidos y se descarta si ocurre en muchas cámaras a la vez (cambio día/noche, falla del VMS).
 */
export class DetectionEngine {
  private prev = new Map<string, Float32Array>();
  private pendingMotion = new Map<string, number>();
  private lastEvent = new Map<string, number>();
  private lastVerify = new Map<number, number>();
  private tamperStreak = new Map<string, { n: number; snapshot: Buffer }>();
  private pendingTamper: PendingTamper[] = [];
  private busy = new Set<string>();
  private timer?: NodeJS.Timeout;
  private ticks = 0;
  private now: () => number;
  readonly stats = { framesAnalyzed: 0, motionEvents: 0, aiVerified: 0, aiDismissed: 0, errors: 0 };

  constructor(
    private db: Db,
    private cameras: CameraService,
    private events: EventService,
    private ai: AiService,
    private opts: {
      intervalMs: number;
      cooldownMs: number;
      log: (m: string) => void;
      rules?: () => DetectionRules;
      now?: () => number;
      /** Si está, el movimiento se analiza con cuadros de 640 px del LiveHub (compartidos con los visores). */
      live?: LiveHub | null;
    },
  ) {
    this.now = opts.now ?? Date.now;
  }

  private get rules() {
    return this.opts.rules?.() ?? DEFAULT_RULES;
  }

  start() {
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Una pasada del motor (público para pruebas). */
  async tick() {
    this.ticks++;
    const cams = this.db.all<CameraRow>("SELECT * FROM cameras WHERE enabled = 1 AND motion_enabled = 1 AND online = 1 AND vms_disabled = 0");
    const active = new Set(cams.map((c) => c.id));
    for (const id of this.prev.keys()) if (!active.has(id)) this.prev.delete(id);
    await Promise.all(cams.filter((c) => !this.busy.has(c.id) && this.cameras.sources.has(c.server_id)).map((c) => this.process(c)));
    this.flushTampers();
  }

  /**
   * Emite los sabotajes confirmados cuando cerró la ventana global: si muchas cámaras "se taparon" a la vez no es
   * sabotaje sino un cambio global (día/noche, imagen gris del servidor de video) y se registra un único aviso silencioso.
   */
  private flushTampers() {
    if (!this.pendingTamper.length) return;
    const r = this.rules;
    const now = this.now();
    if (now - this.pendingTamper[0]!.ts < r.tamperGlobalWindowSec * 1000) return;
    const batch = this.pendingTamper;
    this.pendingTamper = [];
    const distinct = new Map(batch.map((p) => [p.cam.id, p]));
    if (distinct.size >= r.tamperGlobalCameras) {
      this.events.upsert({
        type: "system",
        severity: "info",
        source: "motor",
        title: `Cambio brusco de imagen en ${distinct.size} cámaras a la vez (cambio día/noche o falla del servidor de video)`,
        description: [...distinct.values()].map((p) => p.cam.name).join(", "),
        silent: true,
        dedupeKey: "tamper_global",
        dedupeWindowMs: 30 * 60_000,
        meta: { cameras: [...distinct.keys()] },
      });
      return;
    }
    for (const p of distinct.values()) {
      this.events.upsert({
        type: "tamper",
        severity: "high",
        source: "motor",
        cameraId: p.cam.id,
        title: `Posible sabotaje: imagen obstruida en ${p.cam.name}`,
        description: "La escena perdió detalle de forma abrupta y sostenida (cámara tapada, cegada o movida).",
        snapshot: p.snapshot,
        dedupeKey: `tamper:${p.cam.id}`,
        dedupeWindowMs: r.tamperDedupeMin * 60_000,
      });
    }
  }

  private async process(cam: CameraRow) {
    this.busy.add(cam.id);
    try {
      // Movimiento: cuadro reducido (640 px) del hub; decodificarlo cuesta ~5 veces menos que uno de
      // resolución completa y comparte el pedido con quien esté mirando la cámara.
      const frame = this.opts.live
        ? (await this.opts.live.pull(cam.id, { tierW: 640, fps: 0.5, maxAgeMs: 1500, timeoutMs: 4000 })).data
        : (await this.cameras.snapshot(cam.id, this.opts.intervalMs * 0.75)).data;
      const grid = lumaGrid(frame);
      this.stats.framesAnalyzed++;
      const prev = this.prev.get(cam.id);
      this.prev.set(cam.id, grid);
      if (!prev) return;
      const r = compareGrids(prev, grid, cam.sensitivity);
      const now = this.now();
      const rules = this.rules;

      // Sabotaje: transición a imagen uniforme y que se mantiene `tamperConfirmFrames` cuadros seguidos.
      const streak = this.tamperStreak.get(cam.id);
      if (r.tamper || (streak && r.uniform)) {
        const n = (streak?.n ?? 0) + 1;
        if (n >= rules.tamperConfirmFrames) {
          this.tamperStreak.delete(cam.id);
          this.pendingTamper.push({ cam, ts: now, snapshot: await this.evidence(cam.id, streak?.snapshot ?? frame) });
        } else this.tamperStreak.set(cam.id, { n, snapshot: streak?.snapshot ?? frame });
        return;
      }
      if (streak) this.tamperStreak.delete(cam.id);

      // Debounce: se exige movimiento en 2 cuadros seguidos para evitar ruido puntual.
      if (!r.motion) {
        this.pendingMotion.delete(cam.id);
        return;
      }
      const mstreak = (this.pendingMotion.get(cam.id) ?? 0) + 1;
      this.pendingMotion.set(cam.id, mstreak);
      if (mstreak < 2) return;
      if (now - (this.lastEvent.get(cam.id) ?? 0) < this.opts.cooldownMs) return;
      this.lastEvent.set(cam.id, now);
      this.pendingMotion.delete(cam.id);
      this.stats.motionEvents++;
      const evidence = await this.evidence(cam.id, frame);

      const { ev, created } = this.events.upsert({
        type: "motion",
        severity: "low",
        source: "motor",
        cameraId: cam.id,
        title: `Movimiento detectado en ${cam.name}`,
        description: `Cambio en ${(r.changedFraction * 100).toFixed(1)}% de la imagen.`,
        snapshot: evidence,
        meta: { changedFraction: r.changedFraction, box: r.box },
        dedupeKey: `motion:${cam.id}`,
        dedupeWindowMs: rules.motionDedupeMin * 60_000,
      });

      if (!cam.ai_verify || !this.ai.available() || !this.ai.settings().autoVerify || this.cameras.isMuted(cam.id)) return;
      if (created) {
        this.lastVerify.set(ev.id, now);
        void this.verify(ev.id, cam, evidence);
      } else if (now - (this.lastVerify.get(ev.id) ?? 0) >= rules.aiReverifyMin * 60_000) {
        // Movimiento repetido: se re-verifica cada tanto con el cuadro nuevo, sin bajar nunca la severidad.
        this.lastVerify.set(ev.id, now);
        void this.verify(ev.id, cam, evidence, undefined, { keepMax: true });
      }
    } catch (e) {
      this.stats.errors++;
      if (this.ticks % 30 === 0) this.opts.log(`detección ${cam.name}: ${(e as Error).message}`);
    } finally {
      this.busy.delete(cam.id);
    }
  }

  /** Imagen de evidencia a resolución completa (para el evento y la IA); si falla, el cuadro analizado. */
  private async evidence(key: string, fallback: Buffer): Promise<Buffer> {
    if (!this.opts.live) return fallback;
    try {
      return (await this.cameras.snapshot(key, 1500)).data;
    } catch {
      return fallback;
    }
  }

  /**
   * Verifica un evento con Claude visión y lo reclasifica (o lo descarta como falsa alarma).
   * Con `keepMax` (re-verificación de un evento ya abierto) nunca baja la severidad ni lo marca como falsa alarma.
   */
  async verify(eventId: number, cam: { name: string; zone: string | null }, image: Buffer, userId?: number, opts: { keepMax?: boolean } = {}) {
    if (!this.ai.takeAnalysisBudget()) return null;
    try {
      const result = await this.ai.analyzeImage(image, { cameraName: cam.name, zone: cam.zone, reason: "Verificar alerta de movimiento" }, userId);
      this.stats.aiVerified++;
      const dismissed = result.event_type === "none" && result.threat_level === "none";
      const type: EventType = result.event_type === "none" ? "motion" : result.event_type;
      const ev = this.events.enrich(eventId, {
        type,
        severity: THREAT_TO_SEVERITY[result.threat_level],
        title: `${dismissed ? "Sin relevancia" : "IA"} · ${cam.name}: ${result.summary}`.slice(0, 200),
        ai: { ...result, model: this.ai.model, analyzedAt: Date.now() },
        keepMax: opts.keepMax,
      });
      if (dismissed && !opts.keepMax) {
        this.stats.aiDismissed++;
        this.events.setStatus(eventId, "false_positive", "IA");
      }
      return ev;
    } catch (e) {
      this.opts.log(`verificación IA falló: ${(e as Error).message}`);
      return null;
    }
  }
}
