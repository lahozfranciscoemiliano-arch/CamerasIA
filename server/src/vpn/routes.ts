import crypto from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { AppCtx } from "../context.js";
import { HttpError, clientIp } from "../http/guards.js";
import { publicProfile } from "./manager.js";

const Digest = z.string().regex(/^[0-9a-fA-F]{64}$/, "Huella SHA-256 inválida (64 caracteres hex)").transform((s) => s.toLowerCase());
const ProfileBody = z.object({
  name: z.string().min(1).max(80),
  host: z.string().min(1).max(255).regex(/^[a-zA-Z0-9.-]+$/, "Host inválido"),
  port: z.number().int().min(1).max(65535).default(443),
  realm: z.string().max(80).nullable().optional(),
  trustedCerts: z.array(Digest).max(10).default([]),
  setRoutes: z.boolean().default(true),
  setDns: z.boolean().default(false),
  halfInternetRoutes: z.boolean().default(false),
  otpRequired: z.boolean().default(false),
  credentialId: z.string().uuid().nullable().optional(),
  autoConnect: z.boolean().default(false),
});
const ConnectBody = z.object({ profileId: z.string().min(1), otp: z.string().max(12).optional() });

export function registerVpnRoutes(app: FastifyInstance, ctx: AppCtx) {
  const { guard, vpn, db, audit } = ctx;

  app.get("/api/vpn/status", async (req) => {
    guard(req);
    return vpn.status();
  });

  app.get("/api/vpn/logs", async (req) => {
    guard(req, { role: "operator" });
    return vpn.logs();
  });

  app.get("/api/vpn/profiles", async (req) => {
    guard(req, { role: "operator" });
    return vpn.profiles().map(publicProfile);
  });

  app.post("/api/vpn/connect", { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async (req) => {
    const a = guard(req, { role: "operator" });
    const body = ConnectBody.parse(req.body);
    try {
      await vpn.connect(body.profileId, body.otp || undefined, a.user.username);
      audit.log({ userId: a.user.id, username: a.user.username, action: "vpn.connect", target: body.profileId, ip: clientIp(req), details: { otp: Boolean(body.otp) } });
    } catch (e) {
      audit.log({ userId: a.user.id, username: a.user.username, action: "vpn.connect", target: body.profileId, ip: clientIp(req), outcome: "failure", details: { error: (e as Error).message } });
      throw new HttpError(400, (e as Error).message, "vpn_error");
    }
    return vpn.status();
  });

  app.post("/api/vpn/disconnect", async (req) => {
    const a = guard(req, { role: "operator" });
    await vpn.disconnect(a.user.username);
    audit.log({ userId: a.user.id, username: a.user.username, action: "vpn.disconnect", ip: clientIp(req) });
    return vpn.status();
  });

  app.post("/api/vpn/profiles", async (req) => {
    const a = guard(req, { role: "admin", stepUp: true });
    const b = ProfileBody.parse(req.body);
    const id = crypto.randomUUID();
    const now = Date.now();
    db.run(
      `INSERT INTO vpn_profiles(id, name, host, port, realm, trusted_certs, set_routes, set_dns, half_internet_routes, otp_required, credential_id, auto_connect, created_at, updated_at)
       VALUES($id, $name, $host, $port, $realm, $certs, $routes, $dns, $half, $otp, $cred, $auto, $now, $now)`,
      {
        id,
        name: b.name,
        host: b.host,
        port: b.port,
        realm: b.realm,
        certs: JSON.stringify(b.trustedCerts),
        routes: b.setRoutes,
        dns: b.setDns,
        half: b.halfInternetRoutes,
        otp: b.otpRequired,
        cred: b.credentialId,
        auto: b.autoConnect,
        now,
      },
    );
    audit.log({ userId: a.user.id, username: a.user.username, action: "vpn.profile_create", target: b.name, ip: clientIp(req), details: { host: b.host, port: b.port } });
    return publicProfile(vpn.profile(id)!);
  });

  app.patch<{ Params: { id: string } }>("/api/vpn/profiles/:id", async (req) => {
    const a = guard(req, { role: "admin", stepUp: true });
    const cur = vpn.profile(req.params.id);
    if (!cur) throw new HttpError(404, "Perfil inexistente", "not_found");
    const b = ProfileBody.partial().parse(req.body);
    const merged = { ...publicProfile(cur), ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
    db.run(
      `UPDATE vpn_profiles SET name = $name, host = $host, port = $port, realm = $realm, trusted_certs = $certs, set_routes = $routes,
       set_dns = $dns, half_internet_routes = $half, otp_required = $otp, credential_id = $cred, auto_connect = $auto, updated_at = $now WHERE id = $id`,
      {
        id: cur.id,
        name: merged.name,
        host: merged.host,
        port: merged.port,
        realm: merged.realm,
        certs: JSON.stringify(merged.trustedCerts),
        routes: merged.setRoutes,
        dns: merged.setDns,
        half: merged.halfInternetRoutes,
        otp: merged.otpRequired,
        cred: merged.credentialId,
        auto: merged.autoConnect,
        now: Date.now(),
      },
    );
    audit.log({ userId: a.user.id, username: a.user.username, action: "vpn.profile_update", target: cur.name, ip: clientIp(req), details: b });
    return publicProfile(vpn.profile(cur.id)!);
  });

  /** Confía en la huella del certificado que reportó el FortiGate en el último intento (TOFU explícito y auditado). */
  app.post<{ Params: { id: string } }>("/api/vpn/profiles/:id/trust-cert", async (req) => {
    const a = guard(req, { role: "admin", stepUp: true });
    const cur = vpn.profile(req.params.id);
    if (!cur) throw new HttpError(404, "Perfil inexistente", "not_found");
    const digest = Digest.parse((req.body as { digest?: string })?.digest ?? vpn.status().untrustedCertDigest);
    const certs = new Set<string>(JSON.parse(cur.trusted_certs));
    certs.add(digest);
    db.run("UPDATE vpn_profiles SET trusted_certs = $c, updated_at = $now WHERE id = $id", { c: JSON.stringify([...certs]), now: Date.now(), id: cur.id });
    audit.log({ userId: a.user.id, username: a.user.username, action: "vpn.trust_cert", target: cur.name, ip: clientIp(req), details: { digest } });
    return publicProfile(vpn.profile(cur.id)!);
  });

  app.delete<{ Params: { id: string } }>("/api/vpn/profiles/:id", async (req) => {
    const a = guard(req, { role: "admin", stepUp: true });
    const cur = vpn.profile(req.params.id);
    if (!cur) throw new HttpError(404, "Perfil inexistente", "not_found");
    if (vpn.status().profileId === cur.id && vpn.status().state !== "disconnected") throw new HttpError(409, "Desconecte el túnel antes de eliminar el perfil");
    db.run("DELETE FROM vpn_profiles WHERE id = $id", { id: cur.id });
    audit.log({ userId: a.user.id, username: a.user.username, action: "vpn.profile_delete", target: cur.name, ip: clientIp(req) });
    return { ok: true };
  });
}
