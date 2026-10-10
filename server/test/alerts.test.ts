import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import jpeg from "jpeg-js";
import { Db } from "../src/db/index.js";
import { Bus, type RealtimeMessage } from "../src/realtime/bus.js";
import { KeyRing } from "../src/security/crypto.js";
import { VaultService } from "../src/vault/service.js";
import { CameraService } from "../src/exacq/service.js";
import { AvailabilityTracker } from "../src/exacq/availability.js";
import type { CameraInfo, VideoSource } from "../src/exacq/types.js";
import { EventService, type PublicEvent } from "../src/events/service.js";
import { NotificationHub, type AlertNotice } from "../src/events/notify.js";
import { IncidentManager } from "../src/events/incidents.js";
import { AlertSettingsStore } from "../src/events/settings.js";
import { HealthService, type HostRow } from "../src/health/service.js";
import { DetectionEngine } from "../src/detection/engine.js";
import type { AiService } from "../src/ai/service.js";

// ───────── Utilidades: reloj y temporizadores falsos, fuente de video simulada ─────────

class Clock {
  t = Date.UTC(2026, 9, 10, 12, 0, 0);
  private q: Array<{ at: number; fn: () => void; id: number }> = [];
  private seq = 0;
  now = () => this.t;
  timers = {
    setTimeout: (fn: () => void, ms: number) => {
      const id = ++this.seq;
      this.q.push({ at: this.t + ms, fn, id });
      return id;
    },
    clearTimeout: (id: unknown) => {
      this.q = this.q.filter((x) => x.id !== id);
    },
  };
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.q.sort((a, b) => a.at - b.at);
      const next = this.q[0];
      if (!next || next.at > end) break;
      this.q.shift();
      this.t = Math.max(this.t, next.at);
      next.fn();
    }
    this.t = end;
  }
}

class FakeSource implements VideoSource {
  readonly kind = "exacq" as const;
  cams: CameraInfo[] = [];
  fail = false;
  delayMs = 0;
  ok = true;
  constructor(
    readonly id: string,
    readonly name: string,
  ) {}
  async listCameras() {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.fail) throw new Error("Tiempo de espera agotado");
    return this.cams.map((c) => ({ ...c }));
  }
  async snapshot(): Promise<never> {
    throw new Error("sin video");
  }
  async searchRecordings() {
    return [];
  }
  status() {
    return { ok: this.ok, detail: this.ok ? "OK" : "error de snapshot", lastOkAt: null };
  }
  set(id: string, patch: Partial<CameraInfo>) {
    const c = this.cams.find((x) => x.cameraId === id)!;
    Object.assign(c, patch);
  }
}

