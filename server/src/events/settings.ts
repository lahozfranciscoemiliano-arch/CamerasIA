import { z } from "zod";
import type { Db } from "../db/index.js";

const int = (min: number, max: number) => z.number().int().min(min).max(max);

/** Política de alertas del servidor (Administración → Alertas). Todos los valores están acotados. */
export const AlertSettingsSchema = z.object({
  // Cámaras y servidores de video: "se avisa si algo sigue caído más de 1 minuto".
  cameraOfflineAfterSec: int(0, 3600),
  cameraOfflineMinSyncs: int(1, 20),
  groupMinCameras: int(2, 100),
  sourceDownAfterSec: int(0, 3600),
  sourceDownMinSyncs: int(1, 20),
  sourceCriticalAfterMin: int(1, 1440),
  // Túnel FortiVPN
  vpnDownGraceSec: int(0, 3600),
  vpnCriticalAfterMin: int(1, 1440),
  // Equipos monitoreados (TCP)
  hostDownAfterChecks: int(1, 20),
  hostUpAfterChecks: int(1, 20),
  hostProbeRetryMs: int(0, 10_000),
  // Deduplicación
  reopenWindowMin: int(0, 1440),
  flapThreshold: int(2, 100),
  motionDedupeMin: int(0, 1440),
  aiReverifyMin: int(1, 1440),
  tamperConfirmFrames: int(1, 20),
  tamperGlobalCameras: int(2, 100),
  tamperGlobalWindowSec: int(1, 600),
  tamperDedupeMin: int(0, 1440),
  ingestDedupeSec: int(0, 86_400),
  // Notificaciones
  notifyCoalesceMs: int(0, 60_000),
  maxNotificationsPerMin: int(1, 120),
  notifyMinSeverity: z.enum(["info", "low", "medium", "high", "critical"]),
});

export type AlertSettings = z.infer<typeof AlertSettingsSchema>;

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  cameraOfflineAfterSec: 60,
  cameraOfflineMinSyncs: 3,
  groupMinCameras: 3,
  sourceDownAfterSec: 60,
  sourceDownMinSyncs: 3,
  sourceCriticalAfterMin: 10,
  vpnDownGraceSec: 60,
  vpnCriticalAfterMin: 10,
  hostDownAfterChecks: 3,
  hostUpAfterChecks: 2,
  hostProbeRetryMs: 500,
  reopenWindowMin: 10,
  flapThreshold: 3,
  motionDedupeMin: 10,
  aiReverifyMin: 5,
  tamperConfirmFrames: 3,
  tamperGlobalCameras: 3,
  tamperGlobalWindowSec: 15,
  tamperDedupeMin: 30,
  ingestDedupeSec: 120,
  notifyCoalesceMs: 1500,
  maxNotificationsPerMin: 6,
  notifyMinSeverity: "medium",
};

/** Lectura con caché de la política de alertas guardada en `settings.alerts`. */
export class AlertSettingsStore {
  private cache?: AlertSettings;

  constructor(private db?: Db) {}

  get(): AlertSettings {
    if (this.cache) return this.cache;
    const stored = this.db ? this.db.getSetting<Record<string, unknown>>("alerts", { ...DEFAULT_ALERT_SETTINGS }) : DEFAULT_ALERT_SETTINGS;
    const parsed = AlertSettingsSchema.safeParse({ ...DEFAULT_ALERT_SETTINGS, ...stored });
    this.cache = parsed.success ? parsed.data : { ...DEFAULT_ALERT_SETTINGS };
    return this.cache;
  }

  /** Guarda una actualización parcial (validada) y devuelve la política completa. */
  set(patch: Partial<AlertSettings>): AlertSettings {
    const next = AlertSettingsSchema.parse({ ...this.get(), ...patch });
    this.db?.setSetting("alerts", next);
    this.cache = next;
    return next;
  }
}
