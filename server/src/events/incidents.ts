import type { Db } from "../db/index.js";
import type { CameraRow, OfflineCamera } from "../exacq/service.js";
import type { HostRow } from "../health/service.js";
import type { VpnStatus } from "../vpn/manager.js";
import type { EventRow, EventService, Severity } from "./service.js";
import type { AlertSettings } from "./settings.js";

/** Duración legible: "45 s", "3 min", "1 h 5 min". */
export function fmtDur(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

const hhmm = (ts: number) => new Date(ts).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false });
const hostnameOf = (host: string) => host.replace(/^demo:/, "").toLowerCase();

const HOST_SEVERITY: Record<string, Severity> = {
  camera: "low",
  server: "medium",
  other: "medium",
  exacq: "high",
  nvr: "high",
  fortigate: "high",
  switch: "high",
};

export interface IncidentDeps {
  db: Db;
  events: EventService;
  settings: () => AlertSettings;
  vpnStatus: () => Pick<VpnStatus, "state" | "mode">;
  /** Hostname del Web Service de una fuente (para no duplicar "servidor caído" con "equipo caído"). */
  sourceHost?: (sourceId: string) => string | undefined;
  now?: () => number;
}

/**
 * Política de alertas de infraestructura en un solo lugar: los servicios sólo informan estado y aquí se decide
 * qué evento crear, cómo agruparlo, qué suprimir (todo lo que está detrás de la VPN mientras el túnel está caído)
 * y cómo cerrarlo en silencio al recuperarse (sin eventos "volvió", sólo una nota en el evento original).
 */
export class IncidentManager {
  private vpnDownSince: number | null = null;
  private vpnEventId: number | null = null;
  private downSources = new Map<string, { name: string; host?: string; since: number }>();
  private suppressedHosts = new Set<string>();
  private timer?: NodeJS.Timeout;
  private now: () => number;

  constructor(private d: IncidentDeps) {
    this.now = d.now ?? Date.now;
    // Tras un reinicio con el túnel caído, se sigue suprimiendo lo que está detrás hasta que vuelva.
    const open = this.openVpnEvent();
    if (open) {
      this.vpnDownSince = open.last_ts ?? open.ts;
      this.vpnEventId = open.id;
    }
  }

