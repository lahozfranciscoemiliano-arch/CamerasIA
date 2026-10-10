import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { ZodError } from "zod";
import type { AppConfig } from "./config.js";
import type { AppCtx } from "./context.js";
import { Db } from "./db/index.js";
import { Bus } from "./realtime/bus.js";
import { AuditService } from "./audit/service.js";
import { loadKeyRing } from "./security/crypto.js";
import { VaultService } from "./vault/service.js";
import { AuthError, AuthService } from "./auth/service.js";
import { HttpError, makeGuard } from "./http/guards.js";
import { CameraService } from "./exacq/service.js";
import { EventService } from "./events/service.js";
import { AlertSettingsStore } from "./events/settings.js";
import { IncidentManager } from "./events/incidents.js";
import { NotificationHub } from "./events/notify.js";
import { VpnManager } from "./vpn/manager.js";
import { HealthService } from "./health/service.js";
import { AiService } from "./ai/service.js";
import { DetectionEngine } from "./detection/engine.js";
import { DemoSimulator } from "./detection/demo-sim.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { registerUserRoutes } from "./users/routes.js";
import { registerVaultRoutes } from "./vault/routes.js";
import { registerCameraRoutes } from "./exacq/routes.js";
import { registerVpnRoutes } from "./vpn/routes.js";
import { registerEventRoutes } from "./events/routes.js";
import { registerAiRoutes } from "./ai/routes.js";
import { registerHealthRoutes } from "./health/routes.js";
import { registerRealtime } from "./realtime/ws.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppCtx;
  startBackground: () => Promise<void>;
  shutdown: () => Promise<void>;
}

