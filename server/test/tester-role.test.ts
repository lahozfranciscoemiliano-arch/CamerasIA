import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp, type BuiltApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { totp } from "../src/security/totp.js";

const INITIAL_PW = "Temporal!Segura2026";
const CHANGED_PW = "Actualizada!Segura2027";
const EXACQ_PW = "Fixture!Exacq2026";
const RAW_TOKEN = "fixture-exacq-token-must-stay-private";
const SNAPSHOT = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

type Account = { id: number; cookie: string; recoveryCodes: string[] };

describe("Tester: diagnóstico sin administración y 2FA obligatorio", () => {
  let built: BuiltApp;
  let app: FastifyInstance;
  let dir: string;
  let remote: http.Server;
  let remoteUrl: string;
  let admin: Account;
  let tester: Account;
  let operator: Account;
  let viewer: Account;
  let credentialId: string;
  let serverId: string;
  let profileId: string;
  let ingestId: string;
  let ingestKey: string;
  let cameraId: string;
  let hostId: string;
  let eventId: number;
  let remoteConfig: unknown = { Cameras: [{ id: 7, name: "Entrada fixture", online: true, password: EXACQ_PW, nested: { token: RAW_TOKEN } }], sessionToken: RAW_TOKEN, Credentials: { password: EXACQ_PW } };

  const request = async (cookie: string, method: string, url: string, body?: unknown) => {
    const response = await app.inject({
      method: method as "GET",
      url,
      payload: body === undefined ? undefined : body as object,
      headers: { cookie, "x-requested-with": "CamerasIA" },
    });
    const setCookie = response.headers["set-cookie"];
    return {
      status: response.statusCode,
      json: response.headers["content-type"]?.includes("json") ? response.json() : undefined,
      cookie: setCookie ? String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0]! : "",
      response,
    };
  };

  const enroll = async (cookie: string) => {
    const begin = await request(cookie, "POST", "/api/auth/totp/begin");
    assert.equal(begin.status, 200);
    assert.match(begin.json.qr, /^data:image\/png;base64,/);
    const confirm = await request(cookie, "POST", "/api/auth/totp/confirm", { code: totp(begin.json.secret) });
    assert.equal(confirm.status, 200);
    assert.equal(confirm.json.recoveryCodes.length, 10);
    return confirm.json.recoveryCodes as string[];
  };

  const onboard = async (username: string, id: number): Promise<Account> => {
    const login = await request("", "POST", "/api/auth/login", { username, password: INITIAL_PW });
    assert.equal(login.status, 200);
    assert.ok(login.cookie);
    assert.equal((await request(login.cookie, "POST", "/api/auth/password", { current: INITIAL_PW, next: CHANGED_PW })).status, 200);
    return { id, cookie: login.cookie, recoveryCodes: await enroll(login.cookie) };
  };

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cia-tester-"));
    remote = http.createServer(async (req, res) => {
      const url = new URL(req.url!, "http://fixture.local");
      if (url.pathname === "/v1/login.web") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = new URLSearchParams(Buffer.concat(chunks).toString());
        res.setHeader("Content-Type", "application/json");
        if (body.get("u") !== "exacq-fixture" || body.get("p") !== EXACQ_PW) {
          res.statusCode = 401;
          return res.end(JSON.stringify({ success: false }));
        }
        return res.end(JSON.stringify({ sessionId: "tester-fixture-session" }));
      }
      req.resume();
      if (url.pathname === "/v1/logout.web") return res.end("{}");
      if (url.searchParams.get("s") !== "tester-fixture-session") {
        res.statusCode = 401;
        return res.end("{}");
      }
      if (url.pathname === "/v1/config.web") {
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify(remoteConfig));
      }
      if (url.pathname === "/v1/search.web") {
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ videoInfo: [{ clips: [{ startTime: "2026-01-01T00:00:00Z", endTime: "2026-01-01T00:01:00Z" }] }] }));
      }
      if (url.pathname === "/v1/image.web") {
        res.setHeader("Content-Type", "image/jpeg");
        return res.end(SNAPSHOT);
      }
      if (url.pathname === "/v1/video.web" && url.searchParams.get("format") === "mjpeg") {
        res.setHeader("Content-Type", "multipart/x-mixed-replace; boundary=fixture");
        return res.end("--fixture\r\nContent-Type: image/jpeg\r\n\r\nfixture\r\n--fixture--\r\n");
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
    remoteUrl = `http://127.0.0.1:${(remote.address() as AddressInfo).port}`;
    // Aunque una instalación permita omitir el 2FA general, una cuenta Tester debe activarlo.
    const cfg = loadConfig({ DATA_DIR: dir, DEMO_MODE: "false", ADMIN_INITIAL_PASSWORD: INITIAL_PW, REQUIRE_2FA: "false", VAULT_ALLOW_REVEAL: "true", VPN_MODE: "simulate", LOG_LEVEL: "error" } as NodeJS.ProcessEnv);
    built = await buildApp(cfg, { logger: false });
    app = built.app;
    await built.ctx.auth.ensureInitialAdmin(() => undefined);
    await app.ready();
    admin = await onboard("admin", built.ctx.auth.getUserByName("admin")!.id);

    for (const role of ["operator", "viewer"] as const) {
      const created = await request(admin.cookie, "POST", "/api/users", { username: `${role}-fixture`, role, password: INITIAL_PW });
      assert.equal(created.status, 200);
      const account = await onboard(`${role}-fixture`, created.json.id);
      if (role === "operator") operator = account;
      else viewer = account;
    }
    const credential = await request(admin.cookie, "POST", "/api/vault", { name: "Exacq fixture", kind: "exacq", secret: { username: "exacq-fixture", password: EXACQ_PW } });
    assert.equal(credential.status, 200);
    credentialId = credential.json.id;
    const profile = await request(admin.cookie, "POST", "/api/vpn/profiles", { name: "VPN fixture", host: "vpn.fixture.local", credentialId });
    assert.equal(profile.status, 200);
    profileId = profile.json.id;
    const server = await request(admin.cookie, "POST", "/api/exacq/servers", { name: "Bistro fixture", baseUrl: remoteUrl, credentialId, vpnProfileId: profileId });
    assert.equal(server.status, 200);
    serverId = server.json.id;
    await built.ctx.cameras.sync();
    cameraId = `${serverId}:7`;
    const key = await request(admin.cookie, "POST", "/api/ingest/keys", { name: "Fixture ingesta" });
    assert.equal(key.status, 200);
    ingestId = key.json.id;
    ingestKey = key.json.key;
    const host = await request(admin.cookie, "POST", "/api/health/hosts", { name: "Exacq fixture", host: "127.0.0.1", port: (remote.address() as AddressInfo).port, kind: "exacq" });
    assert.equal(host.status, 200);
    hostId = host.json.id;
    eventId = built.ctx.events.create({ type: "external", severity: "medium", source: "fixture", title: "Evento de prueba" }).id;
  });

  after(async () => {
    if (built) {
      for (const source of built.ctx.cameras.sources.values()) await source.dispose?.();
      await built.shutdown();
    }
    if (remote) await new Promise<void>((resolve, reject) => remote.close((error) => error ? reject(error) : resolve()));
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("el administrador crea Tester y el primer ingreso exige clave nueva y TOTP", async () => {
    const created = await request(admin.cookie, "POST", "/api/users", { username: "CodeChatGPT", displayName: "Revisión fixture", role: "tester", password: INITIAL_PW });
    assert.equal(created.status, 200);
    assert.equal(created.json.role, "tester");
    assert.equal(created.json.mustChangePassword, true);
    const login = await request("", "POST", "/api/auth/login", { username: "CodeChatGPT", password: INITIAL_PW });
    assert.equal(login.status, 200);
    assert.deepEqual(login.json.restrictions, { mustChangePassword: true, mustEnrollTotp: true });
    const blocked = await request(login.cookie, "GET", "/api/exacq/servers");
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.error, "must_change_password");
    assert.equal((await request(login.cookie, "POST", "/api/auth/password", { current: INITIAL_PW, next: CHANGED_PW })).status, 200);
    const me = await request(login.cookie, "GET", "/api/auth/me");
    assert.deepEqual(me.json.restrictions, { mustChangePassword: false, mustEnrollTotp: true });
    for (const url of ["/api/cameras", "/api/exacq/servers", "/api/vpn/status"]) {
      const denied = await request(login.cookie, "GET", url);
      assert.equal(denied.status, 403, url);
      assert.equal(denied.json.error, "must_enroll_totp", url);
    }
    const secondSession = await request("", "POST", "/api/auth/login", { username: "CodeChatGPT", password: CHANGED_PW });
    assert.equal(secondSession.status, 200);
    assert.equal(secondSession.json.restrictions.mustEnrollTotp, true);
    tester = { id: created.json.id, cookie: login.cookie, recoveryCodes: await enroll(login.cookie) };
    assert.equal((await request(secondSession.cookie, "GET", "/api/cameras")).status, 401, "el alta no habilita otras sesiones abiertas sin segundo factor");
    const enrolled = await request(tester.cookie, "GET", "/api/auth/me");
    assert.equal(enrolled.json.user.role, "tester");
    assert.equal(enrolled.json.user.totpEnabled, true);
    assert.deepEqual(enrolled.json.restrictions, { mustChangePassword: false, mustEnrollTotp: false });
  });

  test("Tester consulta el sistema y ejecuta diagnósticos reales de exacq", async () => {
    const reads = ["/api/users", "/api/audit", "/api/audit/verify", "/api/vault", "/api/exacq/servers", "/api/exacq/status", "/api/ingest/keys", "/api/vpn/profiles", "/api/vpn/logs", "/api/vpn/status", "/api/ai/status", "/api/ai/usage", "/api/cameras", "/api/events", "/api/dashboard", "/api/health/hosts", "/api/health/system"];
    for (const url of reads) assert.equal((await request(tester.cookie, "GET", url)).status, 200, url);
    const users = (await request(tester.cookie, "GET", "/api/users")).json;
    assert.ok(!JSON.stringify(users).includes("password_hash"));
    assert.ok(!JSON.stringify(users).includes("totp_secret"));
    const vault = (await request(tester.cookie, "GET", "/api/vault")).json;
    assert.ok(vault.some((entry: { id: string }) => entry.id === credentialId));
    assert.ok(!JSON.stringify(vault).includes(EXACQ_PW));
    const keys = (await request(tester.cookie, "GET", "/api/ingest/keys")).json;
    assert.ok(keys.some((entry: { id: string }) => entry.id === ingestId));
    assert.ok(!JSON.stringify(keys).includes(ingestKey));
    assert.ok(!JSON.stringify(keys).includes("key_hash"));

    const diagnostics = await request(tester.cookie, "POST", `/api/exacq/servers/${serverId}/test`);
    assert.equal(diagnostics.status, 200);
    assert.equal(diagnostics.json.ok, true);
    assert.equal(diagnostics.json.cameras, 1);
    const detected = await request(tester.cookie, "POST", `/api/exacq/servers/${serverId}/detect`, { cameraId: "7" });
    assert.equal(detected.status, 200);
    assert.match(detected.json.snapshot, /^\/v1\/image\.web/);
    assert.match(detected.json.live, /^\/v1\/video\.web/);
    const raw = await request(tester.cookie, "GET", `/api/exacq/servers/${serverId}/raw-config`);
    assert.equal(raw.status, 200);
    assert.equal(raw.json.cameraField, "Cameras");
    assert.equal(raw.json.cameraCount, 1);
    assert.equal(raw.json.cameras[0].name, "Entrada fixture");
    assert.ok(raw.json.shape);
    assert.ok(!JSON.stringify(raw.json).includes(EXACQ_PW), "el diagnóstico no revela claves del JSON original");
    assert.ok(!JSON.stringify(raw.json).includes(RAW_TOKEN), "el diagnóstico no revela tokens anidados");
    const adminRaw = await request(admin.cookie, "GET", `/api/exacq/servers/${serverId}/raw-config`);
    assert.equal(adminRaw.status, 200);
    assert.equal(adminRaw.json.Cameras[0].nested.token, RAW_TOKEN, "el administrador conserva su diagnóstico completo");
    const cameras = (await request(tester.cookie, "GET", "/api/cameras")).json;
    assert.ok(cameras.some((camera: { id: string; online: boolean }) => camera.id === cameraId && camera.online));
    const snapshot = await request(tester.cookie, "GET", `/api/cameras/${encodeURIComponent(cameraId)}/snapshot`);
    assert.equal(snapshot.status, 200);
    assert.match(String(snapshot.response.headers["content-type"]), /^image\/jpeg/);
    assert.deepEqual(snapshot.response.rawPayload, SNAPSHOT);
    const recordings = await request(tester.cookie, "GET", `/api/cameras/${encodeURIComponent(cameraId)}/recordings?start=2026-01-01T00%3A00%3A00Z&end=2026-01-01T00%3A02%3A00Z`);
    assert.equal(recordings.status, 200);
    assert.equal(recordings.json.length, 1);
  });

  test("un formato de exacq desconocido conserva su estructura para diagnosticar sin exponer valores", async () => {
    const original = remoteConfig;
    remoteConfig = { Servers: [{ Cameras: [{ Id: 9, Name: "Cámara anidada", password: EXACQ_PW }], secret: RAW_TOKEN }] };
    try {
      const raw = await request(tester.cookie, "GET", `/api/exacq/servers/${serverId}/raw-config`);
      assert.equal(raw.status, 200);
      assert.equal(raw.json.cameraField, null);
      assert.equal(raw.json.cameraCount, 0);
      assert.deepEqual(raw.json.cameras, []);
      assert.equal(raw.json.shape.Servers.length, 1);
      assert.equal(raw.json.shape.Servers.sample[0].Cameras.length, 1);
      assert.equal(raw.json.shape.Servers.sample[0].Cameras.sample[0].Id, "number");
      assert.ok(!JSON.stringify(raw.json).includes(EXACQ_PW));
      assert.ok(!JSON.stringify(raw.json).includes(RAW_TOKEN));
    } finally {
      remoteConfig = original;
    }
  });

  test("Tester no cambia configuración ni opera VPN, IA, usuarios o secretos", async () => {
    const revealed = await request(admin.cookie, "POST", `/api/vault/${credentialId}/reveal`);
    assert.equal(revealed.status, 200, "la instalación permite revelar al administrador");
    assert.equal(revealed.json.password, EXACQ_PW);
    const denied: Array<[string, string, unknown?]> = [
      ["POST", "/api/users", { username: "prohibido", role: "admin", password: INITIAL_PW }],
      ["PATCH", `/api/users/${viewer.id}`, { role: "admin" }],
      ["POST", `/api/users/${viewer.id}/password`, { password: INITIAL_PW }],
      ["POST", `/api/users/${viewer.id}/reset-2fa`],
      ["POST", `/api/users/${viewer.id}/unlock`],
      ["POST", "/api/vault", { name: "Prohibido", kind: "generic", secret: { password: EXACQ_PW } }],
      ["PATCH", `/api/vault/${credentialId}`, { name: "Prohibido" }],
      ["DELETE", `/api/vault/${credentialId}`],
      ["POST", `/api/vault/${credentialId}/reveal`],
      ["POST", "/api/exacq/servers", { name: "Prohibido", baseUrl: remoteUrl, credentialId }],
      ["PATCH", `/api/exacq/servers/${serverId}`, { enabled: false }],
      ["DELETE", `/api/exacq/servers/${serverId}`],
      ["PATCH", `/api/cameras/${encodeURIComponent(cameraId)}`, { name: "Prohibido", enabled: false }],
      ["POST", "/api/vpn/profiles", { name: "Prohibido", host: "vpn.fixture.local" }],
      ["PATCH", `/api/vpn/profiles/${profileId}`, { name: "Prohibido" }],
      ["DELETE", `/api/vpn/profiles/${profileId}`],
      ["POST", `/api/vpn/profiles/${profileId}/trust-cert`, { digest: "a".repeat(64) }],
      ["POST", "/api/vpn/connect", { profileId }],
      ["POST", "/api/vpn/disconnect"],
      ["PUT", "/api/ai/settings", { autoVerify: true }],
      ["POST", "/api/ai/analyze-camera", { camera: cameraId }],
      ["POST", "/api/ai/chat", { message: "Prueba" }],
      ["POST", "/api/ai/report", { hours: 1 }],
      ["DELETE", "/api/ai/conversations/fixture"],
      ["POST", "/api/recordings/export", { camera: cameraId, start: "2026-01-01T00:00:00Z", end: "2026-01-01T00:01:00Z" }],
      ["POST", `/api/events/${eventId}/status`, { status: "ack" }],
      ["POST", `/api/events/${eventId}/assign`, { assignee: "CodeChatGPT" }],
      ["POST", `/api/events/${eventId}/notes`, { text: "Prohibido" }],
      ["POST", `/api/events/${eventId}/analyze`],
      ["POST", "/api/events/ack-all", { ids: [eventId] }],
      ["POST", "/api/health/hosts", { name: "Prohibido", host: "127.0.0.1", port: 80 }],
      ["DELETE", `/api/health/hosts/${hostId}`],
      ["POST", "/api/ingest/keys", { name: "Prohibido" }],
      ["DELETE", `/api/ingest/keys/${ingestId}`],
    ];
    for (const [method, url, body] of denied) {
      const result = await request(tester.cookie, method, url, body);
      assert.equal(result.status, 403, `${method} ${url}`);
      assert.equal(result.json.error, "forbidden", `${method} ${url}`);
    }
    assert.equal(built.ctx.auth.getUser(viewer.id)!.role, "viewer");
    assert.equal(built.ctx.vault.meta(credentialId)!.name, "Exacq fixture");
    assert.equal(built.ctx.vpn.profile(profileId)!.name, "VPN fixture");
    assert.equal(built.ctx.vpn.status().state, "disconnected");
    assert.equal(built.ctx.cameras.row(cameraId)!.name, "Entrada fixture");
    assert.equal(built.ctx.events.get(eventId)!.status, "new");
    assert.equal(built.ctx.db.get<{ revoked: number }>("SELECT revoked FROM ingest_keys WHERE id = $id", { id: ingestId })!.revoked, 0);
    assert.equal(built.ctx.auth.getUserByName("prohibido"), undefined);
  });

  test("el permiso de diagnóstico no se hereda por operadores u observadores", async () => {
    const diagnostics: Array<[string, string]> = [
      ["GET", "/api/users"], ["GET", "/api/audit"], ["GET", "/api/audit/verify"], ["GET", "/api/vault"],
      ["GET", "/api/exacq/servers"], ["GET", "/api/ingest/keys"],
      ["POST", `/api/exacq/servers/${serverId}/test`], ["POST", `/api/exacq/servers/${serverId}/detect`],
      ["GET", `/api/exacq/servers/${serverId}/raw-config`],
    ];
    for (const account of [operator, viewer]) {
      for (const [method, url] of diagnostics) {
        const denied = await request(account.cookie, method, url);
        assert.equal(denied.status, 403, `${method} ${url}`);
        assert.equal(denied.json.error, "forbidden");
      }
      for (const url of ["/api/cameras", "/api/events", "/api/dashboard", "/api/health/hosts", "/api/vpn/status"]) {
        assert.equal((await request(account.cookie, "GET", url)).status, 200, url);
      }
    }
    for (const url of ["/api/vpn/profiles", "/api/vpn/logs", "/api/ai/usage"]) {
      assert.equal((await request(operator.cookie, "GET", url)).status, 200, `operador ${url}`);
      assert.equal((await request(viewer.cookie, "GET", url)).status, 403, `observador ${url}`);
      assert.equal((await request(admin.cookie, "GET", url)).status, 200, `administrador ${url}`);
    }
    const acknowledged = await request(operator.cookie, "POST", `/api/events/${eventId}/status`, { status: "ack" });
    assert.equal(acknowledged.status, 200);
    assert.equal(acknowledged.json.status, "ack");
    assert.equal((await request(viewer.cookie, "POST", `/api/events/${eventId}/status`, { status: "resolved" })).status, 403);
    assert.equal((await request(admin.cookie, "POST", `/api/exacq/servers/${serverId}/test`)).json.ok, true);
  });

  test("el administrador puede cambiar el rol y conserva la protección del último administrador", async () => {
    const lastAdmin = await request(admin.cookie, "PATCH", `/api/users/${admin.id}`, { role: "tester" });
    assert.equal(lastAdmin.status, 400);
    assert.equal(lastAdmin.json.error, "last_admin");
    assert.equal(built.ctx.auth.getUser(admin.id)!.role, "admin");
    const changed = await request(admin.cookie, "PATCH", `/api/users/${viewer.id}`, { role: "tester" });
    assert.equal(changed.status, 200);
    assert.equal(changed.json.role, "tester");
    assert.equal((await request(viewer.cookie, "GET", "/api/exacq/servers")).status, 200, "el permiso usa el rol vigente");
    assert.equal((await request(viewer.cookie, "POST", "/api/vpn/disconnect")).status, 403);
    assert.equal((await request(admin.cookie, "PATCH", `/api/users/${viewer.id}`, { role: "viewer" })).status, 200);
    assert.equal((await request(viewer.cookie, "GET", "/api/exacq/servers")).status, 403, "revocar el rol revoca los diagnósticos de la sesión existente");
  });

  test("los siguientes ingresos exigen segundo factor y consumen cada código de recuperación una sola vez", async () => {
    assert.equal((await request(tester.cookie, "POST", "/api/auth/logout")).status, 200);
    assert.equal((await request(tester.cookie, "GET", "/api/cameras")).status, 401);
    const login = await request("", "POST", "/api/auth/login", { username: "CodeChatGPT", password: CHANGED_PW });
    assert.equal(login.status, 200);
    assert.equal(login.json.mfaRequired, true);
    assert.equal(login.cookie, "", "la contraseña no entrega una sesión autenticada");
    assert.equal((await request("", "GET", "/api/exacq/servers")).status, 401);
    const firstCode = tester.recoveryCodes[0]!;
    const mfa = await request("", "POST", "/api/auth/mfa", { mfaToken: login.json.mfaToken, code: firstCode });
    assert.equal(mfa.status, 200);
    assert.equal(mfa.json.user.role, "tester");
    assert.equal(mfa.json.recoveryCodesLeft, 9);
    assert.ok(mfa.cookie);
    assert.equal((await request(mfa.cookie, "GET", "/api/exacq/servers")).status, 200);
    await request(mfa.cookie, "POST", "/api/auth/logout");
    const loginAgain = await request("", "POST", "/api/auth/login", { username: "CodeChatGPT", password: CHANGED_PW });
    assert.equal(loginAgain.status, 200);
    const replay = await request("", "POST", "/api/auth/mfa", { mfaToken: loginAgain.json.mfaToken, code: firstCode });
    assert.equal(replay.status, 401);
    assert.equal(replay.json.error, "mfa_invalid");
    const next = await request("", "POST", "/api/auth/mfa", { mfaToken: loginAgain.json.mfaToken, code: tester.recoveryCodes[1]! });
    assert.equal(next.status, 200);
    assert.equal(next.json.recoveryCodesLeft, 8);
    tester.cookie = next.cookie;
  });

  test("reiniciar el 2FA de Tester revoca sus sesiones y vuelve a exigir el alta", async () => {
    const reset = await request(admin.cookie, "POST", `/api/users/${tester.id}/reset-2fa`);
    assert.equal(reset.status, 200);
    assert.equal((await request(tester.cookie, "GET", "/api/cameras")).status, 401);
    const login = await request("", "POST", "/api/auth/login", { username: "CodeChatGPT", password: CHANGED_PW });
    assert.equal(login.status, 200);
    assert.equal(login.json.restrictions.mustEnrollTotp, true);
    const denied = await request(login.cookie, "GET", "/api/exacq/servers");
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error, "must_enroll_totp");
    assert.equal((await request(login.cookie, "POST", "/api/auth/step-up", { password: CHANGED_PW })).status, 403, "la clave no permite omitir el alta de Tester");
  });
});
