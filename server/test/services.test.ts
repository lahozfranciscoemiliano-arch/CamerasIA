import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import jpeg from "jpeg-js";
import { Db } from "../src/db/index.js";
import { AuditService } from "../src/audit/service.js";
import { KeyRing } from "../src/security/crypto.js";
import { VaultService } from "../src/vault/service.js";
import { compareGrids, lumaGrid, GRID_W, GRID_H } from "../src/detection/motion.js";
import { describeNetworkError, ExacqSource, formatExacqTime, normalizeBaseUrl, parseCameraList, parseClips, parseServerOffset } from "../src/exacq/client.js";
import { buildOpenfortivpnConfig, type VpnProfileRow } from "../src/vpn/manager.js";
import { DemoSource } from "../src/exacq/demo.js";

test("auditoría encadenada detecta alteraciones", () => {
  const db = new Db(":memory:");
  const audit = new AuditService(db);
  for (let i = 0; i < 5; i++) audit.log({ username: "op", action: `test.${i}`, details: { i } });
  assert.deepEqual(audit.verify(), { ok: true, checked: 5 });
  db.run("UPDATE audit_log SET username = 'atacante' WHERE id = 3");
  const r = audit.verify();
  assert.equal(r.ok, false);
  assert.equal(r.brokenAt, 3);
});

test("bóveda: cifra, enmascara y fusiona actualizaciones parciales", () => {
  const db = new Db(":memory:");
  const vault = new VaultService(db, new KeyRing({ 1: crypto.randomBytes(32) }, 1));
  const id = vault.create({ name: "FortiGate", kind: "fortivpn", secret: { username: "jperez", password: "S3creta!" } });
  const raw = db.get<{ payload_enc: string }>("SELECT payload_enc FROM vault_entries WHERE id = $id", { id })!;
  assert.ok(!raw.payload_enc.includes("S3creta"), "el secreto no queda en claro en la base");
  const meta = vault.meta(id)!;
  assert.equal(meta.usernameMasked, "j••••z");
  assert.equal(meta.hasPassword, true);
  assert.ok(!JSON.stringify(vault.list()).includes("S3creta"));
  vault.update(id, { secret: { password: "Nueva!123" } });
  assert.deepEqual(vault.getSecret(id), { username: "jperez", password: "Nueva!123" });
  // Copiar el blob cifrado a otra fila no sirve (AAD = id)
  const id2 = vault.create({ name: "Otra", kind: "generic", secret: { password: "x" } });
  db.run("UPDATE vault_entries SET payload_enc = (SELECT payload_enc FROM vault_entries WHERE id = $a) WHERE id = $b", { a: id, b: id2 });
  assert.throws(() => vault.getSecret(id2));
});