export async function buildApp(cfg: AppConfig, opts: { logger?: boolean } = {}): Promise<BuiltApp> {
  for (const dir of Object.values(cfg.paths)) if (!dir.endsWith(".db")) fs.mkdirSync(dir, { recursive: true });

  const app = Fastify({
    logger: opts.logger === false ? false : { level: cfg.LOG_LEVEL, redact: ["req.headers.cookie", "req.headers.authorization", "req.headers['x-api-key']"] },
    // Detrás de un proxy (Caddy, FortiGate) se confía sólo en saltos de redes privadas/loopback,
    // para que nadie pueda falsificar su IP con X-Forwarded-For desde Internet.
    trustProxy: cfg.TRUST_PROXY ? "loopback, linklocal, uniquelocal" : false,
    bodyLimit: 1024 * 1024,
    ...(cfg.tls ? { https: { key: fs.readFileSync(cfg.TLS_KEY_FILE!), cert: fs.readFileSync(cfg.TLS_CERT_FILE!) } } : {}),
  }) as unknown as FastifyInstance;

  const log = (m: string) => app.log.info(m);
  const db = new Db(cfg.paths.db);
  const bus = new Bus();
  bus.setMaxListeners(50);
  const audit = new AuditService(db);
  const keys = loadKeyRing({ masterKey: cfg.VAULT_MASTER_KEY, keyFile: cfg.VAULT_KEY_FILE, secretsDir: cfg.paths.secrets, isProd: cfg.isProd, log });
  const vault = new VaultService(db, keys);
  const auth = new AuthService(db, cfg, audit, vault);
  const guard = makeGuard(auth, cfg);
  const ai = new AiService(db, vault, cfg);

  // Los servicios se referencian entre sí mediante callbacks para evitar dependencias circulares.
  // Toda la política de alertas de infraestructura vive en IncidentManager; los servicios sólo informan estado.
  const alertSettings = new AlertSettingsStore(db);
  let incidents!: IncidentManager;
  const cameras: CameraService = new CameraService(db, vault, bus, {
    demo: cfg.DEMO_MODE,
    exportsDir: cfg.paths.exports,
    log,
    onTemplatesAdopted: (server, t, reason) => {
      // "detect" ya lo audita la ruta con el usuario que lo pidió.
      if (reason === "auto") audit.log({ username: "sistema", action: "exacq.template_auto", target: server.name, details: t });
    },
    onCamerasOffline: (src, cams) => incidents.onCamerasOffline(src, cams),
    onCamerasOnline: (cams) => incidents.onCamerasOnline(cams),
    onSourceDown: (src, affected, err, since) => incidents.onSourceDown(src, affected, err, since),
    onSourceUp: (src, still, downMs) => incidents.onSourceUp(src, still, downMs),
    onVmsDisabled: (cams) => incidents.onVmsDisabled(cams),
    availability: () => {
      const s = alertSettings.get();
      return {
        cameraMinSyncs: s.cameraOfflineMinSyncs,
        cameraAfterMs: s.cameraOfflineAfterSec * 1000,
        sourceMinSyncs: s.sourceDownMinSyncs,
        sourceAfterMs: s.sourceDownAfterSec * 1000,
      };
    },
  });
  const events = new EventService(db, bus, cfg.paths.snapshots, (id) => cameras.row(id)?.name, {
    cameraMuted: (id) => cameras.isMuted(id),
    flapThreshold: () => alertSettings.get().flapThreshold,
  });
  const notifier = new NotificationHub(bus, events, () => {
    const s = alertSettings.get();
    return { coalesceMs: s.notifyCoalesceMs, maxPerMinute: s.maxNotificationsPerMin, minSeverity: s.notifyMinSeverity };
  });
  events.setNotifier(notifier);

  const vpn = new VpnManager(db, vault, bus, cfg, {
    log,
    onUp: () => {
      incidents.onVpnUp();
      setTimeout(() => void cameras.sync().catch(() => undefined), 3000);
    },
    onDown: (s, unexpected) => incidents.onVpnDown(s, unexpected),
  });

  const health = new HealthService(db, bus, {
    demo: cfg.DEMO_MODE,
    dataDir: cfg.paths.data,
    onHostChange: (h, up) => incidents.onHostChange(h, up),
    onRound: (hosts) => incidents.reconcileHosts(hosts),
    rules: () => alertSettings.get(),
  });

  incidents = new IncidentManager({
    db,
    events,
    settings: () => alertSettings.get(),
    vpnStatus: () => vpn.status(),
    sourceHost: (id) => {
      const srv = cameras.servers().find((s) => s.id === id);
      try {
        return srv ? new URL(srv.base_url).hostname : undefined;
      } catch {
        return undefined;
      }
    },
  });

  const detection = new DetectionEngine(db, cameras, events, ai, {
    intervalMs: 2000,
    cooldownMs: cfg.DEMO_MODE ? 120_000 : 60_000,
    log,
    rules: () => alertSettings.get(),
  });
  const demoSim = cfg.DEMO_MODE ? new DemoSimulator(db, cameras, events) : null;

  const ctx: AppCtx = { cfg, db, bus, audit, vault, auth, guard, cameras, events, vpn, health, ai, detection, alertSettings, incidents, notifier, log };

  // ───────── Plugins de seguridad ─────────
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "blob:"],
        mediaSrc: ["'self'", "blob:"],
        connectSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'", "data:"],
        scriptSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: cfg.tls ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: cfg.tls ? { maxAge: 31536000, includeSubDomains: true } : false,
    referrerPolicy: { policy: "no-referrer" },
  });
  await app.register(rateLimit, { max: 900, timeWindow: "1 minute", allowList: (req) => req.url.startsWith("/assets/") });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  // JSON tolerante a cuerpo vacío (POST de acción sin parámetros).
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (body === "" || body === undefined) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new HttpError(400, "JSON inválido", "bad_json"), undefined);
    }
  });

  // CSRF: las solicitudes que modifican estado deben venir del propio frontend (cabecera personalizada + Origin).
  app.addHook("onRequest", async (req) => {
    if (!req.url.startsWith("/api/") || ["GET", "HEAD", "OPTIONS"].includes(req.method) || req.url.startsWith("/api/ingest/")) return;
    if (req.headers["x-requested-with"] !== "CamerasIA") throw new HttpError(403, "Solicitud rechazada (CSRF)", "csrf");
    const origin = req.headers.origin;
    if (origin) {
      const host = req.headers["x-forwarded-host"] && cfg.TRUST_PROXY ? String(req.headers["x-forwarded-host"]) : req.headers.host;
      let ok = false;
      try {
        ok = new URL(origin).host === host || cfg.allowedOrigins.includes(origin);
      } catch {
        ok = false;
      }
      if (!ok) throw new HttpError(403, "Origen no permitido", "csrf");
    }
  });

  app.addHook("onSend", async (req, reply) => {
    if (req.url.startsWith("/api/")) reply.header("Cache-Control", reply.getHeader("Cache-Control") ?? "no-store");
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: "validation", message: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
    }
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message, ...err.extra });
    if (err instanceof AuthError) return reply.status(err.status).send({ error: err.code, message: err.message });
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode === 429) return reply.status(429).send({ error: "rate_limited", message: "Demasiadas solicitudes, espere un momento" });
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: "request", message: e.message });
    req.log.error(err);
    return reply.status(500).send({ error: "internal", message: "Error interno" });
  });

  // ───────── Rutas ─────────
  registerAuthRoutes(app, ctx);
  registerUserRoutes(app, ctx);
  registerVaultRoutes(app, ctx);
  registerCameraRoutes(app, ctx);
  registerVpnRoutes(app, ctx);
  registerEventRoutes(app, ctx);
  registerAiRoutes(app, ctx);
  registerHealthRoutes(app, ctx);
  registerRealtime(app, ctx);
  app.get("/api/ping", async () => ({ ok: true, ts: Date.now() }));

  // ───────── Frontend (SPA) ─────────
  const webDist = cfg.WEB_DIST_DIR ?? path.resolve(here, "../../web/dist");
  const hasWeb = fs.existsSync(path.join(webDist, "index.html"));
  await app.register(fastifyStatic, { root: hasWeb ? webDist : cfg.paths.exports, serve: hasWeb, wildcard: false, index: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/") || !hasWeb || req.method !== "GET") return reply.status(404).send({ error: "not_found", message: "Recurso inexistente" });
    return reply.type("text/html").sendFile("index.html", webDist);
  });

  const startBackground = async () => {
    await auth.ensureInitialAdmin((m) => app.log.warn(m));
    if (cfg.DEMO_MODE) health.seedDemo();
    await cameras.start();
    demoSim?.seedHistory();
    demoSim?.start();
    health.start();
    detection.start();
    incidents.start();
    notifier.resumePending(db);
    await vpn.autoConnect();
  };

  const shutdown = async () => {
    detection.stop();
    incidents.stop();
    demoSim?.stop();
    health.stop();
    vpn.stop();
    cameras.stop();
    await app.close();
    db.close();
  };

  return { app, ctx, startBackground, shutdown };
}
