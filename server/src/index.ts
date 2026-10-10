import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";

const cfg = loadConfig();
const { app, startBackground, shutdown } = await buildApp(cfg);

await app.listen({ host: cfg.HOST, port: cfg.PORT });
app.log.info(`CamerasIA SOC escuchando en ${cfg.tls ? "https" : "http"}://${cfg.HOST}:${cfg.PORT}  (demo=${cfg.DEMO_MODE})`);
if (!cfg.tls && !cfg.TRUST_PROXY) app.log.warn("⚠  Sin TLS: use HTTPS (TLS_CERT_FILE/TLS_KEY_FILE) o un proxy inverso con TLS antes de exponerlo.");
await startBackground();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    app.log.info(`Recibido ${sig}, cerrando...`);
    void shutdown().finally(() => process.exit(0));
  });
}
