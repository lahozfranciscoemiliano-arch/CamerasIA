import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import type { Db } from "../db/index.js";
import type { Bus } from "../realtime/bus.js";

export interface HostRow {
  id: string;
  name: string;
  host: string;
  port: number;
  kind: string;
  enabled: number;
  last_status: string | null;
  last_latency_ms: number | null;
  last_checked_at: number | null;
  last_change_at: number | null;
  /** Último sondeo crudo (en memoria; el estado confirmado es last_status). */
  probe_ok?: boolean | null;
  /** Fallos seguidos todavía sin confirmar la caída. */
  fails?: number;
}

export interface HealthRules {
  hostDownAfterChecks: number;
  hostUpAfterChecks: number;
  hostProbeRetryMs: number;
}

type Probe = (host: string, port: number) => Promise<{ ok: boolean; latencyMs: number | null; error?: string }>;

export function tcpProbe(host: string, port: number, timeoutMs = 2500): Promise<{ ok: boolean; latencyMs: number | null; error?: string }> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const sock = net.connect({ host, port });
    const done = (ok: boolean, error?: string) => {
      sock.destroy();
      resolve({ ok, latencyMs: ok ? Math.round(performance.now() - t0) : null, error });
    };
    sock.setTimeout(timeoutMs, () => done(false, "timeout"));
    sock.once("connect", () => done(true));
    sock.once("error", (e) => done(false, e.message));
  });
}

/**
 * Monitoreo NOC: verifica por TCP los equipos críticos (servidores exacqVision, FortiGate, NVRs, switches)
 * y publica cambios de estado en tiempo real. También expone métricas del host del centro de monitoreo.
 */
export class HealthService {
  private timer?: NodeJS.Timeout;
  private cpuPrev = os.cpus().map((c) => c.times);
  // Histéresis por equipo: sondeos seguidos en contra del estado confirmado.
  private fails = new Map<string, number>();
  private oks = new Map<string, number>();
  private probeOk = new Map<string, boolean>();

  constructor(
    private db: Db,
    private bus: Bus,
    private opts: {
      demo: boolean;
      dataDir: string;
      onHostChange?: (h: HostRow, up: boolean) => void;
      /** Al terminar cada ronda de chequeos (reconciliación de alertas suprimidas). */
      onRound?: (hosts: HostRow[]) => void;
      rules?: () => HealthRules;
      probe?: Probe;
    },
  ) {}

