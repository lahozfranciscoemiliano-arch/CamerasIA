import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { buildApp, type BuiltApp } from "../src/app.js";
import { totp } from "../src/security/totp.js";

const ADMIN_PW = "Inicial!Segura2026";
const NEW_PW = "Cambiada!Segura2026";

describe("API: autenticación, 2FA, CSRF, RBAC y bóveda", () => {
  let built: BuiltApp;
  let app: FastifyInstance;
  let dir: string;
  let cookie = "";
  let secret = "";

  const req = async (method: string, url: string, body?: unknown, opts: { csrf?: boolean; cookie?: string; origin?: string; ip?: string } = {}) => {
    const res = await app.inject({
      method: method as "GET",
      url,
      remoteAddress: opts.ip,
      payload: body === undefined ? undefined : (body as object),
      headers: {
        ...(opts.csrf === false ? {} : { "x-requested-with": "CamerasIA" }),
        ...(opts.origin ? { origin: opts.origin } : {}),
        cookie: opts.cookie ?? cookie,
      },
    });
    const sc = res.headers["set-cookie"];
    if (sc && opts.cookie === undefined) cookie = String(Array.isArray(sc) ? sc[0] : sc).split(";")[0]!;
    return { status: res.statusCode, json: res.headers["content-type"]?.includes("json") ? res.json() : res.body };
  };

  // Espera a la siguiente ventana TOTP (anti-replay impide reutilizar el mismo paso).
  const freshCode = async (lastUsedAt: number) => {
    const step = Math.floor(lastUsedAt / 30000);
    while (Math.floor(Date.now() / 30000) <= step) await new Promise((r) => setTimeout(r, 250));
    return totp(secret);
  };

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cia-test-"));
    const cfg = loadConfig({ DATA_DIR: dir, DEMO_MODE: "false", ADMIN_INITIAL_PASSWORD: ADMIN_PW, VPN_MODE: "simulate", LOG_LEVEL: "error" } as NodeJS.ProcessEnv);
    built = await buildApp(cfg, { logger: false });
    app = built.app;
    await built.ctx.auth.ensureInitialAdmin(() => undefined);
    await app.ready();
  });

  after(async () => {
    await built.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("rechaza credenciales inválidas sin revelar si el usuario existe", async () => {
    const a = await req("POST", "/api/auth/login", { username: "admin", password: "mala" });
    const b = await req("POST", "/api/auth/login", { username: "noexiste", password: "mala" });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal((a.json as { message: string }).message, (b.json as { message: string }).message);
  });

  test("CSRF: exige cabecera propia y origen válido", async () => {
    assert.equal((await req("POST", "/api/auth/login", { username: "admin", password: ADMIN_PW }, { csrf: false })).status, 403);
    assert.equal((await req("POST", "/api/auth/login", { username: "admin", password: ADMIN_PW }, { origin: "https://evil.example" })).status, 403);
  });

  test("primer ingreso: cambio de clave y alta de 2FA obligatorios", async () => {
    const login = await req("POST", "/api/auth/login", { username: "admin", password: ADMIN_PW });
    assert.equal(login.status, 200);
    assert.equal((login.json as { restrictions: { mustChangePassword: boolean } }).restrictions.mustChangePassword, true);
    assert.equal((await req("GET", "/api/cameras")).status, 403, "sesión restringida");
    assert.equal((await req("POST", "/api/auth/password", { current: ADMIN_PW, next: "debil" })).status, 400);
    assert.equal((await req("POST", "/api/auth/password", { current: ADMIN_PW, next: NEW_PW })).status, 200);
    const me = (await req("GET", "/api/auth/me")).json as { restrictions: { mustEnrollTotp: boolean } };
    assert.equal(me.restrictions.mustEnrollTotp, true);
    const begin = (await req("POST", "/api/auth/totp/begin")).json as { secret: string; qr: string };
    secret = begin.secret;
    assert.match(begin.qr, /^data:image\/png;base64,/);
    assert.equal((await req("POST", "/api/auth/totp/confirm", { code: "000000" })).status, 400);
    const conf = await req("POST", "/api/auth/totp/confirm", { code: totp(secret) });
    assert.equal(conf.status, 200);
    assert.equal((conf.json as { recoveryCodes: string[] }).recoveryCodes.length, 10);
    assert.equal((await req("GET", "/api/cameras")).status, 200);
  });

  test("login con 2FA y paso de re-autenticación para la bóveda", async () => {
    const enrolledAt = Date.now();
    await req("POST", "/api/auth/logout");
    assert.equal((await req("GET", "/api/auth/me")).status, 401);
    const step1 = (await req("POST", "/api/auth/login", { username: "admin", password: NEW_PW })).json as { mfaRequired: boolean; mfaToken: string };
    assert.equal(step1.mfaRequired, true);
    assert.equal((await req("GET", "/api/auth/me")).status, 401, "sin sesión hasta completar el 2FA");
    const code = await freshCode(enrolledAt);
    assert.equal((await req("POST", "/api/auth/mfa", { mfaToken: step1.mfaToken, code })).status, 200);
    // El login con 2FA cuenta como re-autenticación reciente
    const created = await req("POST", "/api/vault", { name: "FortiGate", kind: "fortivpn", secret: { username: "jperez", password: "S3creta!" } });
    assert.equal(created.status, 200);
    const list = await req("GET", "/api/vault");
    assert.ok(!JSON.stringify(list.json).includes("S3creta!"), "la API nunca devuelve el secreto");
    const id = (created.json as { id: string }).id;
    assert.equal((await req("POST", `/api/vault/${id}/reveal`)).status, 403, "revelar deshabilitado por defecto");

    // Expira la re-autenticación → la próxima acción sensible la exige
    built.ctx.db.run("UPDATE sessions SET step_up_at = 0");
    const denied = await req("POST", "/api/vault", { name: "X", kind: "generic", secret: { password: "y" } });
    assert.equal(denied.status, 403);
    assert.equal((denied.json as { error: string }).error, "step_up_required");
    const used = Math.floor(Date.now() / 30000) * 30000;
    assert.equal((await req("POST", "/api/auth/step-up", { code: "123456" })).status, 401);
    assert.equal((await req("POST", "/api/auth/step-up", { code: await freshCode(used) })).status, 200);
    assert.equal((await req("POST", "/api/vault", { name: "X", kind: "generic", secret: { password: "y" } })).status, 200);

    // Perfil VPN + conexión simulada usando la credencial guardada
    const prof = (await req("POST", "/api/vpn/profiles", { name: "HQ", host: "vpn.empresa.com", port: 443, credentialId: id })).json as { id: string };
    assert.equal((await req("POST", "/api/vpn/connect", { profileId: prof.id })).status, 200);
    await new Promise((r) => setTimeout(r, 3800));
    const st = (await req("GET", "/api/vpn/status")).json as { state: string; assignedIp: string };
    assert.equal(st.state, "connected");
    assert.match(st.assignedIp, /^10\.212\./);
    const logs = JSON.stringify((await req("GET", "/api/vpn/logs")).json);
    assert.ok(!logs.includes("S3creta!"), "la contraseña nunca aparece en el log");
    await req("POST", "/api/vpn/disconnect");
  });

  test("RBAC: un observador no puede administrar", async () => {
    const created = await req("POST", "/api/users", { username: "guardia1", role: "viewer", password: "Observador!2026x" });
    assert.equal(created.status, 200);
    let viewerCookie = "";
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "guardia1", password: "Observador!2026x" }, headers: { "x-requested-with": "CamerasIA" } });
    viewerCookie = String(login.headers["set-cookie"]).split(";")[0]!;
    assert.equal((await req("POST", "/api/auth/password", { current: "Observador!2026x", next: "Observador!2027y" }, { cookie: viewerCookie })).status, 200);
    // Sin 2FA (REQUIRE_2FA=true) sigue restringido
    assert.equal((await req("GET", "/api/events", undefined, { cookie: viewerCookie })).status, 403);
    built.ctx.db.run("UPDATE users SET totp_enabled = 1 WHERE username = 'guardia1'"); // simula 2FA activo
    assert.equal((await req("GET", "/api/events", undefined, { cookie: viewerCookie })).status, 200);
    assert.equal((await req("GET", "/api/vault", undefined, { cookie: viewerCookie })).status, 403);
    assert.equal((await req("GET", "/api/users", undefined, { cookie: viewerCookie })).status, 403);
    assert.equal((await req("POST", "/api/vpn/connect", { profileId: "x" }, { cookie: viewerCookie })).status, 403);
  });

  test("bloqueo de cuenta tras intentos fallidos", async () => {
    // IP propia para no chocar con el rate-limit por IP de las pruebas anteriores
    const ip = "10.9.9.9";
    for (let i = 0; i < 5; i++) assert.equal((await req("POST", "/api/auth/login", { username: "guardia1", password: "incorrecta" }, { cookie: "", ip })).status, 401);
    const r = await req("POST", "/api/auth/login", { username: "guardia1", password: "Observador!2027y" }, { cookie: "", ip });
    assert.equal(r.status, 423, "la cuenta queda bloqueada aun con la contraseña correcta");
    // y el rate-limit por IP corta la fuerza bruta
    let limited = false;
    for (let i = 0; i < 8 && !limited; i++) limited = (await req("POST", "/api/auth/login", { username: "x", password: "y" }, { cookie: "", ip })).status === 429;
    assert.equal(limited, true);
  });

  test("ingesta externa con API key", async () => {
    const k = (await req("POST", "/api/ingest/keys", { name: "frigate" })).json as { key: string };
    assert.match(k.key, /^cia_/);
    const bad = await app.inject({ method: "POST", url: "/api/ingest/detections", payload: { title: "x" }, headers: { authorization: "Bearer cia_invalida_123456" } });
    assert.equal(bad.statusCode, 401);
    const ok = await app.inject({ method: "POST", url: "/api/ingest/detections", payload: { title: "Persona en perímetro", type: "person", severity: "high" }, headers: { authorization: `Bearer ${k.key}` } });
    assert.equal(ok.statusCode, 200);
    const evs = (await req("GET", "/api/events?limit=5")).json as Array<{ title: string; source: string }>;
    assert.ok(evs.some((e) => e.title === "Persona en perímetro" && e.source.startsWith("ext:")));
  });

  test("la bitácora de auditoría queda íntegra", async () => {
    const v = (await req("GET", "/api/audit/verify")).json as { ok: boolean; checked: number };
    assert.equal(v.ok, true);
    assert.ok(v.checked > 10);
    const rows = (await req("GET", "/api/audit?action=vault")).json as Array<{ action: string }>;
    assert.ok(rows.some((r) => r.action === "vault.create"));
  });
});
