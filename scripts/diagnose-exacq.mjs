// Run from the VPS checkout without rebuilding or restarting the active VPN:
// docker exec -i camerasia node --disable-warning=ExperimentalWarning --input-type=module < scripts/diagnose-exacq.mjs
// Uses the container's existing configuration and decrypts its assigned credential in memory.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const TIMEOUT_MS = 30_000;
const CONTENT_TYPES = new Set(["application/json", "text/html", "text/plain", "application/octet-stream"]);
const TRANSPORT_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]);
let db;
let session;
let baseUrl;

function emit(data) {
  // Only fixed protocol labels, numbers and booleans reach this function.
  // No response text, arbitrary JSON keys, URL, account or session is printed.
  console.log(JSON.stringify(data));
}

function stop(reason) {
  emit({ diagnosis: reason });
  process.exitCode = 1;
}

function moduleUrl(relative) {
  return pathToFileURL(path.resolve(process.cwd(), relative)).href;
}

async function request(endpoint, init = {}) {
  let stage = "headers";
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = new URL(endpoint, baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
    const response = await fetch(url, { ...init, redirect: "manual", signal: controller.signal });
    stage = "body";
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch {}
    const object = json !== null && typeof json === "object" && !Array.isArray(json) ? json : undefined;
    const sessionId = object?.sessionId;
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    emit({
      endpoint: endpoint.split("?")[0],
      method: init.method ?? "GET",
      status: response.status,
      type: CONTENT_TYPES.has(contentType) ? contentType : "other",
      stage: "complete",
      ms: Date.now() - start,
      bytes: Buffer.byteLength(text),
      hasHtmlTitle: /<title[^>]*>.*?<\/title>/is.test(text),
      jsonKeyCount: object ? Object.keys(object).length : undefined,
      success: typeof object?.success === "boolean" ? object.success : undefined,
      hasSessionId: object ? typeof sessionId === "string" && Boolean(sessionId) : undefined,
    });
    return { response, json: object };
  } catch (error) {
    emit({
      endpoint: endpoint.split("?")[0],
      method: init.method ?? "GET",
      stage,
      ms: Date.now() - start,
      timeout: controller.signal.aborted,
      error: controller.signal.aborted ? "timeout" : "transport_error",
      cause: TRANSPORT_CODES.has(error?.cause?.code) ? error.cause.code : undefined,
    });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

try {
  const [{ loadConfig }, { loadKeyRing }, { SecretSchema }] = await Promise.all([
    import(moduleUrl("server/dist/config.js")),
    import(moduleUrl("server/dist/security/crypto.js")),
    import(moduleUrl("server/dist/vault/service.js")),
  ]);
  const cfg = loadConfig(process.env);
  // Force the existing-key path: the diagnostic must never generate a replacement key.
  if (!cfg.VAULT_MASTER_KEY && !cfg.VAULT_KEY_FILE && !fs.existsSync(path.join(cfg.paths.secrets, "vault.key"))) {
    throw new Error("missing_key");
  }
  const keys = loadKeyRing({
    masterKey: cfg.VAULT_MASTER_KEY,
    keyFile: cfg.VAULT_KEY_FILE,
    secretsDir: cfg.paths.secrets,
    isProd: true,
    log: () => undefined,
  });
  db = new DatabaseSync(cfg.paths.db, { readOnly: true });
  const servers = db.prepare("SELECT id, name, base_url, credential_id FROM exacq_servers WHERE enabled = 1 ORDER BY name").all();
  const selected = servers.length === 1 ? servers[0] : servers.filter((row) => /bistro/i.test(row.name));
  const server = Array.isArray(selected) ? selected.length === 1 ? selected[0] : undefined : selected;
  if (!server) {
    stop(servers.length ? "ambiguous_server_select_one_enabled_bistro" : "no_enabled_server");
  } else {
    const vault = db.prepare("SELECT payload_enc FROM vault_entries WHERE id = ?").get(server.credential_id ?? "");
    if (!vault) {
      stop("missing_assigned_credential");
    } else {
      const credential = SecretSchema.parse(JSON.parse(keys.decryptString(vault.payload_enc, `vault:${server.credential_id}`)));
      if (!credential.username || !credential.password) {
        stop("incomplete_assigned_credential");
      } else {
        const parsedUrl = new URL(server.base_url);
        if (!["http:", "https:"].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
          throw new Error("invalid_base_url");
        }
        baseUrl = server.base_url;
        emit({ diagnostic: "exacq_stored_credential", timeoutMs: TIMEOUT_MS });
        const login = await request("v1/login.web", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ u: credential.username, p: credential.password, responseVersion: "2", s: "0" }),
        });
        if (!login) {
          stop("login_transport_failed");
        } else if (!login.response.ok) {
          stop("login_http_failed");
        } else if (!login.json) {
          stop("login_not_json");
        } else if (login.json.success === false || typeof login.json.sessionId !== "string" || !login.json.sessionId) {
          stop("login_rejected_or_missing_session");
        } else {
          session = login.json.sessionId;
          const config = await request(`v1/config.web?${new URLSearchParams({ s: session, output: "json" })}`);
          if (!config) {
            stop("config_transport_failed");
          } else if (!config.response.ok) {
            stop("config_http_failed");
          } else if (!config.json || config.json.success === false) {
            stop("config_not_valid_json");
          } else {
            const cameraField = Array.isArray(config.json.Cameras) ? "Cameras" : Array.isArray(config.json.cameras) ? "cameras" : undefined;
            const cameras = cameraField ? config.json[cameraField] : undefined;
            if (!cameras) {
              stop("config_missing_camera_array");
            } else {
              const missingIdCount = cameras.filter((camera) => !camera || (camera.id === undefined && camera.Id === undefined)).length;
              emit({ diagnosis: "camera_inventory_received", cameraField, cameraCount: cameras.length, missingIdCount });
              if (missingIdCount) process.exitCode = 1;
            }
          }
        }
      }
    }
  }
} catch {
  stop("local_configuration_or_vault_error");
} finally {
  if (session && baseUrl) {
    const logout = await request(`v1/logout.web?${new URLSearchParams({ s: session })}`, { method: "POST" });
    if (!logout?.response.ok) stop("logout_failed");
  }
  db?.close();
}
