import crypto from "node:crypto";
import type { Bus } from "../realtime/bus.js";
import { OPEN_STATUSES, SEV_RANK, type EventCategory, type EventService, type NoticeReason, type Notifier, type PublicEvent, type Severity } from "./service.js";

export interface NoticeItem {
  eventId: number;
  severity: Severity;
  category: EventCategory;
  type: string;
  title: string;
  cameraName: string | null;
  reason: NoticeReason;
}

/** Aviso que reciben las consolas por el tópico `alert.notify` (cada consola decide si muestra/suena). */
export interface AlertNotice {
  id: string;
  ts: number;
  kind: "event" | "escalation" | "recovery" | "digest";
  severity: Severity;
  category: EventCategory | "mixed";
  title: string;
  body?: string;
  eventId?: number;
  cameraId?: string | null;
  count: number;
  /** Ítems ordenados por severidad (hasta 50) para que cada consola filtre según sus preferencias. */
  items: NoticeItem[];
}

interface Timers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (t: unknown) => void;
}

export interface HubOptions {
  coalesceMs: number;
  maxPerMinute: number;
  minSeverity: Severity;
}

const SEV_WORD: Record<Severity, string> = { info: "Info", low: "Baja", medium: "Media", high: "Alta", critical: "Crítica" };
const MAX_ITEMS = 50;

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (t) => clearTimeout(t as NodeJS.Timeout),
};

/**
 * Centro de notificaciones: decide QUÉ merece un aviso y lo agrupa.
 *  - Período de gracia por evento (p.ej. VPN): si se resuelve antes, no se avisa.
 *  - Agrupa lo que llega dentro de `coalesceMs` en un único aviso ("digest").
 *  - Límite de avisos por minuto (token bucket); el excedente se suma al próximo digest. Lo crítico no espera.
 */
export class NotificationHub implements Notifier {
  private buf = new Map<string, { ev: PublicEvent; reason: NoticeReason }>();
  private flushTimer: unknown = null;
  private delayed = new Map<number, unknown>();
  private tokens: number;
  private refillAt: number;
  private now: () => number;
  private timers: Timers;

  constructor(
    private bus: Bus,
    private events: EventService,
    private opts: () => HubOptions,
    deps: { now?: () => number; timers?: Timers } = {},
  ) {
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? defaultTimers;
    this.tokens = this.opts().maxPerMinute;
    this.refillAt = this.now();
  }

  offer(ev: PublicEvent, reason: NoticeReason, o: { delayMs?: number } = {}) {
    if (o.delayMs && o.delayMs > 0) {
      const prev = this.delayed.get(ev.id);
      if (prev) this.timers.clearTimeout(prev);
      this.delayed.set(
        ev.id,
        this.timers.setTimeout(() => {
          this.delayed.delete(ev.id);
          // Al vencer la gracia se relee: si ya se resolvió, se silenció o se avisó, no hay nada que decir.
          const cur = this.events.get(ev.id);
          if (!cur || !OPEN_STATUSES.includes(cur.status) || cur.silent || cur.notifiedAt) return;
          this.offer(cur, reason);
        }, o.delayMs),
      );
      return;
    }
    if (ev.silent) return;
    if (reason === "recovered") {
      if (!ev.notifiedAt) return;
    } else {
      if (SEV_RANK[ev.severity] < SEV_RANK[this.opts().minSeverity]) return;
      if (reason === "new" && ev.notifiedAt) return;
    }
    this.buf.set(`${reason === "recovered" ? "r" : "a"}:${ev.id}`, { ev, reason });
    if (this.flushTimer === null) this.flushTimer = this.timers.setTimeout(() => this.flush(), this.opts().coalesceMs);
  }

  /** Cancela una gracia pendiente (p.ej. el evento se cerró antes de vencer). */
  cancel(eventId: number) {
    const t = this.delayed.get(eventId);
    if (t) this.timers.clearTimeout(t);
    this.delayed.delete(eventId);
  }

  private refill() {
    const { maxPerMinute } = this.opts();
    const now = this.now();
    const per = 60_000 / maxPerMinute;
    const gained = Math.floor((now - this.refillAt) / per);
    if (gained > 0) {
      this.tokens = Math.min(maxPerMinute, this.tokens + gained);
      this.refillAt += gained * per;
    }
    if (this.tokens >= maxPerMinute) this.refillAt = now;
    return per - (now - this.refillAt);
  }

