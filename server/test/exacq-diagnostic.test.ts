import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { Db } from "../src/db/index.js";
import { KeyRing } from "../src/security/crypto.js";
import { VaultService } from "../src/vault/service.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = fs.readFileSync(path.join(repo, "scripts/diagnose-exacq.mjs"), "utf8");
const username = "fixture-user-ś&=+/";
const password = "fixture-password-&=+/$\"':😀";
const sessionId = "fixture-session-do-not-print";
const masterKey = Buffer.alloc(32, 71);

type Reply = { body: string; type?: string; status?: number; interruptBody?: boolean };

async function fixture(login: Reply, config: Reply = { body: JSON.stringify({ Cameras: [{ id: 7, name: "Entrada" }, { Id: 8, Name: password }] }) }, credential = { username, password }, logout: Reply = { body: "{}" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cia-diagnostic-"));
  const data = path.join(dir, "data");
  const requests: Array<{ endpoint: string; method: string; params: URLSearchParams }> = [];
  const remote = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk.toString();
    const url = new URL(req.url!, "http://localhost");
    requests.push({ endpoint: url.pathname, method: req.method!, params: req.method === "POST" && url.pathname.endsWith("login.web") ? new URLSearchParams(body) : url.searchParams });
    const response = url.pathname === "/v1/login.web" ? login : url.pathname === "/v1/config.web" ? config : logout;
    res.writeHead(response.status ?? 200, { "Content-Type": response.type ?? "application/json" });
    if (response.interruptBody) {
      res.write(response.body);
      setTimeout(() => res.destroy(), 100);
    } else {
      res.end(response.body);
    }
  });
  await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
  const port = (remote.address() as AddressInfo).port;
  const db = new Db(path.join(data, "camerasia.db"));
  const vault = new VaultService(db, new KeyRing({ 1: masterKey }, 1));
  const credentialId = vault.create({ name: "Fixture", kind: "exacq", secret: credential });
  db.run("INSERT INTO exacq_servers(id, name, base_url, credential_id, created_at, updated_at) VALUES('bistro', 'Bistro', $url, $credential, 1, 1)", {
    url: `http://127.0.0.1:${port}`,
    credential: credentialId,
  });
  const before = {
    vault: db.all("SELECT * FROM vault_entries"),
    servers: db.all("SELECT * FROM exacq_servers"),
    meta: db.all("SELECT * FROM meta"),
  };

  // Build only the three actual runtime dependencies in the fixture, so the CLI
  // test also works after npm ci when the application's dist directory is absent.
  fs.symlinkSync(path.join(repo, "node_modules"), path.join(dir, "node_modules"), "dir");
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
  for (const module of ["config", "security/crypto", "vault/service"]) {
    const file = path.join(dir, "server/dist", `${module}.js`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const input = fs.readFileSync(path.join(repo, "server/src", `${module}.ts`), "utf8");
    fs.writeFileSync(file, ts.transpileModule(input, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
  }

  return {
    requests,
    run: () => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module"], {
        cwd: dir,
        env: { ...process.env, NODE_ENV: "production", DATA_DIR: data, VAULT_MASTER_KEY: masterKey.toString("hex"), VAULT_KEY_FILE: "" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(source);
    }),
    assertUnchanged: () => {
      assert.deepEqual(db.all("SELECT * FROM vault_entries"), before.vault, "no actualiza metadatos ni secreto de la bóveda");
      assert.deepEqual(db.all("SELECT * FROM exacq_servers"), before.servers, "no cambia el estado del servidor");
      assert.deepEqual(db.all("SELECT * FROM meta"), before.meta, "no ejecuta migraciones");
    },
    close: async () => {
      db.close();
      await new Promise<void>((resolve, reject) => remote.close((error) => error ? reject(error) : resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function output(result: { stdout: string; stderr: string }) {
  assert.equal(result.stderr, "");
  for (const secret of [username, password, sessionId, masterKey.toString("hex")]) {
    assert.equal(result.stdout.includes(secret), false, "el diagnóstico nunca imprime secretos");
    assert.equal(result.stdout.includes(JSON.stringify(secret).slice(1, -1)), false, "tampoco imprime secretos escapados");
  }
  return result.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("diagnóstico conserva el inventario obtenido e informa un fallo al cerrar su sesión", async () => {
  const f = await fixture({ body: JSON.stringify({ sessionId }) }, undefined, undefined, { body: "{}", status: 500 });
  try {
    const result = await f.run();
    assert.equal(result.code, 1);
    const rows = output(result);
    assert.ok(rows.some((row) => row.diagnosis === "camera_inventory_received" && row.cameraCount === 2));
    assert.ok(rows.some((row) => row.diagnosis === "logout_failed"));
    assert.equal(f.requests.at(-1)?.endpoint, "/v1/logout.web");
    f.assertUnchanged();
  } finally { await f.close(); }
});

test("diagnóstico por stdin usa la credencial cifrada, cuenta cámaras y cierra su sesión sin escribir la BD", async () => {
  const f = await fixture({ body: JSON.stringify({ success: true, sessionId }) });
  try {
    const result = await f.run();
    assert.equal(result.code, 0);
    const rows = output(result);
    assert.equal(rows[0]!.timeoutMs, 30_000);
    assert.ok(rows.some((row) => row.diagnosis === "camera_inventory_received" && row.cameraCount === 2 && row.missingIdCount === 0));
    assert.deepEqual(f.requests.map((req) => [req.endpoint, req.method]), [["/v1/login.web", "POST"], ["/v1/config.web", "GET"], ["/v1/logout.web", "POST"]]);
    assert.equal(f.requests[0]!.params.get("u"), username);
    assert.equal(f.requests[0]!.params.get("p"), password);
    assert.equal(f.requests[0]!.params.get("responseVersion"), "2");
    assert.equal(f.requests[0]!.params.get("s"), "0");
    assert.equal(f.requests[1]!.params.get("s"), sessionId);
    assert.equal(f.requests[1]!.params.get("output"), "json");
    assert.equal(f.requests[2]!.params.get("s"), sessionId);
    f.assertUnchanged();
  } finally { await f.close(); }
});

test("diagnóstico distingue el HTML de login, oculta secretos incluso en el título y no consulta cámaras", async () => {
  const htmlPassword = password.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const f = await fixture({ type: "text/html", body: `<html><title>Login ${username} ${htmlPassword}</title><p>${sessionId} ${encodeURIComponent(password)}</p></html>` });
  try {
    const result = await f.run();
    assert.equal(result.code, 1);
    const rows = output(result);
    assert.ok(rows.some((row) => row.endpoint === "v1/login.web" && row.status === 200 && row.type === "text/html" && row.hasHtmlTitle === true));
    assert.equal(result.stdout.includes(htmlPassword), false);
    assert.equal(result.stdout.includes(encodeURIComponent(password)), false);
    assert.ok(rows.some((row) => row.diagnosis === "login_not_json"));
    assert.equal(f.requests.length, 1, "el HTML no se acepta como sesión válida");
    f.assertUnchanged();
  } finally { await f.close(); }
});

test("diagnóstico distingue el rechazo de autenticación sin imprimir mensajes ni sessionId inválido", async () => {
  const f = await fixture({ body: JSON.stringify({ success: false, sessionId, message: password }) });
  try {
    const result = await f.run();
    assert.equal(result.code, 1);
    const rows = output(result);
    assert.ok(rows.some((row) => row.success === false && row.hasSessionId === true));
    assert.ok(rows.some((row) => row.diagnosis === "login_rejected_or_missing_session"));
    assert.equal(f.requests.length, 1);
    f.assertUnchanged();
  } finally { await f.close(); }
});

test("diagnóstico informa una configuración incompatible y cierra la sesión aunque falle el inventario", async () => {
  const f = await fixture({ body: JSON.stringify({ sessionId }) }, { body: JSON.stringify({ devices: [{ name: password }] }) });
  try {
    const result = await f.run();
    assert.equal(result.code, 1);
    const rows = output(result);
    assert.ok(rows.some((row) => row.diagnosis === "config_missing_camera_array"));
    assert.equal(f.requests.at(-1)?.endpoint, "/v1/logout.web");
    f.assertUnchanged();
  } finally { await f.close(); }
});

test("diagnóstico conserva etiquetas JSON con nombres de cuenta cortos y omite claves remotas arbitrarias", async () => {
  const f = await fixture({ type: `application/x-${encodeURIComponent(password)}`, body: JSON.stringify({ sessionId, [encodeURIComponent(password)]: "irrelevant" }) }, undefined, { username: "a", password });
  try {
    const result = await f.run();
    assert.equal(result.code, 0);
    const rows = output(result);
    assert.equal(rows[0]!.diagnostic, "exacq_stored_credential");
    assert.ok(rows.some((row) => row.endpoint === "v1/login.web" && row.type === "other"));
    assert.ok(rows.some((row) => row.diagnosis === "camera_inventory_received" && row.cameraCount === 2));
    assert.equal(result.stdout.includes(encodeURIComponent(password)), false);
    assert.equal(f.requests[0]!.params.get("u"), "a");
    f.assertUnchanged();
  } finally { await f.close(); }
});

test("diagnóstico identifica el fallo durante el cuerpo HTTP y cierra la sesión del login válido", async () => {
  const f = await fixture({ body: JSON.stringify({ sessionId }) }, { body: '{"Cameras":[', interruptBody: true });
  try {
    const result = await f.run();
    assert.equal(result.code, 1);
    const rows = output(result);
    assert.ok(rows.some((row) => row.endpoint === "v1/config.web" && row.stage === "body" && row.error === "transport_error"));
    assert.ok(rows.some((row) => row.diagnosis === "config_transport_failed"));
    assert.equal(f.requests.at(-1)?.endpoint, "/v1/logout.web");
    f.assertUnchanged();
  } finally { await f.close(); }
});
