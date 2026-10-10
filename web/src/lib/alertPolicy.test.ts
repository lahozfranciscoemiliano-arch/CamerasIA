import { test } from "node:test";
import assert from "node:assert/strict";
import { CRITICAL_MIN_GAP_MS, DEFAULT_PREFS, filterNotice, inDnd, migrateLegacy, nextAt, normalizePrefs, passes, summarize } from "./alertPolicy";
import type { AlertNotice, AlertPrefs, NoticeItem, Severity } from "./types";

const item = (severity: Severity, category: "security" | "infra" = "security", id = 1): NoticeItem => ({
  eventId: id,
  severity,
  category,
  type: category === "security" ? "person" : "camera_offline",
  title: `Evento ${id}`,
  cameraName: null,
  reason: "new",
});

const notice = (items: NoticeItem[], kind: AlertNotice["kind"] = items.length > 1 ? "digest" : "event"): AlertNotice => ({
  id: "n",
  ts: 0,
  kind,
  severity: items[0]!.severity,
  category: items[0]!.category,
  title: "x",
  count: items.length,
  items,
});

const NOW = 1_000_000_000;

test("umbrales por categoría: por defecto la infraestructura sólo suena si es crítica", () => {
  assert.equal(passes(item("high", "security"), DEFAULT_PREFS, "toast"), true);
  assert.equal(passes(item("medium", "security"), DEFAULT_PREFS, "toast"), false);
  assert.equal(passes(item("high", "infra"), DEFAULT_PREFS, "toast"), true);
  assert.equal(passes(item("high", "infra"), DEFAULT_PREFS, "sound"), false);
  assert.equal(passes(item("critical", "infra"), DEFAULT_PREFS, "sound"), true);
  const off: AlertPrefs = { ...DEFAULT_PREFS, security: { toast: "off", sound: "off" } };
  assert.equal(passes(item("critical", "security"), off, "toast"), false);
});

test("no molestar: silencia todo salvo lo crítico si así se eligió", () => {
  const dnd: AlertPrefs = { ...DEFAULT_PREFS, dndUntil: NOW + 60_000 };
  assert.equal(inDnd(dnd, NOW), true);
  assert.equal(inDnd(dnd, NOW + 61_000), false);
  const high = filterNotice(notice([item("high")]), dnd, NOW);
  assert.equal(high.toastItems.length, 0);
  assert.equal(high.playSound, false);
  const crit = filterNotice(notice([item("critical")]), dnd, NOW);
  assert.equal(crit.toastItems.length, 1);
  assert.equal(crit.playSound, true);
  assert.equal(crit.tone, "critical");
  const strict = filterNotice(notice([item("critical")]), { ...dnd, dndAllowCritical: false }, NOW);
  assert.equal(strict.toastItems.length, 0);
  assert.equal(strict.playSound, false);
});

test("pausa entre sonidos; lo crítico sólo respeta la separación mínima", () => {
  const p = { ...DEFAULT_PREFS, soundCooldownSec: 20 };
  assert.equal(filterNotice(notice([item("high")]), p, NOW, NOW - 10_000).playSound, false);
  assert.equal(filterNotice(notice([item("high")]), p, NOW, NOW - 21_000).playSound, true);
  assert.equal(filterNotice(notice([item("critical")]), p, NOW, NOW - 10_000).playSound, true);
  assert.equal(filterNotice(notice([item("critical")]), p, NOW, NOW - CRITICAL_MIN_GAP_MS + 1).playSound, false);
  assert.equal(filterNotice(notice([item("critical")]), { ...p, muted: true }, NOW).playSound, false, "silencio total");
});

test("digest: filtra los ítems según las preferencias y elige el tono", () => {
  const n = notice([item("critical", "infra", 1), item("high", "security", 2), item("medium", "infra", 3), item("low", "security", 4)]);
  const f = filterNotice(n, DEFAULT_PREFS, NOW);
  assert.deepEqual(
    f.toastItems.map((i) => i.eventId),
    [1, 2],
  );
  assert.equal(f.tone, "critical");
  const onlyInfra = filterNotice(notice([item("high", "infra", 1), item("high", "infra", 2)]), { ...DEFAULT_PREFS, infra: { toast: "high", sound: "high" } }, NOW);
  assert.equal(onlyInfra.tone, "infra");
  assert.equal(summarize([item("critical"), item("high"), item("high")]), "1 crítica · 2 altas");
});

test("recuperaciones: aviso sin sonido, sólo si están activadas", () => {
  const rec = notice([{ ...item("high", "infra"), reason: "recovered" }], "recovery");
  assert.equal(filterNotice(rec, DEFAULT_PREFS, NOW).toastItems.length, 1);
  assert.equal(filterNotice(rec, DEFAULT_PREFS, NOW).playSound, false);
  assert.equal(filterNotice(rec, { ...DEFAULT_PREFS, recoveries: false }, NOW).toastItems.length, 0);
});

test("migración de cia.alerts.sound y normalización de preferencias guardadas", () => {
  const migrated = migrateLegacy(false);
  assert.equal(migrated.security.sound, "off");
  assert.equal(migrated.infra.sound, "off");
  assert.equal(migrated.security.toast, DEFAULT_PREFS.security.toast);
  assert.deepEqual(migrateLegacy(true), DEFAULT_PREFS);
  assert.deepEqual(migrateLegacy(null), DEFAULT_PREFS);
  const n = normalizePrefs({ security: { toast: "nope" }, maxToasts: 99, soundCooldownSec: -3 });
  assert.equal(n.security.toast, DEFAULT_PREFS.security.toast);
  assert.equal(n.maxToasts, 8);
  assert.equal(n.soundCooldownSec, 0);
  assert.deepEqual(normalizePrefs(null), DEFAULT_PREFS);
});

test("nextAt devuelve la próxima ocurrencia de la hora", () => {
  const base = new Date(2026, 9, 10, 22, 30).getTime();
  const at = new Date(nextAt(7, base));
  assert.equal(at.getHours(), 7);
  assert.ok(at.getTime() > base && at.getTime() - base < 24 * 3600_000);
});