  /** Publica lo acumulado. Exportado para pruebas; normalmente lo dispara el temporizador de agrupación. */
  flush() {
    if (this.flushTimer !== null) this.timers.clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.buf.size) return;
    const all = [...this.buf.values()];
    const alerts = all.filter((i) => i.reason !== "recovered");
    const recoveries = all.filter((i) => i.reason === "recovered");
    const wait = this.refill();
    if (alerts.length) {
      const critical = alerts.some((i) => i.ev.severity === "critical");
      if (!critical && this.tokens < 1) {
        // Sin cupo: se conserva todo y se reintenta cuando haya un token (se publicará como un digest).
        this.flushTimer = this.timers.setTimeout(() => this.flush(), Math.max(50, wait));
        for (const r of recoveries) this.buf.delete(`r:${r.ev.id}`);
        if (recoveries.length) this.publish(recoveries);
        return;
      }
      if (!critical) this.tokens -= 1;
      this.publish(alerts);
    }
    if (recoveries.length) this.publish(recoveries);
    this.buf.clear();
  }

  private publish(list: Array<{ ev: PublicEvent; reason: NoticeReason }>) {
    const sorted = [...list].sort((a, b) => SEV_RANK[b.ev.severity] - SEV_RANK[a.ev.severity] || b.ev.id - a.ev.id);
    const top = sorted[0]!;
    const items: NoticeItem[] = sorted.slice(0, MAX_ITEMS).map(({ ev, reason }) => ({
      eventId: ev.id,
      severity: ev.severity,
      category: ev.category,
      type: ev.type,
      title: ev.title,
      cameraName: ev.cameraName,
      reason,
    }));
    const categories = new Set(sorted.map((i) => i.ev.category));
    const recovery = top.reason === "recovered";
    let notice: AlertNotice;
    if (sorted.length === 1) {
      const { ev, reason } = top;
      notice = {
        id: crypto.randomUUID(),
        ts: this.now(),
        kind: reason === "new" ? "event" : reason === "escalated" ? "escalation" : "recovery",
        severity: ev.severity,
        category: ev.category,
        title: reason === "escalated" ? `Escaló a ${SEV_WORD[ev.severity]}: ${ev.title}` : reason === "recovered" ? `Normalizado: ${ev.title}` : ev.title,
        body: ev.cameraName ? `Cámara: ${ev.cameraName}` : (ev.description ?? undefined),
        eventId: ev.id,
        cameraId: ev.cameraId,
        count: 1,
        items,
      };
    } else {
      const bySev = new Map<Severity, number>();
      for (const i of sorted) bySev.set(i.ev.severity, (bySev.get(i.ev.severity) ?? 0) + 1);
      notice = {
        id: crypto.randomUUID(),
        ts: this.now(),
        kind: recovery ? "recovery" : "digest",
        severity: top.ev.severity,
        category: categories.size === 1 ? top.ev.category : "mixed",
        title: recovery ? `${sorted.length} alertas normalizadas` : `${sorted.length} nuevas alertas`,
        body: [...bySev.entries()].map(([s, n]) => `${n} ${SEV_WORD[s].toLowerCase()}${n > 1 ? "s" : ""}`).join(" · "),
        count: sorted.length,
        items,
      };
    }
    this.bus.publish("alert.notify", notice);
    if (!recovery) this.events.markNotified(sorted.map((i) => i.ev.id));
  }

  /** Tras un reinicio: vuelve a ofrecer lo abierto que nunca se avisó (p.ej. si se reinició durante una gracia). */
  resumePending(db: { all: <T>(sql: string) => T[] }) {
    const rows = db.all<{ id: number }>(
      `SELECT id FROM events WHERE status IN ('new','ack','investigating') AND silent = 0 AND notified_at IS NULL
         AND severity IN ('medium','high','critical') ORDER BY id DESC LIMIT 200`,
    );
    for (const r of rows) {
      const ev = this.events.get(r.id);
      if (ev) this.offer(ev, "new");
    }
  }
}
