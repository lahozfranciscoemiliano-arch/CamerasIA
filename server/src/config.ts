import path from "node:path";
import { z } from "zod";

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number.parseInt(v, 10)))
    .pipe(z.number().int());

const EnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: int(8443),
  DATA_DIR: z.string().default(path.resolve(process.cwd(), "data")),
  WEB_DIST_DIR: z.string().optional(),

  // TLS (recomendado). Si no se definen, el servidor escucha HTTP (usar detrás de un proxy TLS).
  TLS_CERT_FILE: z.string().optional(),
  TLS_KEY_FILE: z.string().optional(),
  TRUST_PROXY: bool(false),
  COOKIE_SECURE: z.enum(["auto", "true", "false"]).default("auto"),
  ALLOWED_ORIGINS: z.string().optional(),

  // Sesiones
  SESSION_IDLE_MINUTES: int(30),
  SESSION_MAX_HOURS: int(12),
  REQUIRE_2FA: bool(true),
  LOGIN_MAX_ATTEMPTS: int(5),
  LOGIN_LOCK_MINUTES: int(15),
  STEP_UP_MINUTES: int(5),

  // Bóveda de credenciales
  VAULT_MASTER_KEY: z.string().optional(),
  VAULT_KEY_FILE: z.string().optional(),
  VAULT_ALLOW_REVEAL: bool(false),

  // Admin inicial
  ADMIN_USERNAME: z.string().default("admin"),
  ADMIN_INITIAL_PASSWORD: z.string().optional(),

  // Modo demo (cámaras y eventos simulados)
  DEMO_MODE: bool(true),

  // FortiVPN
  VPN_MODE: z.enum(["auto", "openfortivpn", "simulate", "disabled"]).default("auto"),
  OPENFORTIVPN_BIN: z.string().default("openfortivpn"),
  VPN_USE_SUDO: bool(false),

  // IA (Claude)
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default("claude-opus-5-5"),
  AI_MAX_ANALYSES_PER_HOUR: int(120),

  // Ingesta de detecciones externas (Frigate, CodeProject.AI, scripts propios)
  INGEST_ENABLED: bool(true),

  LOG_LEVEL: z.string().default("info"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Configuración inválida:\n${issues}`);
  }
  const c = parsed.data;
  const isProd = c.NODE_ENV === "production";
  const tls = Boolean(c.TLS_CERT_FILE && c.TLS_KEY_FILE);
  return {
    ...c,
    isProd,
    tls,
    cookieSecure: c.COOKIE_SECURE === "auto" ? tls || c.TRUST_PROXY || isProd : c.COOKIE_SECURE === "true",
    allowedOrigins: (c.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    paths: {
      data: c.DATA_DIR,
      db: path.join(c.DATA_DIR, "camerasia.db"),
      snapshots: path.join(c.DATA_DIR, "snapshots"),
      exports: path.join(c.DATA_DIR, "exports"),
      secrets: path.join(c.DATA_DIR, "secrets"),
    },
  };
}
