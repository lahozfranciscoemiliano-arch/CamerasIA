import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Db } from "../src/db/index.js";
import { CameraService, type ExacqServerRow } from "../src/exacq/service.js";
import { Bus } from "../src/realtime/bus.js";
import { KeyRing } from "../src/security/crypto.js";
import { VaultService } from "../src/vault/service.js";

test("descubrimiento exacq: conserva el diagnóstico, registra cámaras y recupera su estado", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cia-discovery-"));
  const db = new Db(":memory:");
  const vault = new VaultService(db, new KeyRing({ 1: crypto.randomBytes(32) }, 1));
  let status = 200;
  let config: unknown = { unexpected: [] };
  const remote = http.createServer((req, res) => {
    req.resume();
    const endpoint = new URL(req.url!, "http://localhost").pathname;
    res.setHeader("Content-Type", "application/json");
    if (endpoint === "/v1/login.web") return res.end(JSON.stringify({ sessionId: "fixture-session" }));
    if (endpoint === "/v1/logout.web") return res.end("{}");
    res.statusCode = status;
    res.end(JSON.stringify(config));
  });
  await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
  const port = (remote.address() as AddressInfo).port;
  const cameras = new CameraService(db, vault, new Bus(), { demo: false, exportsDir: dir, log: () => undefined });
  try {
    const credentialId = vault.create({ name: "Fixture exacq", kind: "exacq", secret: { username: "viewer", password: "fixture-password" } });
    db.run(
      "INSERT INTO exacq_servers(id, name, base_url, credential_id, created_at, updated_at) VALUES($id, $name, $url, $cred, $now, $now)",
      { id: "bistro-fixture", name: "Bistro fixture", url: `http://127.0.0.1:${port}`, cred: credentialId, now: Date.now() },
    );
    await cameras.reload();
    await cameras.sync();
    assert.equal(cameras.list().length, 0);
    assert.equal(cameras.sourceStatuses()[0]!.ok, false);
    assert.match(cameras.servers()[0]!.last_error!, /config\.web.*Cameras/);

    config = { Cameras: [{ id: 7, name: "Entrada", online: true }] };
    await cameras.sync();
    assert.equal(cameras.sourceStatuses()[0]!.ok, true);
    assert.equal(cameras.servers()[0]!.last_error, null);
    assert.ok(cameras.servers()[0]!.last_ok_at);
    assert.deepEqual(cameras.list().map((camera) => [camera.cameraId, camera.name, camera.online]), [["7", "Entrada", true]]);

    status = 404;
    await cameras.sync();
    assert.equal(cameras.sourceStatuses()[0]!.ok, false);
    assert.match(db.get<ExacqServerRow>("SELECT * FROM exacq_servers WHERE id = 'bistro-fixture'")!.last_error!, /HTTP 404/);
    assert.equal(cameras.list()[0]!.online, false, "un error de consulta no mantiene cámaras conectadas");

    status = 200;
    await cameras.sync();
    assert.equal(cameras.sourceStatuses()[0]!.ok, true);
    assert.equal(cameras.list().length, 1, "la recuperación actualiza la cámara existente");
    assert.equal(cameras.list()[0]!.online, true);
  } finally {
    for (const source of cameras.sources.values()) await source.dispose?.();
    cameras.stop();
    await new Promise<void>((resolve, reject) => remote.close((error) => error ? reject(error) : resolve()));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