  start() {
    void this.checkAll();
    this.timer = setInterval(() => void this.checkAll(), 30_000);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  list() {
    return this.db
      .all<HostRow>("SELECT * FROM monitored_hosts ORDER BY kind, name")
      .map((h) => ({ ...h, probe_ok: this.probeOk.get(h.id) ?? null, fails: this.fails.get(h.id) ?? 0 }));
  }

  add(input: { name: string; host: string; port: number; kind: string }) {
    const id = crypto.randomUUID();
    this.db.run("INSERT INTO monitored_hosts(id, name, host, port, kind, enabled) VALUES($id, $name, $host, $port, $kind, 1)", { id, ...input });
    void this.checkAll();
    return id;
  }

  remove(id: string) {
    this.db.run("DELETE FROM host_checks WHERE host_id = $id", { id });
    return this.db.run("DELETE FROM monitored_hosts WHERE id = $id", { id }).changes > 0;
  }

  history(id: string, sinceMs = 3600_000) {
    return this.db.all<{ ts: number; ok: number; latency_ms: number | null }>(
      "SELECT ts, ok, latency_ms FROM host_checks WHERE host_id = $id AND ts > $since ORDER BY ts",
      { id, since: Date.now() - sinceMs },
    );
  }

  private simulated(h: HostRow) {
    // En DEMO las IPs internas no existen: se simulan latencias plausibles con alguna caída ocasional.
    const minute = Math.floor(Date.now() / 60_000);
    const down = h.kind === "camera" && minute % 20 === 7;
    return { ok: !down, latencyMs: down ? null : Math.round(2 + Math.random() * (h.kind === "fortigate" ? 25 : 8)) };
  }

  private async probeOnce(h: HostRow) {
    if (this.opts.demo && h.host.startsWith("demo:")) return this.simulated(h);
    return (this.opts.probe ?? tcpProbe)(h.host, h.port);
  }

  /**
   * Chequea todos los equipos. Un sondeo fallido se reintenta una vez; la caída se confirma tras
   * `hostDownAfterChecks` chequeos fallidos seguidos y la recuperación tras `hostUpAfterChecks` correctos.
   * host_checks guarda siempre el resultado crudo (para los gráficos).
   */
  async checkAll() {
    const rules = this.opts.rules?.() ?? { hostDownAfterChecks: 3, hostUpAfterChecks: 2, hostProbeRetryMs: 500 };
    const hosts = this.list().filter((h) => h.enabled);
    const now = Date.now();
    await Promise.all(
      hosts.map(async (h) => {
        let r = await this.probeOnce(h);
        if (!r.ok) {
          if (rules.hostProbeRetryMs > 0) await new Promise((res) => setTimeout(res, rules.hostProbeRetryMs));
          r = await this.probeOnce(h);
        }
        this.probeOk.set(h.id, r.ok);
        const raw = r.ok ? "up" : "down";
        let status = h.last_status ?? raw;
        if (h.last_status !== null && raw !== h.last_status) {
          const counter = r.ok ? this.oks : this.fails;
          const n = (counter.get(h.id) ?? 0) + 1;
          counter.set(h.id, n);
          if (n >= (r.ok ? rules.hostUpAfterChecks : rules.hostDownAfterChecks)) status = raw;
        }
        if (raw === status) {
          this.fails.delete(h.id);
          this.oks.delete(h.id);
        } else (r.ok ? this.fails : this.oks).delete(h.id);
        const changed = h.last_status !== null && h.last_status !== status;
        this.db.run(
          "UPDATE monitored_hosts SET last_status = $s, last_latency_ms = $l, last_checked_at = $now, last_change_at = CASE WHEN $changed THEN $now ELSE COALESCE(last_change_at, $now) END WHERE id = $id",
          { s: status, l: r.latencyMs, now, changed, id: h.id },
        );
        this.db.run("INSERT INTO host_checks(host_id, ts, ok, latency_ms) VALUES($id, $now, $ok, $l)", { id: h.id, now, ok: r.ok, l: r.latencyMs });
        if (changed) this.opts.onHostChange?.({ ...h, last_status: status }, status === "up");
      }),
    );
    this.db.run("DELETE FROM host_checks WHERE ts < $cutoff", { cutoff: now - 24 * 3600_000 });
    const all = this.list();
    this.opts.onRound?.(all);
    this.bus.publish("health.update", { hosts: all.map(publicHost), system: this.system() });
  }

  seedDemo() {
    const n = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM monitored_hosts")!.n;
    if (n > 0) return;
    const hosts = [
      { name: "exacqVision Principal", host: "demo:192.168.109.58", port: 80, kind: "exacq" },
      { name: "exacqVision Depósito", host: "demo:192.168.109.59", port: 80, kind: "exacq" },
      { name: "FortiGate 100F", host: "demo:vpn.empresa.com", port: 443, kind: "fortigate" },
      { name: "Switch Core", host: "demo:192.168.109.1", port: 22, kind: "switch" },
      { name: "NVR Perímetro", host: "demo:192.168.109.70", port: 80, kind: "nvr" },
      { name: "Cámara PTZ Acceso", host: "demo:192.168.109.101", port: 554, kind: "camera" },
    ];
    for (const h of hosts) this.add(h);
  }

  system() {
    const cpus = os.cpus();
    const now = cpus.map((c) => c.times);
    let idle = 0;
    let total = 0;
    now.forEach((t, i) => {
      const p = this.cpuPrev[i] ?? t;
      const tot = t.user + t.nice + t.sys + t.idle + t.irq - (p.user + p.nice + p.sys + p.idle + p.irq);
      idle += t.idle - p.idle;
      total += tot;
    });
    this.cpuPrev = now;
    let disk: { total: number; free: number } | null = null;
    try {
      const s = fs.statfsSync(this.opts.dataDir);
      disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
    } catch {
      disk = null;
    }
    return {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
      uptimeSec: Math.round(os.uptime()),
      processUptimeSec: Math.round(process.uptime()),
      cpuPct: total > 0 ? Math.round((1 - idle / total) * 100) : 0,
      cores: cpus.length,
      load: os.loadavg(),
      memTotal: os.totalmem(),
      memFree: os.freemem(),
      rss: process.memoryUsage().rss,
      disk,
    };
  }
}

export const publicHost = (h: HostRow) => ({
  id: h.id,
  name: h.name,
  host: h.host.replace(/^demo:/, ""),
  port: h.port,
  kind: h.kind,
  enabled: Boolean(h.enabled),
  status: h.last_status ?? "unknown",
  latencyMs: h.last_latency_ms,
  checkedAt: h.last_checked_at,
  changedAt: h.last_change_at,
  simulated: h.host.startsWith("demo:"),
  probeOk: h.probe_ok ?? null,
  unstable: Boolean(h.fails) && h.last_status === "up",
});
