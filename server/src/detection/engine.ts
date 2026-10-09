import type { Db } from "../db/index.js";
import type { CameraRow, CameraService } from "../exacq/service.js";
import type { EventService, EventType, Severity } from "../events/service.js";
import type { AiService, VisionResult } from "../ai/service.js";
import { compareGrids, lumaGrid } from "./motion.js";

const THREAT_TO_SEVERITY: Record<VisionResult["threat_level"], Severity> = {
  none: "info",
  low: "low",
  medium: "medium",
  high: "high",
  critical: "critical",
};

/**
 * Motor de detección en dos etapas:
 *  1) Movimiento / sabotaje local (gratis): diferencia de luminancia entre cuadros consecutivos.
 *  2) Verificación con IA (Claude visión) sólo cuando hay movimiento: clasifica, asigna severidad
 *     y descarta falsas alarmas (sombras, lluvia, insectos, cambios de luz).
 */
export class DetectionEngine {
  private prev = new Map<string, Float32Array>();
  private pendingMotion = new Map<string, number>();
  private lastEvent = new Map<string, number>();
  private busy = new Set<string>();
  private timer?: NodeJS.Timeout;
  private ticks = 0;
  readonly stats = { framesAnalyzed: 0, motionEvents: 0, aiVerified: 0, aiDismissed: 0, errors: 0 };

  constructor(
    private db: Db,
    private cameras: CameraService,
    private events: EventService,
    private ai: AiService,
    private opts: { intervalMs: number; cooldownMs: number; log: (m: string) => void },
  ) {}

  start() {
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  private async tick() {
    this.ticks++;
    const cams = this.db.all<CameraRow>("SELECT * FROM cameras WHERE enabled = 1 AND motion_enabled = 1 AND online = 1");
    const active = new Set(cams.map((c) => c.id));
    for (const id of this.prev.keys()) if (!active.has(id)) this.prev.delete(id);
    await Promise.all(cams.filter((c) => !this.busy.has(c.id) && this.cameras.sources.has(c.server_id)).map((c) => this.process(c)));
  }

  private async process(cam: CameraRow) {
    this.busy.add(cam.id);
    try {
      const snap = await this.cameras.snapshot(cam.id, this.opts.intervalMs * 0.75);
      const grid = lumaGrid(snap.data);
      this.stats.framesAnalyzed++;
      const prev = this.prev.get(cam.id);
      this.prev.set(cam.id, grid);
      if (!prev) return;
      const r = compareGrids(prev, grid, cam.sensitivity);
      const now = Date.now();

      if (r.tamper && now - (this.lastEvent.get(`${cam.id}:tamper`) ?? 0) > 5 * 60_000) {
        this.lastEvent.set(`${cam.id}:tamper`, now);
        this.events.create({
          type: "tamper",
          severity: "high",
          source: "motor",
          cameraId: cam.id,
          title: `Posible sabotaje: imagen obstruida en ${cam.name}`,
          description: "La escena perdió detalle de forma abrupta (cámara tapada, cegada o movida).",
          snapshot: snap.data,
        });
        return;
      }

      // Debounce: se exige movimiento en 2 cuadros seguidos para evitar ruido puntual.
      if (!r.motion) {
        this.pendingMotion.delete(cam.id);
        return;
      }
      const streak = (this.pendingMotion.get(cam.id) ?? 0) + 1;
      this.pendingMotion.set(cam.id, streak);
      if (streak < 2) return;
      if (now - (this.lastEvent.get(cam.id) ?? 0) < this.opts.cooldownMs) return;
      this.lastEvent.set(cam.id, now);
      this.pendingMotion.delete(cam.id);
      this.stats.motionEvents++;

      const ev = this.events.create({
        type: "motion",
        severity: "low",
        source: "motor",
        cameraId: cam.id,
        title: `Movimiento detectado en ${cam.name}`,
        description: `Cambio en ${(r.changedFraction * 100).toFixed(1)}% de la imagen.`,
        snapshot: snap.data,
        meta: { changedFraction: r.changedFraction, box: r.box },
      });

      if (cam.ai_verify && this.ai.available() && this.ai.settings().autoVerify) {
        void this.verify(ev.id, cam, snap.data);
      }
    } catch (e) {
      this.stats.errors++;
      if (this.ticks % 30 === 0) this.opts.log(`detección ${cam.name}: ${(e as Error).message}`);
    } finally {
      this.busy.delete(cam.id);
    }
  }

  /** Verifica un evento con Claude visión y lo reclasifica (o lo descarta como falsa alarma). */
  async verify(eventId: number, cam: { name: string; zone: string | null }, image: Buffer, userId?: number) {
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
      });
      if (dismissed) {
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
