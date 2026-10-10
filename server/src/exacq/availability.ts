/**
 * Histéresis de disponibilidad (pura, con reloj inyectado): una cámara o un servidor de video sólo se dan por
 * caídos tras `minSyncs` observaciones fallidas seguidas Y al menos `afterMs` desde la primera. Cualquier
 * observación correcta reinicia la cuenta y la recuperación es inmediata.
 */
export interface AvailabilityRules {
  cameraMinSyncs: number;
  cameraAfterMs: number;
  sourceMinSyncs: number;
  sourceAfterMs: number;
}

// Tolerancia por el jitter del temporizador de sincronización (30 s nominales).
const JITTER_MS = 1000;

export class AvailabilityTracker {
  private cams = new Map<string, { count: number; firstAt: number }>();
  private srcs = new Map<string, { count: number; firstAt: number; down: boolean }>();

  constructor(private rules: () => AvailabilityRules) {}

  cameraObserved(key: string, online: boolean, now: number): "pending" | "confirm_offline" | "online" {
    if (online) {
      this.cams.delete(key);
      return "online";
    }
    const s = this.cams.get(key) ?? { count: 0, firstAt: now };
    s.count += 1;
    this.cams.set(key, s);
    const r = this.rules();
    return s.count >= r.cameraMinSyncs && now - s.firstAt >= r.cameraAfterMs - JITTER_MS ? "confirm_offline" : "pending";
  }

  /** Momento de la primera observación fallida de la racha actual (o undefined si está en línea). */
  firstOfflineAt(key: string) {
    return this.cams.get(key)?.firstAt;
  }

  sourceFailed(id: string, now: number): "pending" | "confirm_down" | "already_down" {
    const s = this.srcs.get(id) ?? { count: 0, firstAt: now, down: false };
    this.srcs.set(id, s);
    if (s.down) return "already_down";
    s.count += 1;
    const r = this.rules();
    if (s.count >= r.sourceMinSyncs && now - s.firstAt >= r.sourceAfterMs - JITTER_MS) {
      s.down = true;
      return "confirm_down";
    }
    return "pending";
  }

  /** Desde cuándo falla la fuente (racha actual). */
  sourceFailingSince(id: string) {
    return this.srcs.get(id)?.firstAt;
  }

  sourceOk(id: string): "recovered" | "ok" {
    const s = this.srcs.get(id);
    this.srcs.delete(id);
    return s?.down ? "recovered" : "ok";
  }

  reset(key: string) {
    this.cams.delete(key);
  }

  /** Olvida el estado por cámara de una fuente (al caer la fuente entera, sus cámaras se evalúan de cero). */
  resetSource(id: string) {
    for (const k of this.cams.keys()) if (k.startsWith(`${id}:`)) this.cams.delete(k);
  }
}