function frame(draw: (x: number, y: number) => number, w = 320, h = 180) {
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

test("detección de movimiento y sabotaje", () => {
  const scene = (x: number, y: number) => 60 + ((x >> 4) % 2) * 60 + ((y >> 4) % 2) * 40;
  const a = lumaGrid(frame(scene));
  const b = lumaGrid(frame((x, y) => Math.min(255, scene(x, y) + (Math.random() - 0.5) * 6)));
  assert.equal(a.length, GRID_W * GRID_H);
  assert.equal(compareGrids(a, b, 50).motion, false, "ruido leve no es movimiento");
  const withPerson = lumaGrid(frame((x, y) => (x > 140 && x < 180 && y > 60 && y < 160 ? 250 : scene(x, y))));
  const m = compareGrids(a, withPerson, 50);
  assert.equal(m.motion, true);
  assert.ok(m.box && m.box.x > 0.35 && m.box.x < 0.6);
  const brighter = lumaGrid(frame((x, y) => Math.min(255, scene(x, y) + 30)));
  assert.equal(compareGrids(a, brighter, 50).motion, false, "cambio global de luz compensado");
  const covered = lumaGrid(frame(() => 20));
  assert.equal(compareGrids(a, covered, 50).tamper, true);
});

test("parseo de respuestas exacqVision", () => {
  const cams = parseCameraList({ Cameras: [{ id: 1, name: "Entrada" }, { id: "2", Name: "Patio", status: "Disconnected" }, { foo: 1 }] });
  assert.deepEqual(
    cams.map((c) => [c.cameraId, c.name, c.online]),
    [
      ["1", "Entrada", true],
      ["2", "Patio", false],
    ],
  );
  const clips = parseClips({ videoInfo: [{ clips: [{ startTime: "2026-01-01T10:00:05Z", endTime: "2026-01-01T10:01:00Z" }] }] });
  assert.deepEqual(clips, [{ start: "2026-01-01T10:00:05.000Z", end: "2026-01-01T10:01:00.000Z" }]);
  assert.equal(formatExacqTime(new Date("2026-01-01T13:00:00Z"), "America/Argentina/Buenos_Aires"), "2026-01-01T10:00:00-03:00");
  assert.equal(formatExacqTime(new Date("2026-07-01T12:00:00Z"), "Europe/Madrid"), "2026-07-01T14:00:00+02:00");
  // Desfase numérico (horas) como lo informa config.web
  assert.equal(formatExacqTime(new Date("2026-01-01T13:00:00.700Z"), -3), "2026-01-01T10:00:00-03:00");
  assert.equal(formatExacqTime(new Date("2026-01-01T13:00:00Z"), 5.5), "2026-01-01T18:30:00+05:30");
});

test("parseo de config.web de exacqVision 23.09 (estado, deshabilitadas, nombres, zona)", () => {
  const cfg = {
    name: "BISTRO SA",
    timezone: -3,
    Cameras: [
      { name: "ALMACEN PB", id: 1376768, state: 0, disabled: 0, formats: [4, 6] },
      { name: " RECEPCION ", id: 1710080, state: 0, disabled: 0 },
      { name: "OFICINA MARCOS", id: 4786176, state: 2, disabled: 1 },
      { name: "", id: 4786944, state: 2, disabled: 1 },
      { name: "SIN VIDEO", id: 5, state: 1, disabled: 0 },
    ],
    restricted: false,
  };
  assert.deepEqual(
    parseCameraList(cfg).map((c) => [c.cameraId, c.name, c.online, c.disabled]),
    [
      ["1376768", "ALMACEN PB", true, false],
      ["1710080", "RECEPCION", true, false],
      ["4786176", "OFICINA MARCOS", false, true],
      ["4786944", "Cámara 4786944", false, true],
      ["5", "SIN VIDEO", false, false],
    ],
  );
  assert.equal(parseServerOffset(cfg), -3);
  assert.equal(parseServerOffset({ timezone: "x" }), null);
});

test("URL del Web Service: normalización y errores de red legibles", () => {
  assert.equal(normalizeBaseUrl("192.168.109.58"), "http://192.168.109.58");
  assert.equal(normalizeBaseUrl(" http://192.168.109.58/login.web "), "http://192.168.109.58");
  assert.equal(normalizeBaseUrl("http://192.168.109.58/advanced.web#eyJzYiI6MX0="), "http://192.168.109.58");
  assert.equal(normalizeBaseUrl("http://192.168.109.58:8080/v1/config.web?s=1"), "http://192.168.109.58:8080");
  assert.equal(normalizeBaseUrl("https://nvr.empresa.local/exacq/"), "https://nvr.empresa.local/exacq");
  const refused = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
  assert.match(describeNetworkError(refused, "https://192.168.109.58"), /puerto 443.*http:\/\//);
  assert.match(describeNetworkError(refused, "http://192.168.109.58:8080"), /puerto 8080/);
  const tls = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("self-signed"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }) });
  assert.match(describeNetworkError(tls, "https://192.168.109.58"), /HTTPS/);
  assert.match(describeNetworkError(new DOMException("t", "TimeoutError"), "http://x"), /sin respuesta/);
});

