import type { AlertNotice, AlertPrefs, AlertThreshold, NoticeItem, Severity } from "./types";

/** Funciones puras: qué avisos de `alert.notify` muestra y hace sonar ESTA consola. */

export const SEV_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

export const DEFAULT_PREFS: AlertPrefs = {
  security: { toast: "high", sound: "high" },
  // Infraestructura: sonido sólo si escala a crítica (caídas que se prolongan más de 10 min).
  infra: { toast: "high", sound: "critical" },
  recoveries: true,
  soundCooldownSec: 20,
  maxToasts: 3,
  dndAllowCritical: true,
  dndUntil: null,
  muted: false,
};

/** Separación mínima entre sonidos críticos aunque se ignore la pausa configurada. */
export const CRITICAL_MIN_GAP_MS = 5000;

const THRESHOLDS: AlertThreshold[] = ["info", "low", "medium", "high", "critical", "off"];
const clampInt = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;
const threshold = (v: unknown, fallback: AlertThreshold): AlertThreshold => (THRESHOLDS.includes(v as AlertThreshold) ? (v as AlertThreshold) : fallback);

/** Completa y acota preferencias leídas de localStorage (pueden venir de una versión anterior o editadas a mano). */
export function normalizePrefs(raw: unknown): AlertPrefs {
  const p = (raw && typeof raw === "object" ? raw : {}) as Partial<AlertPrefs>;
  const cat = (c: unknown, d: AlertPrefs["security"]) => {
    const o = (c && typeof c === "object" ? c : {}) as Partial<AlertPrefs["security"]>;
    return { toast: threshold(o.toast, d.toast), sound: threshold(o.sound, d.sound) };
  };
  return {
    security: cat(p.security, DEFAULT_PREFS.security),
    infra: cat(p.infra, DEFAULT_PREFS.infra),
    recoveries: typeof p.recoveries === "boolean" ? p.recoveries : DEFAULT_PREFS.recoveries,
    soundCooldownSec: clampInt(p.soundCooldownSec, 0, 600, DEFAULT_PREFS.soundCooldownSec),
    maxToasts: clampInt(p.maxToasts, 1, 8, DEFAULT_PREFS.maxToasts),
    dndAllowCritical: typeof p.dndAllowCritical === "boolean" ? p.dndAllowCritical : DEFAULT_PREFS.dndAllowCritical,
    dndUntil: typeof p.dndUntil === "number" ? p.dndUntil : null,
    muted: typeof p.muted === "boolean" ? p.muted : false,
  };
}

/** La versión anterior sólo tenía `cia.alerts.sound` (on/off): si estaba apagado, se respetan ambos sonidos apagados. */
export function migrateLegacy(legacySound: unknown, prefs: AlertPrefs = DEFAULT_PREFS): AlertPrefs {
  if (legacySound === false || legacySound === "false") {
    return { ...prefs, security: { ...prefs.security, sound: "off" }, infra: { ...prefs.infra, sound: "off" } };
  }
  return prefs;
}

export function passes(item: Pick<NoticeItem, "severity" | "category">, prefs: AlertPrefs, channel: "toast" | "sound") {
  const th = prefs[item.category][channel];
  return th !== "off" && SEV_RANK[item.severity] >= SEV_RANK[th];
}

export function inDnd(prefs: AlertPrefs, now: number) {
  return prefs.dndUntil !== null && prefs.dndUntil > now;
}

export type SoundTone = "critical" | "security" | "infra";

export interface FilteredNotice {
  /** Ítems que esta consola muestra como aviso (vacío = no mostrar). */
  toastItems: NoticeItem[];
  playSound: boolean;
  tone: SoundTone | null;
}

/**
 * Aplica las preferencias a un aviso: umbral por categoría para aviso y sonido, "no molestar" (que puede dejar
 * pasar lo crítico), pausa entre sonidos (lo crítico respeta sólo una separación mínima) y recuperaciones.
 */
export function filterNotice(notice: AlertNotice, prefs: AlertPrefs, now: number, lastSoundAt = 0): FilteredNotice {
  const dnd = inDnd(prefs, now);
  if (notice.kind === "recovery") return { toastItems: prefs.recoveries && !dnd ? notice.items : [], playSound: false, tone: null };
  const allowed = (i: NoticeItem) => !dnd || (prefs.dndAllowCritical && i.severity === "critical");
  const toastItems = notice.items.filter((i) => allowed(i) && passes(i, prefs, "toast"));
  const soundItems = prefs.muted ? [] : notice.items.filter((i) => allowed(i) && passes(i, prefs, "sound"));
  if (!soundItems.length) return { toastItems, playSound: false, tone: null };
  const tone: SoundTone = soundItems.some((i) => i.severity === "critical") ? "critical" : soundItems.some((i) => i.category === "security") ? "security" : "infra";
  const gap = tone === "critical" ? CRITICAL_MIN_GAP_MS : prefs.soundCooldownSec * 1000;
  return { toastItems, playSound: now - lastSoundAt >= gap, tone };
}

/** Resumen para un aviso agrupado: "1 crítica · 2 altas". */
export function summarize(items: Array<Pick<NoticeItem, "severity">>) {
  const words: Record<Severity, [string, string]> = {
    critical: ["crítica", "críticas"],
    high: ["alta", "altas"],
    medium: ["media", "medias"],
    low: ["baja", "bajas"],
    info: ["informativa", "informativas"],
  };
  const counts = new Map<Severity, number>();
  for (const i of items) counts.set(i.severity, (counts.get(i.severity) ?? 0) + 1);
  return (["critical", "high", "medium", "low", "info"] as Severity[])
    .filter((s) => counts.get(s))
    .map((s) => `${counts.get(s)} ${words[s][counts.get(s)! > 1 ? 1 : 0]}`)
    .join(" · ");
}

/** Próximo instante con la hora indicada (para "No molestar hasta las 07:00"). */
export function nextAt(hour: number, now: number) {
  const d = new Date(now);
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}