  start() {
    this.timer = setInterval(() => this.tick(), 15_000);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  private get s() {
    return this.d.settings();
  }

  private openVpnEvent() {
    return this.d.db.get<EventRow>("SELECT * FROM events WHERE dedupe_key = 'vpn_down' AND status IN ('new','ack','investigating') ORDER BY id DESC LIMIT 1");
  }

  /** La red interna está inalcanzable porque el túnel se cayó (o se cerró) y todavía no volvió. */
  lanDown() {
    if (this.vpnDownSince === null) return false;
    const st = this.d.vpnStatus();
    return st.mode !== "disabled" && st.state !== "connected";
  }

  private link(cameraIds: string[], eventId: number | null) {
    if (!cameraIds.length) return;
    const placeholders = cameraIds.map((_, i) => `$c${i}`).join(",");
    const params: Record<string, string | number | null> = { e: eventId };
    cameraIds.forEach((id, i) => (params[`c${i}`] = id));
    this.d.db.run(`UPDATE cameras SET offline_event_id = $e WHERE id IN (${placeholders})`, params);
  }

  private mergeVpnImpact(sourceName: string | null, cameras: number) {
    if (this.vpnEventId === null) return;
    const ev = this.d.events.row(this.vpnEventId);
    if (!ev || !["new", "ack", "investigating"].includes(ev.status)) return;
    const meta = ev.meta ? (JSON.parse(ev.meta) as { impact?: { sources?: string[]; cameras?: number } }) : {};
    const impact = { sources: meta.impact?.sources ?? [], cameras: meta.impact?.cameras ?? 0 };
    if (sourceName && !impact.sources.includes(sourceName)) impact.sources.push(sourceName);
    impact.cameras += cameras;
    this.d.events.enrich(ev.id, { meta: { impact } });
  }

  // ───────── Cámaras ─────────

  onCamerasOffline(src: { id: string; name: string }, cams: OfflineCamera[]) {
    const now = this.now();
    const s = this.s;
    const reopenWithinMs = s.reopenWindowMin * 60_000;
    const muted = cams.filter((c) => c.alerts_muted_until && c.alerts_muted_until > now);
    const active = cams.filter((c) => !muted.includes(c));
    // Silenciadas: se registran (silent) para el historial, sin avisar ni sumar al badge.
    for (const c of muted) {
      const { ev } = this.d.events.upsert({
        type: "camera_offline",
        severity: "medium",
        source: "sistema",
        cameraId: c.id,
        title: `Cámara ${c.name} sin señal`,
        description: "Cámara con alertas silenciadas.",
        silent: true,
        dedupeKey: `camera_offline:${c.id}`,
        reopenWithinMs,
        meta: { sourceId: src.id },
      });
      this.link([c.id], ev.id);
    }
    if (!active.length) return;
    if (this.lanDown()) {
      this.mergeVpnImpact(null, active.length);
      this.link(
        active.map((c) => c.id),
        this.vpnEventId,
      );
      return;
    }
    if (active.length >= s.groupMinCameras) {
      const names = active.map((c) => c.name);
      const allRemoved = active.every((c) => c.reason === "removed");
      const list = names.slice(0, 10).join(", ") + (names.length > 10 ? ` y ${names.length - 10} más` : "");
      const { ev } = this.d.events.upsert({
        type: "camera_offline",
        severity: "high",
        source: "sistema",
        cameraId: null,
        title: `${active.length} cámaras sin señal en ${src.name}`,
        description: allRemoved ? `${list}: ya no figuran en el servidor (¿permisos del usuario exacq?).` : `${list}.`,
        meta: { group: true, sourceId: src.id, cameras: active.map((c) => ({ id: c.id, name: c.name })), recovered: [] },
        dedupeKey: `camera_offline_group:${src.id}:${now}`,
      });
      this.link(
        active.map((c) => c.id),
        ev.id,
      );
      return;
    }
    for (const c of active) {
      const { ev } = this.d.events.upsert({
        type: "camera_offline",
        severity: "medium",
        source: "sistema",
        cameraId: c.id,
        title: `Cámara ${c.name} sin señal`,
        description:
          c.reason === "removed" ? "La cámara ya no figura en el servidor de video (¿permisos del usuario exacq?)." : "La cámara dejó de transmitir en el servidor de video.",
        meta: { sourceId: src.id },
        dedupeKey: `camera_offline:${c.id}`,
        reopenWithinMs,
      });
      this.link([c.id], ev.id);
    }
  }

  /** Libera una cámara de su evento de caída; cierra el evento si era individual o si era el último del grupo. */
  private release(cam: CameraRow, note: (downMs: number) => string, patch?: { silent?: boolean }) {
    const eventId = cam.offline_event_id;
    this.link([cam.id], null);
    if (eventId === null) return;
    const ev = this.d.events.row(eventId);
    if (!ev || !["new", "ack", "investigating"].includes(ev.status)) return;
    // La caída de un servidor o de la VPN se cierra cuando vuelve el servidor / el túnel.
    if (ev.type === "source_down" || ev.type === "vpn_down") return;
    const downMs = this.now() - (ev.last_ts ?? ev.ts);
    const meta = ev.meta ? (JSON.parse(ev.meta) as { group?: boolean; recovered?: Array<{ id: string; name: string }> }) : {};
    if (meta.group) {
      const recovered = [...(meta.recovered ?? []).filter((r) => r.id !== cam.id), { id: cam.id, name: cam.name }];
      this.d.events.enrich(ev.id, { meta: { recovered } });
      const left = this.d.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM cameras WHERE offline_event_id = $e", { e: ev.id })!.n;
      if (left === 0) this.d.events.resolveBySystem(ev.id, `Todas las cámaras recuperaron señal tras ${fmtDur(downMs)}`);
      return;
    }
    this.d.events.resolveBySystem(ev.id, note(downMs), patch);
  }

  onCamerasOnline(cams: CameraRow[]) {
    for (const c of cams) this.release(c, (ms) => `Recuperó señal tras ${fmtDur(ms)}`);
  }

  onVmsDisabled(cams: CameraRow[]) {
    for (const c of cams) {
      this.release(c, () => "Deshabilitada en exacqVision", { silent: true });
      this.d.events.resolveByKey(`camera_offline:${c.id}`, "Deshabilitada en exacqVision", { silent: true });
    }
  }

  // ───────── Servidores de video ─────────

  onSourceDown(src: { id: string; name: string }, affected: CameraRow[], err: string, since: number) {
    this.downSources.set(src.id, { name: src.name, host: this.d.sourceHost?.(src.id)?.toLowerCase(), since });
    const ids = affected.map((c) => c.id);
    if (this.lanDown()) {
      this.mergeVpnImpact(src.name, affected.length);
      this.link(ids, this.vpnEventId);
      return;
    }
    const { ev } = this.d.events.upsert({
      type: "source_down",
      severity: "high",
      source: "sistema",
      title: `Sin conexión con ${src.name}`,
      description: `Sin video de ${affected.length} cámaras desde las ${hhmm(since)}. ${err}`.trim(),
      meta: { sourceId: src.id, affectedCount: affected.length, cameras: affected.slice(0, 100).map((c) => ({ id: c.id, name: c.name })) },
      dedupeKey: `source_down:${src.id}`,
    });
    this.link(ids, ev.id);
  }

  onSourceUp(src: { id: string; name: string }, stillOffline: CameraRow[], downMs: number) {
    this.downSources.delete(src.id);
    const k = stillOffline.length;
    this.d.events.resolveByKey(`source_down:${src.id}`, `Conexión restablecida tras ${fmtDur(downMs)}${k ? `; ${k} cámaras siguen sin señal` : ""}`);
    // Las cámaras que siguen sin señal se vuelven a evaluar (y avisar) por su cuenta.
    this.d.db.run(
      "UPDATE cameras SET offline_event_id = NULL WHERE server_id = $sid AND offline_event_id IN (SELECT id FROM events WHERE type IN ('source_down','vpn_down'))",
      { sid: src.id },
    );
  }

  // ───────── VPN ─────────

  onVpnDown(st: Pick<VpnStatus, "profileName" | "error">, unexpected: boolean) {
    this.vpnDownSince = this.now();
    if (!unexpected) {
      const ev = this.d.events.create({
        type: "vpn_down",
        severity: "info",
        source: "vpn",
        silent: true,
        title: `Túnel FortiVPN cerrado manualmente (${st.profileName ?? "-"})`,
      });
      this.d.events.resolveBySystem(ev.id, "Cierre manual");
      this.vpnEventId = ev.id;
      return;
    }
    const s = this.s;
    const { ev } = this.d.events.upsert({
      type: "vpn_down",
      severity: "high",
      source: "vpn",
      title: `Se cayó el túnel FortiVPN (${st.profileName ?? "-"})`,
      description: st.error ?? undefined,
      meta: { impact: { sources: [], cameras: 0 } },
      dedupeKey: "vpn_down",
      reopenWithinMs: s.reopenWindowMin * 60_000,
      notifyAfterMs: s.vpnDownGraceSec * 1000,
    });
    this.vpnEventId = ev.id;
  }

  onVpnUp() {
    this.vpnDownSince = null;
    const open = this.openVpnEvent();
    if (open) {
      const downMs = this.now() - (open.last_ts ?? open.ts);
      if (downMs < this.s.vpnDownGraceSec * 1000 && !open.notified_at) {
        // Microcorte: no se avisó a nadie y no queda nada pendiente.
        this.d.events.resolveBySystem(open.id, `Microcorte de ${fmtDur(downMs)}`, { severity: "low", silent: true, title: `Microcorte del túnel FortiVPN (${fmtDur(downMs)})` });
      } else {
        this.d.events.resolveBySystem(open.id, `Túnel restablecido tras ${fmtDur(downMs)}`);
      }
    }
    this.d.db.run("UPDATE cameras SET offline_event_id = NULL WHERE offline_event_id IN (SELECT id FROM events WHERE type = 'vpn_down')");
    this.vpnEventId = null;
  }

  // ───────── Equipos monitoreados ─────────

  private hostSuppressed(h: HostRow) {
    if (this.lanDown() && h.kind !== "fortigate") return true;
    if (h.kind === "exacq") {
      const name = hostnameOf(h.host);
      for (const src of this.downSources.values()) if (src.host && src.host === name) return true;
    }
    return false;
  }

  private hostDown(h: HostRow) {
    this.d.events.upsert({
      type: "host_down",
      severity: HOST_SEVERITY[h.kind] ?? "medium",
      source: "noc",
      title: `${h.name} no responde (${hostnameOf(h.host)}:${h.port})`,
      meta: { hostId: h.id },
      dedupeKey: `host_down:${h.id}`,
      reopenWithinMs: this.s.reopenWindowMin * 60_000,
    });
  }

  onHostChange(h: HostRow, up: boolean) {
    if (up) {
      this.suppressedHosts.delete(h.id);
      this.d.events.resolveByKey(`host_down:${h.id}`, (row) => `Volvió a responder tras ${fmtDur(this.now() - (row.last_ts ?? row.ts))}`);
      return;
    }
    if (this.hostSuppressed(h)) {
      this.suppressedHosts.add(h.id);
      return;
    }
    this.hostDown(h);
  }

  /** En cada ronda de chequeos: los equipos que se suprimieron y siguen caídos al dejar de estar suprimidos, alertan. */
  reconcileHosts(hosts: HostRow[]) {
    for (const id of [...this.suppressedHosts]) {
      const h = hosts.find((x) => x.id === id);
      if (!h || h.last_status !== "down") {
        this.suppressedHosts.delete(id);
        continue;
      }
      if (!this.hostSuppressed(h)) {
        this.suppressedHosts.delete(id);
        this.hostDown(h);
      }
    }
  }

  // ───────── Escalamiento ─────────

  /** Escala a crítica una caída de servidor o de VPN que se prolonga (notifica como escalamiento). */
  tick() {
    const s = this.s;
    const now = this.now();
    const rows = this.d.db.all<EventRow>(
      `SELECT * FROM events WHERE status IN ('new','ack','investigating') AND silent = 0 AND severity = 'high'
         AND (type = 'source_down' OR dedupe_key = 'vpn_down')`,
    );
    for (const r of rows) {
      const afterMin = r.type === "source_down" ? s.sourceCriticalAfterMin : s.vpnCriticalAfterMin;
      if (now - (r.last_ts ?? r.ts) >= afterMin * 60_000) this.d.events.enrich(r.id, { severity: "critical" });
    }
  }
}