test("cliente exacqVision contra un servidor simulado (login, re-login, cámaras, snapshot, búsqueda)", async () => {
  let sessions = 0;
  let valid = "";
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    seen.push(url.pathname);
    if (url.pathname === "/v1/login.web") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const p = new URLSearchParams(body);
        res.setHeader("content-type", "application/json");
        if (p.get("u") === "viewer" && p.get("p") === "p&ss=word") {
          valid = `sess${++sessions}`;
          res.end(JSON.stringify({ success: true, sessionId: valid }));
        } else res.end(JSON.stringify({ success: false }));
      });
      return;
    }
    if (url.searchParams.get("s") !== valid) {
      res.statusCode = 401;
      return res.end();
    }
    if (url.pathname === "/v1/config.web") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ Cameras: [{ id: 7, name: "Depósito" }] }));
    }
    if (url.pathname === "/v1/image.web") {
      res.setHeader("content-type", "image/jpeg");
      return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    }
    if (url.pathname === "/v1/search.web") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ search_id: "1", videoInfo: [{ clips: [{ startTime: "2026-01-01T10:00:00Z", endTime: "2026-01-01T10:05:00Z" }] }] }));
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const adopted: Array<{ snapshot?: string; live?: string }> = [];
    const src = new ExacqSource(
      { id: "s1", name: "Test", baseUrl: `http://127.0.0.1:${port}` },
      () => ({ username: "viewer", password: "p&ss=word" }),
      undefined,
      { onTemplates: (t) => adopted.push(t) },
    );
    const cams = await src.listCameras();
    assert.deepEqual(cams.map((c) => c.name), ["Depósito"]);
    valid = "expirada"; // el servidor invalida la sesión → el cliente debe re-loguearse solo
    // La plantilla por defecto (video.web&fmt=jpg) no existe en este servidor: el cliente
    // prueba las candidatas, adopta image.web y avisa para guardarla.
    const snap = await src.snapshot("7");
    assert.equal(snap.contentType, "image/jpeg");
    assert.equal(sessions, 2);
    assert.deepEqual(adopted, [{ snapshot: "/v1/image.web?s={session}&camera={camera}&quality={quality}" }]);
    await src.snapshot("7");
    assert.equal(adopted.length, 1);
    const clips = await src.searchRecordings("7", new Date("2026-01-01T09:00:00Z"), new Date("2026-01-01T11:00:00Z"));
    assert.equal(clips.length, 1);
    assert.equal(src.status().ok, true);
    const bad = new ExacqSource({ id: "s2", name: "Bad", baseUrl: `http://127.0.0.1:${port}` }, () => ({ username: "x", password: "y" }));
    await assert.rejects(bad.listCameras(), /rechazadas/);
  } finally {
    server.close();
  }
});