function setup(opts: { vpnState?: "connected" | "error" | "disconnected" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cia-alerts-"));
  const db = new Db(":memory:");
  const bus = new Bus();
  const msgs: RealtimeMessage[] = [];
  bus.on("message", (m: RealtimeMessage) => msgs.push(m));
  const clock = new Clock();
  const settings = new AlertSettingsStore(db);
  const vault = new VaultService(db, new KeyRing({ 1: crypto.randomBytes(32) }, 1));
  const vpn = { state: opts.vpnState ?? "connected", mode: "simulate" as const };
  let incidents!: IncidentManager;
  const cameras = new CameraService(db, vault, bus, {
    demo: false,
    exportsDir: path.join(dir, "exports"),
    log: () => undefined,
    now: clock.now,
    onCamerasOffline: (src, cams) => incidents.onCamerasOffline(src, cams),
    onCamerasOnline: (cams) => incidents.onCamerasOnline(cams),
    onSourceDown: (src, affected, err, since) => incidents.onSourceDown(src, affected, err, since),
    onSourceUp: (src, still, ms) => incidents.onSourceUp(src, still, ms),
    onVmsDisabled: (cams) => incidents.onVmsDisabled(cams),
    availability: () => {
      const s = settings.get();
      return { cameraMinSyncs: s.cameraOfflineMinSyncs, cameraAfterMs: s.cameraOfflineAfterSec * 1000, sourceMinSyncs: s.sourceDownMinSyncs, sourceAfterMs: s.sourceDownAfterSec * 1000 };
    },
  });
  const events = new EventService(db, bus, path.join(dir, "snaps"), (id) => cameras.row(id)?.name, { cameraMuted: (id) => cameras.isMuted(id), now: clock.now });
  const hub = new NotificationHub(
    bus,
    events,
    () => {
      const s = settings.get();
      return { coalesceMs: s.notifyCoalesceMs, maxPerMinute: s.maxNotificationsPerMin, minSeverity: s.notifyMinSeverity };
    },
    { now: clock.now, timers: clock.timers },
  );
  events.setNotifier(hub);
  incidents = new IncidentManager({ db, events, settings: () => settings.get(), vpnStatus: () => vpn, sourceHost: () => "192.168.109.58", now: clock.now });
  const topic = (t: string) => msgs.filter((m) => m.topic === t);
  const notices = () => topic("alert.notify").map((m) => m.data as AlertNotice);
  const ev = (id: number) => events.get(id)!;
  const cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { dir, db, bus, msgs, clock, settings, cameras, events, hub, incidents, vpn, topic, notices, ev, cleanup };
}

type H = ReturnType<typeof setup>;

function addSource(h: H, id: string, n: number, name = `exacq ${id}`) {
  const src = new FakeSource(id, name);
  src.cams = Array.from({ length: n }, (_, i) => ({ cameraId: String(i + 1), name: `Cam ${id}${i + 1}`, online: true }));
  h.cameras.sources.set(id, src);
  return src;
}

/** Avanza 30 s (una sincronización) y sincroniza. */
async function syncStep(h: H, ms = 30_000) {
  h.clock.advance(ms);
  await h.cameras.sync();
}

const offlineEvents = (h: H) => h.events.list({ type: "camera_offline", limit: 500 });

// ───────── 1. Histéresis de cámaras ─────────

test("histéresis: una cámara sólo se da por caída tras 3 sincronizaciones y 60 s; reabre con ocurrencias", async () => {
  const h = setup();
  try {
    const src = addSource(h, "a", 3);
    await h.cameras.sync();
    src.set("1", { online: false });
    await syncStep(h);
    await syncStep(h);
    assert.equal(offlineEvents(h).length, 0, "1-2 sincronizaciones: sin evento");
    assert.equal(h.cameras.row("a:1")!.online, 1, "sin cambio de estado mientras está pendiente");
    await syncStep(h);
    const evs = offlineEvents(h);
    assert.equal(evs.length, 1);
    assert.equal(evs[0]!.severity, "medium");
    assert.equal(h.cameras.row("a:1")!.online, 0);
    assert.equal(h.cameras.row("a:1")!.offline_event_id, evs[0]!.id);

    // Intermitente off/on/off/on → nada.
    for (const online of [false, true, false, true, false, true]) {
      src.set("2", { online });
      await syncStep(h);
    }
    assert.equal(offlineEvents(h).length, 1);

    // Recupera: se cierra en silencio, sin evento "volvió".
    src.set("1", { online: true });
    await syncStep(h);
    assert.equal(h.ev(evs[0]!.id).status, "resolved");
    assert.equal(h.ev(evs[0]!.id).resolvedBy, "sistema");
    assert.equal(h.events.list({ type: "camera_online" }).length, 0);

    // Vuelve a caer dentro de 10 min → mismo evento, reabierto.
    for (let round = 2; round <= 3; round++) {
      src.set("1", { online: false });
      await syncStep(h);
      await syncStep(h);
      await syncStep(h);
      const again = offlineEvents(h);
      assert.equal(again.length, 1, "reabre el mismo evento");
      assert.equal(again[0]!.occurrences, round);
      assert.equal(again[0]!.status, "new");
      if (round === 3) assert.equal(again[0]!.meta?.flapping, true, "marcado como inestable");
      src.set("1", { online: true });
      await syncStep(h);
    }
  } finally {
    h.cleanup();
  }
});

test("AvailabilityTracker: confirma por cantidad y por tiempo", () => {
  const t = new AvailabilityTracker(() => ({ cameraMinSyncs: 3, cameraAfterMs: 60_000, sourceMinSyncs: 3, sourceAfterMs: 60_000 }));
  assert.equal(t.cameraObserved("x", false, 0), "pending");
  assert.equal(t.cameraObserved("x", false, 1000), "pending");
  assert.equal(t.cameraObserved("x", false, 2000), "pending", "3 observaciones pero menos de 60 s");
  assert.equal(t.cameraObserved("x", false, 60_000), "confirm_offline");
  assert.equal(t.cameraObserved("x", true, 61_000), "online");
  assert.equal(t.sourceFailed("s", 0), "pending");
  assert.equal(t.sourceFailed("s", 30_000), "pending");
  assert.equal(t.sourceFailed("s", 60_000), "confirm_down");
  assert.equal(t.sourceFailed("s", 90_000), "already_down");
  assert.equal(t.sourceOk("s"), "recovered");
  assert.equal(t.sourceOk("s"), "ok");
});

// ───────── 2. Caída de un servidor de video ─────────

test("caída de la fuente: un único source_down, sin eventos por cámara, escala a crítica y cierra en silencio", async () => {
  const h = setup();
  try {
    const src = addSource(h, "a", 5);
    await h.cameras.sync();
    src.fail = true;
    await syncStep(h);
    assert.equal(h.topic("event.new").length, 0, "un fallo aislado no alerta");
    await syncStep(h);
    await syncStep(h);
    const down = h.events.list({ type: "source_down" });
    assert.equal(down.length, 1);
    assert.equal(down[0]!.meta?.affectedCount, 5);
    assert.equal(offlineEvents(h).length, 0);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM cameras WHERE online = 1")!.n, 0);
    assert.equal(h.topic("event.new").length, 1);
    h.clock.advance(2000);
    assert.equal(h.notices().length, 1, "un solo aviso");

    // Sigue caído: a los 10 min escala a crítica y avisa como escalamiento.
    await syncStep(h, 10 * 60_000);
    h.incidents.tick();
    assert.equal(h.ev(down[0]!.id).severity, "critical");
    h.clock.advance(2000);
    assert.equal(h.notices().at(-1)!.kind, "escalation");

    src.fail = false;
    await syncStep(h);
    assert.equal(h.ev(down[0]!.id).status, "resolved");
    assert.equal(h.events.list({ type: "camera_online" }).length, 0);
    assert.equal(h.topic("event.new").length, 1, "la recuperación no crea eventos");
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM cameras WHERE online = 1")!.n, 5);
    h.clock.advance(2000);
    assert.equal(h.notices().at(-1)!.kind, "recovery");
  } finally {
    h.cleanup();
  }
});

// ───────── 3. Regresión F12: el estado de snapshots no marca caída una fuente que listó bien ─────────

test("multi-fuente: una fuente que listó bien no se marca caída por errores de snapshot", async () => {
  const h = setup();
  try {
    const a = addSource(h, "a", 2);
    const b = addSource(h, "b", 2);
    a.ok = false; // un snapshot falló y su status() quedó en error
    b.delayMs = 20;
    for (let i = 0; i < 5; i++) await syncStep(h);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM cameras WHERE server_id = 'a' AND online = 1")!.n, 2);
    assert.equal(h.topic("event.new").length, 0);
  } finally {
    h.cleanup();
  }
});

// ───────── 4. Deshabilitadas en exacqVision ─────────

test("deshabilitadas en exacq: nunca alertan, no se listan y su caída abierta se cierra en silencio", async () => {
  const h = setup();
  try {
    const src = addSource(h, "a", 3);
    src.set("3", { online: false, disabled: true });
    await h.cameras.sync();
    for (let i = 0; i < 6; i++) await syncStep(h);
    assert.equal(h.topic("event.new").length, 0);
    assert.deepEqual(h.cameras.list().map((c) => c.id), ["a:1", "a:2"]);
    assert.equal(h.cameras.list({ includeVmsDisabled: true }).length, 3);
    assert.equal(h.cameras.list({ includeVmsDisabled: true }).find((c) => c.id === "a:3")!.vmsDisabled, true);

    src.set("1", { online: false });
    for (let i = 0; i < 3; i++) await syncStep(h);
    const [off] = offlineEvents(h);
    assert.ok(off);
    src.set("1", { disabled: true });
    await syncStep(h);
    assert.equal(h.ev(off.id).status, "resolved");
    assert.equal(h.ev(off.id).silent, true);
    assert.equal(h.cameras.list().length, 1);
  } finally {
    h.cleanup();
  }
});

// ───────── 5. Agrupación ─────────

test("agrupación: 4 cámaras caídas en la misma sincronización son un único evento", async () => {
  const h = setup();
  try {
    const src = addSource(h, "a", 6);
    await h.cameras.sync();
    for (const id of ["1", "2", "3", "4"]) src.set(id, { online: false });
    for (let i = 0; i < 3; i++) await syncStep(h);
    const evs = offlineEvents(h);
    assert.equal(evs.length, 1);
    const group = evs[0]!;
    assert.equal(group.severity, "high");
    assert.equal((group.meta?.cameras as unknown[]).length, 4);
    assert.match(group.title, /4 cámaras sin señal/);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM cameras WHERE offline_event_id = $e", { e: group.id })!.n, 4);
    src.set("1", { online: true });
    src.set("2", { online: true });
    await syncStep(h);
    assert.equal(h.ev(group.id).status, "new");
    assert.equal((h.ev(group.id).meta?.recovered as unknown[]).length, 2);
    src.set("3", { online: true });
    src.set("4", { online: true });
    await syncStep(h);
    assert.equal(h.ev(group.id).status, "resolved");
  } finally {
    h.cleanup();
  }
});

// ───────── 6-7. Deduplicación y resolveByKey ─────────

test("deduplicación: misma clave suma ocurrencias; tras la ventana o un cierre manual crea otro", () => {
  const h = setup();
  try {
    const offers: Array<{ id: number; reason: string }> = [];
    h.events.setNotifier({ offer: (ev: PublicEvent, reason) => offers.push({ id: ev.id, reason }) });
    const base = { type: "motion" as const, severity: "low" as const, source: "motor", title: "Movimiento", dedupeKey: "motion:x", dedupeWindowMs: 10 * 60_000 };
    const a = h.events.upsert(base);
    h.clock.advance(60_000);
    const b = h.events.upsert(base);
    assert.equal(b.ev.id, a.ev.id);
    assert.equal(b.ev.occurrences, 2);
    assert.equal(b.created, false);
    assert.equal(h.topic("event.new").length, 1);
    assert.equal(h.topic("event.update").length, 1);
    // Severidad: queda la máxima; si sube se notifica como escalamiento.
    const c = h.events.upsert({ ...base, severity: "high" });
    assert.equal(c.ev.severity, "high");
    assert.equal(c.escalated, true);
    assert.deepEqual(offers.at(-1), { id: a.ev.id, reason: "escalated" });
    const d = h.events.upsert(base);
    assert.equal(d.ev.severity, "high", "nunca baja");
    // Fuera de la ventana → otro evento.
    h.clock.advance(11 * 60_000);
    const e = h.events.upsert(base);
    assert.notEqual(e.ev.id, a.ev.id);
    // Cerrado a mano → otro evento.
    h.events.setStatus(e.ev.id, "resolved", "op");
    const f = h.events.upsert(base);
    assert.notEqual(f.ev.id, e.ev.id);
  } finally {
    h.cleanup();
  }
});

test("resolveByKey funciona con más de 20 eventos abiertos del mismo tipo", () => {
  const h = setup();
  try {
    const target = h.events.create({ type: "host_down", severity: "high", source: "noc", title: "Objetivo", dedupeKey: "host_down:target", meta: { hostId: "target" } });
    const legacy = h.events.create({ type: "host_down", severity: "high", source: "noc", title: "Legado", meta: { hostId: "legacy" } });
    for (let i = 0; i < 25; i++) h.events.create({ type: "host_down", severity: "high", source: "noc", title: `Otro ${i}`, dedupeKey: `host_down:h${i}`, meta: { hostId: `h${i}` } });
    assert.equal(h.events.resolveByKey("host_down:target", "Volvió").length, 1);
    assert.equal(h.ev(target.id).status, "resolved");
    assert.equal(h.ev(target.id).ackAt, null, "el cierre automático no cuenta para el MTTA");
    assert.equal(h.events.notes(target.id).length, 1);
    h.events.autoResolve("host_down", null, "legacy");
    assert.equal(h.ev(legacy.id).status, "resolved");
    assert.equal(h.events.list({ type: "host_down", status: "open", limit: 500 }).length, 25);
  } finally {
    h.cleanup();
  }
});

// ───────── 8. Acciones masivas ─────────

test("bulkStatus: reconocer sólo cambia los nuevos, filtro con tope, dryRun y un único event.bulk", () => {
  const h = setup();
  try {
    const mk = (title: string) => h.events.create({ type: "person", severity: "high", source: "t", title });
    const a = mk("a");
    const b = mk("b");
    const c = mk("c");
    h.events.resolveBySystem(b.id, "auto");
    h.events.setStatus(c.id, "investigating", "op");
    const before = h.ev(b.id);
    const r = h.events.bulkStatus({ ids: [a.id, b.id, c.id], status: "ack", user: "op" });
    assert.deepEqual(r.ids, [a.id]);
    assert.equal(h.ev(a.id).status, "ack");
    assert.equal(h.ev(b.id).status, "resolved");
    assert.equal(h.ev(b.id).resolvedBy, before.resolvedBy);
    assert.equal(h.ev(b.id).resolvedAt, before.resolvedAt);
    assert.equal(h.ev(c.id).status, "investigating");
    assert.equal(h.topic("event.bulk").length, 1);

    const dry = h.events.bulkStatus({ filter: { status: "open" }, status: "resolved", user: "op", dryRun: true });
    assert.equal(dry.count, 2);
    assert.equal(h.ev(a.id).status, "ack", "dryRun no escribe");
    const res = h.events.bulkStatus({ filter: { status: "open", q: "c" }, status: "false_positive", user: "op" });
    assert.deepEqual(res.ids, [c.id]);
    assert.equal(h.ev(c.id).status, "false_positive");
    assert.equal(h.topic("event.bulk").length, 2);

    h.db.tx(() => {
      for (let i = 0; i < 5010; i++) h.db.run("INSERT INTO events(ts, type, severity, source, title) VALUES($ts, 'motion', 'low', 't', 'm')", { ts: h.clock.t });
    });
    assert.equal(h.events.bulkStatus({ filter: { type: "motion" }, status: "ack", user: "op", dryRun: true }).count, 5000);
    assert.equal(h.events.bulkStatus({ filter: { type: "motion" }, status: "ack", user: "op" }).count, 5000);
  } finally {
    h.cleanup();
  }
});

// ───────── 9. Silencio por cámara ─────────

test("cámara silenciada: sus eventos quedan silent, no notifican ni cuentan", async () => {
  const h = setup();
  try {
    addSource(h, "a", 1);
    await h.cameras.sync();
    h.cameras.setMute("a:1", h.clock.t + 3600_000);
    assert.equal(h.cameras.isMuted("a:1"), true);
    const e = h.events.create({ type: "person", severity: "high", source: "t", cameraId: "a:1", title: "Persona" });
    assert.equal(e.silent, true);
    h.clock.advance(5000);
    assert.equal(h.notices().length, 0);
    const s = h.events.stats(24);
    assert.equal(s.openAlerting, 0);
    assert.equal(s.openCritical, 0);
    assert.equal(s.threat.level, 1);
    h.clock.advance(3600_000);
    assert.equal(h.cameras.isMuted("a:1"), false);
  } finally {
    h.cleanup();
  }
});

// ───────── 10. VPN ─────────

test("VPN: microcorte silencioso, aviso tras la gracia, escalamiento y recuperación", () => {
  const h = setup();
  try {
    h.vpn.state = "error";
    h.incidents.onVpnDown({ profileName: "HQ", error: null }, true);
    h.clock.advance(20_000);
    h.vpn.state = "connected";
    h.incidents.onVpnUp();
    h.clock.advance(120_000);
    assert.equal(h.notices().length, 0, "un microcorte no avisa");
    const [cut] = h.events.list({ type: "vpn_down" });
    assert.equal(cut!.status, "resolved");
    assert.equal(cut!.severity, "low");
    assert.equal(cut!.silent, true);
    assert.match(cut!.title, /Microcorte/);

    h.clock.advance(20 * 60_000);
    h.vpn.state = "error";
    h.incidents.onVpnDown({ profileName: "HQ", error: "El túnel se cayó" }, true);
    h.clock.advance(30_000);
    assert.equal(h.notices().length, 0, "dentro de la gracia");
    h.clock.advance(32_000);
    assert.equal(h.notices().length, 1);
    assert.equal(h.notices()[0]!.severity, "high");
    h.clock.advance(10 * 60_000);
    h.incidents.tick();
    h.clock.advance(2000);
    assert.equal(h.notices().length, 2);
    assert.equal(h.notices()[1]!.kind, "escalation");
    assert.equal(h.notices()[1]!.severity, "critical");
    h.vpn.state = "connected";
    h.incidents.onVpnUp();
    h.clock.advance(2000);
    assert.equal(h.notices().at(-1)!.kind, "recovery");
    assert.equal(h.events.list({ type: "vpn_up" }).length, 0);
  } finally {
    h.cleanup();
  }
});

test("VPN caída: suprime equipos y servidores detrás del túnel y reconcilia al volver", () => {
  const h = setup();
  try {
    const host = (id: string, kind: string, status = "down"): HostRow => ({
      id,
      name: `Equipo ${id}`,
      host: "192.168.109.10",
      port: 80,
      kind,
      enabled: 1,
      last_status: status,
      last_latency_ms: null,
      last_checked_at: null,
      last_change_at: null,
    });
    h.vpn.state = "error";
    h.incidents.onVpnDown({ profileName: "HQ", error: null }, true);
    h.incidents.onHostChange(host("sw", "switch"), false);
    h.incidents.onHostChange(host("fg", "fortigate"), false);
    h.incidents.onSourceDown({ id: "a", name: "exacq A" }, [], "timeout", h.clock.t);
    const hostEvents = h.events.list({ type: "host_down" });
    assert.equal(hostEvents.length, 1, "sólo el FortiGate");
    assert.match(hostEvents[0]!.title, /fg/);
    assert.equal(h.events.list({ type: "source_down" }).length, 0);
    const [vpnEv] = h.events.list({ type: "vpn_down" });
    assert.deepEqual((vpnEv!.meta?.impact as { sources: string[] }).sources, ["exacq A"]);

    h.vpn.state = "connected";
    h.incidents.onVpnUp();
    h.incidents.onSourceUp({ id: "a", name: "exacq A" }, [], 60_000);
    h.incidents.reconcileHosts([host("sw", "switch"), host("fg", "fortigate")]);
    assert.equal(h.events.list({ type: "host_down" }).length, 2, "el switch que sigue caído alerta al volver el túnel");
    h.incidents.reconcileHosts([host("sw", "switch")]);
    assert.equal(h.events.list({ type: "host_down" }).length, 2, "una sola vez");
    h.incidents.onHostChange(host("sw", "switch", "up"), true);
    assert.equal(h.events.list({ type: "host_down", status: "open" }).length, 1);
    assert.equal(h.events.list({ type: "host_up" }).length, 0);
  } finally {
    h.cleanup();
  }
});

// ───────── 11. Histéresis de equipos monitoreados ─────────

test("equipos: la caída exige 3 chequeos fallidos y la recuperación 2 correctos; el reintento absorbe un sondeo perdido", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cia-health-"));
  const db = new Db(":memory:");
  try {
    const plan: boolean[] = [];
    const changes: Array<[string, boolean]> = [];
    const health = new HealthService(db, new Bus(), {
      demo: false,
      dataDir: dir,
      probe: async () => {
        const ok = plan.length ? plan.shift()! : true;
        return { ok, latencyMs: ok ? 3 : null };
      },
      rules: () => ({ hostDownAfterChecks: 3, hostUpAfterChecks: 2, hostProbeRetryMs: 0 }),
      onHostChange: (h, up) => changes.push([h.id, up]),
    });
    db.run("INSERT INTO monitored_hosts(id, name, host, port, kind, enabled, last_status) VALUES('h', 'Switch', '10.0.0.1', 22, 'switch', 1, 'up')");
    const check = async (...probes: boolean[]) => {
      plan.push(...probes);
      await health.checkAll();
    };
    await check(false, true); // sondeo perdido: el reintento responde
    assert.equal(health.list()[0]!.fails, 0);
    await check(false, false);
    await check(false, false);
    await check(true);
    assert.deepEqual(changes, [], "falla, falla, ok → sin evento");
    await check(false, false);
    await check(false, false);
    assert.equal(health.list()[0]!.last_status, "up");
    await check(false, false);
    assert.deepEqual(changes, [["h", false]]);
    await check(true);
    assert.deepEqual(changes, [["h", false]], "la recuperación exige 2 correctos");
    await check(true);
    assert.deepEqual(changes, [
      ["h", false],
      ["h", true],
    ]);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ───────── 12. NotificationHub ─────────

test("NotificationHub: agrupa, limita por minuto, lo crítico no espera y descarta lo resuelto durante la gracia", () => {
  const h = setup();
  try {
    for (let i = 0; i < 34; i++) h.events.create({ type: "camera_offline", severity: i === 7 ? "critical" : "high", source: "t", title: `Cam ${i}` });
    h.clock.advance(1600);
    assert.equal(h.notices().length, 1);
    const digest = h.notices()[0]!;
    assert.equal(digest.kind, "digest");
    assert.equal(digest.count, 34);
    assert.equal(digest.severity, "critical");
    assert.equal(digest.items[0]!.severity, "critical");
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE notified_at IS NULL")!.n, 0);
  } finally {
    h.cleanup();
  }

  const r = setup();
  try {
    const mk = (severity: "high" | "critical" = "high") => r.events.create({ type: "person", severity, source: "t", title: "Persona" });
    for (let i = 0; i < 7; i++) {
      mk();
      r.clock.advance(1500);
    }
    assert.equal(r.notices().length, 6, "el séptimo espera cupo");
    mk();
    r.clock.advance(2000);
    assert.equal(r.notices().length, 7);
    assert.equal(r.notices()[6]!.kind, "digest");
    assert.equal(r.notices()[6]!.count, 2, "el excedente se suma al próximo aviso");
    for (let i = 0; i < 6; i++) {
      mk();
      r.clock.advance(1500);
    }
    const n = r.notices().length;
    mk("critical");
    r.clock.advance(1500);
    assert.equal(r.notices().length, n + 1, "lo crítico no espera cupo");
    assert.equal(r.notices().at(-1)!.severity, "critical");

    // Gracia: si se resuelve antes de vencer, no se avisa.
    r.clock.advance(120_000);
    const before = r.notices().length;
    const { ev } = r.events.upsert({ type: "vpn_down", severity: "high", source: "vpn", title: "VPN", dedupeKey: "vpn_down", notifyAfterMs: 60_000 });
    r.clock.advance(20_000);
    r.events.resolveBySystem(ev.id, "volvió");
    r.clock.advance(60_000);
    assert.equal(r.notices().length, before);
  } finally {
    r.cleanup();
  }
});

test("NotificationHub.resumePending re-ofrece lo que nunca se avisó (reinicio durante una gracia)", () => {
  const h = setup();
  try {
    h.events.setNotifier(undefined);
    h.events.create({ type: "source_down", severity: "high", source: "sistema", title: "Sin conexión" });
    h.events.create({ type: "motion", severity: "low", source: "motor", title: "Movimiento" });
    h.events.setNotifier(h.hub);
    h.hub.resumePending(h.db);
    h.clock.advance(2000);
    assert.equal(h.notices().length, 1);
    assert.equal(h.notices()[0]!.title, "Sin conexión");
  } finally {
    h.cleanup();
  }
});

// ───────── 13. Nivel de amenaza ─────────

test("nivel de amenaza: la infraestructura no domina, la seguridad conserva sus pesos", () => {
  const h = setup();
  try {
    for (let i = 0; i < 10; i++) h.events.create({ type: "host_down", severity: "high", source: "noc", title: `Equipo ${i}` });
    assert.ok(h.events.threatLevel().level <= 2);
    h.events.create({ type: "person", severity: "high", source: "motor", title: "Persona" });
    h.events.create({ type: "intrusion", severity: "high", source: "motor", title: "Intrusión" });
    assert.equal(h.events.threatLevel().score, 18);
    assert.equal(h.events.threatLevel().level, 3);
    const s = h.events.stats(24);
    assert.equal(s.openInfra, 10);
    assert.equal(s.openSecurity, 2);
  } finally {
    h.cleanup();
  }
});

// ───────── 14. Motor de detección ─────────

function frame(draw: (x: number, y: number) => number, w = 160, h = 90) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = draw(x, y);
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  return jpeg.encode({ data, width: w, height: h }, 80).data;
}

const SCENE = frame((x, y) => 60 + ((x >> 3) % 2) * 60 + ((y >> 3) % 2) * 40);
const PERSON = frame((x, y) => (x > 70 && x < 90 && y > 30 && y < 80 ? 250 : 60 + ((x >> 3) % 2) * 60 + ((y >> 3) % 2) * 40));
const COVERED = frame(() => 20);

function detectionSetup(cams: string[], ai?: Partial<AiService>) {
  const h = setup();
  for (const id of cams) {
    h.db.run("INSERT INTO cameras(id, server_id, camera_id, name, motion_enabled, ai_verify, online) VALUES($id, 'a', $cid, $name, 1, $ai, 1)", {
      id,
      cid: id,
      name: `Cam ${id}`,
      ai: ai ? 1 : 0,
    });
  }
  const frames = new Map<string, Buffer>();
  const fakeCameras = {
    sources: new Map([["a", {}]]),
    snapshot: async (id: string) => ({ data: frames.get(id) ?? SCENE, contentType: "image/jpeg", ts: Date.now() }),
    isMuted: () => false,
  } as unknown as CameraService;
  const fakeAi = {
    available: () => Boolean(ai),
    settings: () => ({ autoVerify: true }),
    takeAnalysisBudget: () => true,
    model: "test",
    ...ai,
  } as unknown as AiService;
  const engine = new DetectionEngine(h.db, fakeCameras, h.events, fakeAi, {
    intervalMs: 2000,
    cooldownMs: 0,
    log: () => undefined,
    now: h.clock.now,
    rules: () => ({ motionDedupeMin: 10, aiReverifyMin: 1, tamperConfirmFrames: 3, tamperGlobalCameras: 3, tamperGlobalWindowSec: 15, tamperDedupeMin: 30 }),
  });
  const step = async (set: Record<string, Buffer>) => {
    for (const [k, v] of Object.entries(set)) frames.set(k, v);
    h.clock.advance(2000);
    await engine.tick();
    await new Promise((r) => setImmediate(r));
  };
  return { h, engine, step };
}

test("detección: el sabotaje exige 3 cuadros seguidos y no se dispara en muchas cámaras a la vez", async () => {
  const { h, step } = detectionSetup(["1", "2", "3", "4"]);
  try {
    await step({ "1": SCENE, "2": SCENE, "3": SCENE, "4": SCENE });
    await step({ "1": COVERED });
    await step({ "1": COVERED });
    await step({ "1": SCENE });
    h.clock.advance(20_000);
    await step({});
    assert.equal(h.events.list({ type: "tamper" }).length, 0, "2 cuadros no alcanzan");
    await step({ "1": COVERED });
    await step({});
    await step({});
    h.clock.advance(20_000);
    await step({});
    assert.equal(h.events.list({ type: "tamper" }).length, 1);

    // Tres cámaras a la vez → un único aviso silencioso de sistema.
    await step({ "1": SCENE, "2": SCENE, "3": SCENE, "4": SCENE });
    await step({ "2": COVERED, "3": COVERED, "4": COVERED });
    await step({});
    await step({});
    h.clock.advance(20_000);
    await step({});
    assert.equal(h.events.list({ type: "tamper" }).length, 1);
    const sys = h.events.list({ type: "system" });
    assert.equal(sys.length, 1);
    assert.equal(sys[0]!.silent, true);
  } finally {
    h.cleanup();
  }
});

test("detección: el movimiento repetido suma ocurrencias y la re-verificación IA nunca baja la severidad", async () => {
  let calls = 0;
  const analyzeImage = async () => {
    calls++;
    return calls === 1
      ? { summary: "Persona en el acceso", people_count: 1, vehicles_count: 0, detected: ["persona"], activities: [], anomalies: [], event_type: "person", threat_level: "high", recommended_action: "Verificar", confidence: 0.9 }
      : { summary: "Nada relevante", people_count: 0, vehicles_count: 0, detected: [], activities: [], anomalies: [], event_type: "none", threat_level: "none", recommended_action: "", confidence: 0.9 };
  };
  const { h, step } = detectionSetup(["1"], { analyzeImage: analyzeImage as unknown as AiService["analyzeImage"] });
  try {
    for (let i = 0; i < 12; i++) await step({ "1": i % 2 ? PERSON : SCENE });
    await new Promise((r) => setTimeout(r, 10));
    const evs = h.events.list({ camera: "1", limit: 50 });
    assert.equal(evs.length, 1);
    assert.ok(evs[0]!.occurrences > 1);
    h.clock.advance(2 * 60_000);
    for (let i = 0; i < 4; i++) await step({ "1": i % 2 ? PERSON : SCENE });
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(calls >= 2, "se re-verificó");
    const ev = h.ev(evs[0]!.id);
    assert.equal(ev.severity, "high");
    assert.equal(ev.type, "person");
    assert.notEqual(ev.status, "false_positive");
  } finally {
    h.cleanup();
  }
});
