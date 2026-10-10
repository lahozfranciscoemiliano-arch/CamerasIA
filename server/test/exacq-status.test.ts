import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { ExacqSource } from "../src/exacq/client.js";
import type { SourceStatus } from "../src/exacq/types.js";

type ResponseFixture = { status?: number; body: string };
const validLogin = { body: JSON.stringify({ success: true, sessionId: "test-session" }) };
const validConfig = { body: JSON.stringify({ Cameras: [{ id: 1, name: "Entrada" }] }) };

async function fixture() {
  const responses = { login: validLogin as ResponseFixture, config: validConfig as ResponseFixture };
  const server = http.createServer((req, res) => {
    req.resume();
    const endpoint = new URL(req.url!, "http://localhost").pathname;
    const response = endpoint === "/v1/login.web" ? responses.login : responses.config;
    res.writeHead(response.status ?? 200, { "Content-Type": "application/json" });
    res.end(response.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const notifications: SourceStatus[] = [];
  let credentials: { username: string; password: string } | undefined = { username: "viewer", password: "test-password" };
  const source = new ExacqSource(
    { id: "test", name: "Prueba", baseUrl: `http://127.0.0.1:${port}` },
    () => credentials,
    (status) => notifications.push(status),
  );
  return {
    source,
    responses,
    notifications,
    clearCredentials: () => { credentials = undefined; },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

const invalidConfigs: Array<{ name: string; response: ResponseFixture; error: RegExp }> = [
  { name: "HTTP 404", response: { status: 404, body: "{}" }, error: /config\.web.*HTTP 404/ },
  { name: "HTML", response: { body: "<html>Login</html>" }, error: /config\.web.*no JSON/ },
  { name: "sesión rechazada en JSON", response: { body: '{"success":false}' }, error: /config\.web.*success=false/ },
  { name: "HTTP 401 persistente", response: { status: 401, body: "{}" }, error: /Sesión.*rechazada/ },
  { name: "estructura desconocida", response: { body: '{"unexpected":[]}' }, error: /config\.web.*Cameras/ },
];

for (const { name, response, error } of invalidConfigs) {
  test(`exacq no figura conectado si config.web devuelve ${name}, y se recupera al listar cámaras válidas`, async () => {
    const f = await fixture();
    try {
      await f.source.login();
      assert.equal(f.source.status().ok, true, "login válido");
      const previousOkAt = f.source.status().lastOkAt;
      f.responses.config = response;
      await assert.rejects(f.source.listCameras(), error);
      assert.equal(f.source.status().ok, false, "la respuesta inválida no confirma la conexión");
      assert.match(f.source.status().detail, error);
      assert.equal(f.notifications.at(-1)?.ok, false, "notifica el fallo al servicio");
      if (response.status === 404 || name === "estructura desconocida") {
        assert.equal(f.source.status().lastOkAt, previousOkAt, "el fallo no actualiza la última conexión válida");
      }
      f.responses.config = validConfig;
      assert.deepEqual((await f.source.listCameras()).map((camera) => camera.name), ["Entrada"]);
      assert.equal(f.source.status().ok, true);
      assert.equal(f.notifications.at(-1)?.ok, true, "notifica la recuperación");
      assert.ok(f.source.status().lastOkAt);
      assert.equal(typeof f.source.status().latencyMs, "number");
    } finally {
      await f.close();
    }
  });
}

const invalidLogins: Array<{ name: string; response: ResponseFixture; error: RegExp }> = [
  { name: "HTTP 404", response: { status: 404, body: "{}" }, error: /Login HTTP 404/ },
  { name: "HTML", response: { body: "<html>Login</html>" }, error: /login no devolvió JSON/ },
  { name: "credenciales rechazadas", response: { body: '{"success":false}' }, error: /Credenciales.*rechazadas/ },
  { name: "success=false con sessionId", response: { body: '{"success":false,"sessionId":"invalid"}' }, error: /Credenciales.*rechazadas/ },
];

for (const { name, response, error } of invalidLogins) {
  test(`exacq informa el error de login ante ${name}`, async () => {
    const f = await fixture();
    try {
      f.responses.login = response;
      await assert.rejects(f.source.login(), error);
      assert.equal(f.source.status().ok, false);
      assert.match(f.source.status().detail, error);
      assert.equal(f.source.status().lastOkAt, null);
      assert.equal(f.notifications.at(-1)?.ok, false);
      f.responses.login = validLogin;
      await f.source.login();
      assert.equal(f.source.status().ok, true);
    } finally {
      await f.close();
    }
  });
}

test("exacq informa credenciales ausentes aunque antes haya conectado", async () => {
  const f = await fixture();
  try {
    await f.source.login();
    f.clearCredentials();
    await assert.rejects(f.source.login(), /no tiene credenciales/);
    assert.equal(f.source.status().ok, false);
    assert.match(f.source.status().detail, /no tiene credenciales/);
    assert.equal(f.notifications.at(-1)?.ok, false);
  } finally {
    await f.close();
  }
});

test("exacq conserva soporte de Cameras/cameras e inventarios vacíos", async () => {
  const f = await fixture();
  try {
    for (const config of [{ Cameras: [] }, { cameras: [] }, { cameras: [{ Id: "2", Name: "Patio" }] }]) {
      f.responses.config = { body: JSON.stringify(config) };
      const cameras = await f.source.listCameras();
      assert.equal(cameras.length, config.cameras?.length ?? 0);
      assert.equal(f.source.status().ok, true);
    }
  } finally {
    await f.close();
  }
});