test("exacqVision 23.09 simulado: diagnóstico completo y detección que guarda la plantilla", async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/") {
      res.statusCode = 302;
      res.setHeader("location", "/login.web");
      return res.end();
    }
    if (url.pathname === "/v1/login.web") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ success: true, sessionId: "abc" }));
    }
    if (url.searchParams.get("s") !== "abc") {
      res.statusCode = 401;
      return res.end();
    }
    if (url.pathname === "/v1/config.web") {
      res.setHeader("content-type", "application/json");
      return res.end(
        JSON.stringify({
          name: "BISTRO SA",
          timezone: -3,
          Cameras: [
            { name: "OFICINA MARCOS", id: 4786176, state: 2, disabled: 1 },
            { name: "ALMACEN PB", id: 1376768, state: 0, disabled: 0 },
          ],
        }),
      );
    }
    if (url.pathname === "/v1/video.web" && url.searchParams.get("fmt") === "jpg" && url.searchParams.get("camera") === "1376768") {
      res.setHeader("content-type", "image/jpeg");
      return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    }
    if (url.pathname === "/v1/video.web") {
      res.statusCode = 400;
      return res.end();
    }
    res.statusCode = 404;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("Not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const adopted: Array<{ snapshot?: string; live?: string }> = [];
    const src = new ExacqSource(
      // Plantilla vieja guardada que ya no existe en 23.09
      { id: "s23", name: "Central", baseUrl: `http://127.0.0.1:${port}`, snapshotTemplate: "/v1/image.web?s={session}&camera={camera}&quality={quality}" },
      () => ({ username: "admin", password: "x" }),
      undefined,
      { onTemplates: (t) => adopted.push(t) },
    );
    const d = await src.diagnose();
    assert.deepEqual(
      d.steps.map((s) => s.ok),
      [true, true, true, true],
      JSON.stringify(d.steps),
    );
    assert.equal(d.ok, true);
    assert.equal(d.cameras, 2);
    assert.equal(d.online, 1);
    assert.equal(d.disabled, 1);
    assert.match(d.steps[3]!.step, /ALMACEN PB/);
    assert.equal(d.snapshotTemplate, "/v1/video.web?s={session}&camera={camera}&fmt=jpg");
    assert.deepEqual(adopted, [{ snapshot: "/v1/video.web?s={session}&camera={camera}&fmt=jpg" }]);

    const det = await src.detectTemplates("1376768");
    assert.equal(det.snapshot, "/v1/video.web?s={session}&camera={camera}&fmt=jpg");
    assert.equal(det.live, null);
    assert.equal(det.applied, true);

    // Servidor caído → mensaje con la causa, no "fetch failed"
    const tmp = http.createServer();
    await new Promise<void>((r) => tmp.listen(0, "127.0.0.1", r));
    const closedPort = (tmp.address() as AddressInfo).port;
    await new Promise<void>((r) => tmp.close(() => r()));
    const down = new ExacqSource({ id: "x", name: "X", baseUrl: `http://127.0.0.1:${closedPort}` }, () => ({ username: "a", password: "b" }));
    const dd = await down.diagnose();
    assert.equal(dd.ok, false);
    assert.equal(dd.steps.length, 1);
    assert.match(dd.steps[0]!.detail, new RegExp(`rechazada en el puerto ${closedPort}`));
  } finally {
    server.close();
  }
});

test("configuración de openfortivpn", () => {
  const p: VpnProfileRow = {
    id: "1",
    name: "HQ",
    host: "vpn.empresa.com",
    port: 10443,
    realm: "soc",
    trusted_certs: JSON.stringify(["a".repeat(64)]),
    set_routes: 1,
    set_dns: 0,
    half_internet_routes: 0,
    otp_required: 1,
    credential_id: null,
    auto_connect: 0,
    created_at: 0,
    updated_at: 0,
  };
  const cfg = buildOpenfortivpnConfig(p, "jperez", "p#ss = w0rd", "123456");
  assert.match(cfg, /^host = vpn\.empresa\.com$/m);
  assert.match(cfg, /^port = 10443$/m);
  assert.match(cfg, /^password = p#ss = w0rd$/m);
  assert.match(cfg, /^trusted-cert = a{64}$/m);
  assert.match(cfg, /^realm = soc$/m);
  assert.match(cfg, /^otp = 123456$/m);
  assert.match(cfg, /^set-dns = 0$/m);
  assert.throws(() => buildOpenfortivpnConfig(p, "x", "inyec\nhost = evil", undefined));
});

test("simulador demo genera JPEG válidos y grabaciones", async () => {
  const demo = new DemoSource();
  const img = demo.render("1", Date.now());
  assert.equal(img[0], 0xff);
  assert.equal(img[1], 0xd8);
  const decoded = jpeg.decode(img);
  assert.equal(decoded.width, 480);
  const clips = await demo.searchRecordings("3", new Date(Date.now() - 3 * 3600_000), new Date());
  assert.ok(clips.length > 0);
});
