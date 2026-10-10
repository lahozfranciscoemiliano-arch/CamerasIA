import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { Bus } from "../realtime/bus.js";
import type { VaultService } from "../vault/service.js";

export type VpnState = "disconnected" | "connecting" | "connected" | "disconnecting" | "error";

export interface VpnProfileRow {
  id: string;
  name: string;
  host: string;
  port: number;
  realm: string | null;
  trusted_certs: string;
  set_routes: number;
  set_dns: number;
  half_internet_routes: number;
  otp_required: number;
  credential_id: string | null;
  auto_connect: number;
  created_at: number;
  updated_at: number;
}

export interface VpnStatus {
  state: VpnState;
  mode: "openfortivpn" | "simulate" | "disabled";
  binaryAvailable: boolean;
  binaryVersion: string | null;
  profileId: string | null;
  profileName: string | null;
  gateway: string | null;
  since: number | null;
  assignedIp: string | null;
  iface: string | null;
  error: string | null;
  untrustedCertDigest: string | null;
  rxBytes: number;
  txBytes: number;
  connectedBy: string | null;
}

export const publicProfile = (p: VpnProfileRow) => ({
  id: p.id,
  name: p.name,
  host: p.host,
  port: p.port,
  realm: p.realm,
  trustedCerts: JSON.parse(p.trusted_certs) as string[],
  setRoutes: Boolean(p.set_routes),
  setDns: Boolean(p.set_dns),
  halfInternetRoutes: Boolean(p.half_internet_routes),
  otpRequired: Boolean(p.otp_required),
  credentialId: p.credential_id,
  autoConnect: Boolean(p.auto_connect),
  updatedAt: p.updated_at,
});

/** Construye el archivo de configuración de openfortivpn (la contraseña nunca va en la línea de comandos). */
export function buildOpenfortivpnConfig(p: VpnProfileRow, username: string, password: string, otp?: string) {
  const bad = /[\r\n]/;
  if (bad.test(username) || bad.test(password) || (otp && bad.test(otp))) throw new Error("Credenciales con saltos de línea no soportadas");
  const lines = [
    `host = ${p.host}`,
    `port = ${p.port}`,
    `username = ${username}`,
    `password = ${password}`,
    `set-routes = ${p.set_routes ? 1 : 0}`,
    `set-dns = ${p.set_dns ? 1 : 0}`,
    `pppd-use-peerdns = ${p.set_dns ? 1 : 0}`,
    `half-internet-routes = ${p.half_internet_routes ? 1 : 0}`,
  ];
  if (p.realm) lines.push(`realm = ${p.realm}`);
  for (const digest of JSON.parse(p.trusted_certs) as string[]) lines.push(`trusted-cert = ${digest}`);
  if (otp) lines.push(`otp = ${otp}`);
  return lines.join("\n") + "\n";
}

const MAX_LOG = 400;

/**
 * Administra el túnel SSL-VPN hacia el FortiGate usando openfortivpn (cliente open source compatible con FortiClient).
 * El túnel se levanta en el HOST donde corre este backend (no en el navegador), y así el servidor
 * alcanza las IPs internas (p.ej. 192.168.109.58) para hablar con exacqVision.
 */
export class VpnManager {
  private proc: ChildProcess | null = null;
  private configDir: string | null = null;
  private logBuf: Array<{ ts: number; line: string }> = [];
  private secretsToMask: string[] = [];
  private statsTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private simTimers: NodeJS.Timeout[] = [];
  private manualStop = false;
  private reconnectAttempts = 0;
  private st: VpnStatus;

  constructor(
    private db: Db,
    private vault: VaultService,
    private bus: Bus,
    private cfg: AppConfig,
    private hooks: {
      onUp?: (s: VpnStatus) => void;
      onDown?: (s: VpnStatus, unexpected: boolean) => void;
      log?: (m: string) => void;
    } = {},
  ) {
    const probe = this.probeBinary();
    const mode: VpnStatus["mode"] =
      cfg.VPN_MODE === "disabled" ? "disabled" : cfg.VPN_MODE === "simulate" ? "simulate" : probe.available ? "openfortivpn" : cfg.VPN_MODE === "openfortivpn" ? "openfortivpn" : "simulate";
    this.st = {
      state: "disconnected",
      mode,
      binaryAvailable: probe.available,
      binaryVersion: probe.version,
      profileId: null,
      profileName: null,
      gateway: null,
      since: null,
      assignedIp: null,
      iface: null,
      error: null,
      untrustedCertDigest: null,
      rxBytes: 0,
      txBytes: 0,
      connectedBy: null,
    };
  }

  private probeBinary() {
    try {
      const r = spawnSync(this.cfg.OPENFORTIVPN_BIN, ["--version"], { timeout: 3000, encoding: "utf8" });
      if (r.error) return { available: false, version: null };
      return { available: true, version: (r.stdout || r.stderr || "").trim().split("\n")[0] ?? null };
    } catch {
      return { available: false, version: null };
    }
  }

  status(): VpnStatus {
    return { ...this.st };
  }

  logs() {
    return [...this.logBuf];
  }

  profiles() {
    return this.db.all<VpnProfileRow>("SELECT * FROM vpn_profiles ORDER BY name");
  }

  profile(id: string) {
    return this.db.get<VpnProfileRow>("SELECT * FROM vpn_profiles WHERE id = $id", { id });
  }

  private set(patch: Partial<VpnStatus>) {
    Object.assign(this.st, patch);
    this.bus.publish("vpn.status", this.status());
  }

  private log(line: string) {
    let clean = line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
    for (const s of this.secretsToMask) if (s) clean = clean.split(s).join("••••••");
    if (!clean) return;
    const entry = { ts: Date.now(), line: clean };
    this.logBuf.push(entry);
    if (this.logBuf.length > MAX_LOG) this.logBuf.splice(0, this.logBuf.length - MAX_LOG);
    this.bus.publish("vpn.log", entry);
  }

  async autoConnect() {
    const p = this.db.get<VpnProfileRow>("SELECT * FROM vpn_profiles WHERE auto_connect = 1 AND otp_required = 0 LIMIT 1");
    if (p && this.st.mode !== "disabled") {
      this.hooks.log?.(`VPN: conexión automática con perfil "${p.name}"`);
      await this.connect(p.id, undefined, "sistema").catch((e) => this.hooks.log?.(`VPN auto-connect: ${(e as Error).message}`));
    }
  }

  async connect(profileId: string, otp: string | undefined, by: string) {
    if (this.st.mode === "disabled") throw new Error("La VPN está deshabilitada en este servidor (VPN_MODE=disabled)");
    if (this.st.state === "connecting" || this.st.state === "connected") throw new Error("Ya hay un túnel activo o en curso");
    const p = this.profile(profileId);
    if (!p) throw new Error("Perfil VPN inexistente");
    if (p.otp_required && !otp) throw new Error("Este perfil requiere el código OTP de FortiToken");
    if (otp && !/^\d{4,10}$/.test(otp)) throw new Error("OTP inválido");
    if (!p.credential_id) throw new Error("El perfil no tiene credenciales asignadas en la bóveda");
    const secret = this.vault.getSecret(p.credential_id);
    if (!secret?.username || !secret.password) throw new Error("La credencial del perfil está incompleta (usuario/contraseña)");

    this.manualStop = false;
    clearTimeout(this.reconnectTimer);
    this.secretsToMask = [secret.password, otp ?? ""];
    this.set({
      state: "connecting",
      profileId: p.id,
      profileName: p.name,
      gateway: `${p.host}:${p.port}`,
      error: null,
      untrustedCertDigest: null,
      assignedIp: null,
      iface: null,
      since: Date.now(),
      connectedBy: by,
      rxBytes: 0,
      txBytes: 0,
    });
    this.log(`» Conectando a ${p.host}:${p.port} con usuario ${secret.username} (${this.st.mode})`);

    if (this.st.mode === "simulate") return this.simulateConnect(p, secret.password, otp);

    this.configDir = fs.mkdtempSync(path.join(os.tmpdir(), "cia-vpn-"));
    fs.chmodSync(this.configDir, 0o700);
    const configFile = path.join(this.configDir, "config");
    fs.writeFileSync(configFile, buildOpenfortivpnConfig(p, secret.username, secret.password, otp), { mode: 0o600 });

    const [cmd, args] = this.cfg.VPN_USE_SUDO
      ? ["sudo", ["-n", this.cfg.OPENFORTIVPN_BIN, "-c", configFile]]
      : [this.cfg.OPENFORTIVPN_BIN, ["-c", configFile]];
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    const wipe = () => this.wipeConfig();
    setTimeout(wipe, 5000).unref();

    const onData = (chunk: Buffer) => {
      wipe();
      for (const line of chunk.toString("utf8").split(/\r?\n/)) this.parseLine(line);
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", onData);
    proc.on("error", (err) => {
      this.log(`ERROR: no se pudo ejecutar ${cmd}: ${err.message}`);
      this.set({ state: "error", error: `No se pudo ejecutar openfortivpn: ${err.message}` });
    });
    proc.on("exit", (code, signal) => this.onExit(code, signal));
  }

  private parseLine(line: string) {
    if (!line.trim()) return;
    this.log(line);
    const ip = line.match(/Got addresses: \[([^\]]+)\]/);
    if (ip) this.set({ assignedIp: ip[1]!.trim() });
    const iface = line.match(/Interface (\S+) is UP/);
    if (iface) this.set({ iface: iface[1]! });
    const digest = line.match(/trusted-cert[ =]+([0-9a-f]{64})/i);
    if (digest) this.set({ untrustedCertDigest: digest[1]!.toLowerCase(), error: "Certificado del FortiGate no confiable: verifique la huella y agréguela al perfil" });
    if (/Tunnel is up and running/i.test(line)) {
      this.reconnectAttempts = 0;
      this.set({ state: "connected", since: Date.now(), error: null });
      this.startStats();
      this.hooks.onUp?.(this.status());
    }
    if (/Could not authenticate|authentication failed|invalid credentials|login failed/i.test(line)) {
      this.set({ error: "Autenticación rechazada por el FortiGate (usuario, contraseña u OTP)" });
    }
    if (/connect: (Connection refused|Network is unreachable|No route to host)|Could not resolve|timed out/i.test(line)) {
      this.set({ error: "No se pudo contactar al gateway FortiGate (host/puerto o salida a Internet)" });
    }
    if (/Permission denied|Operation not permitted|must be run as root/i.test(line)) {
      this.set({ error: "Permisos insuficientes: openfortivpn requiere root/NET_ADMIN (ver docs/FORTIVPN.md)" });
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null) {
    this.wipeConfig();
    clearInterval(this.statsTimer);
    const wasUp = this.st.state === "connected";
    const unexpected = !this.manualStop;
    this.proc = null;
    this.log(`» openfortivpn finalizó (code=${code ?? "-"} signal=${signal ?? "-"})`);
    this.set({
      state: unexpected && !wasUp ? "error" : "disconnected",
      error: unexpected ? (this.st.error ?? (wasUp ? "El túnel se cayó" : "No se pudo establecer el túnel")) : null,
      assignedIp: null,
      iface: null,
    });
    if (wasUp) this.hooks.onDown?.(this.status(), unexpected);
    if (wasUp && unexpected) this.scheduleReconnect();
  }

  private scheduleReconnect() {
    const p = this.st.profileId ? this.profile(this.st.profileId) : undefined;
    if (!p || !p.auto_connect || p.otp_required) return;
    const delay = Math.min(300_000, 5000 * 2 ** this.reconnectAttempts++);
    this.log(`» Reintento automático en ${Math.round(delay / 1000)} s`);
    this.reconnectTimer = setTimeout(() => void this.connect(p.id, undefined, "auto-reconexión").catch((e) => this.log(`ERROR: ${(e as Error).message}`)), delay);
  }

  private wipeConfig() {
    if (!this.configDir) return;
    try {
      const f = path.join(this.configDir, "config");
      if (fs.existsSync(f)) {
        const size = fs.statSync(f).size;
        fs.writeFileSync(f, Buffer.alloc(size, 0));
      }
      fs.rmSync(this.configDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    this.configDir = null;
  }

  private startStats() {
    clearInterval(this.statsTimer);
    this.statsTimer = setInterval(() => {
      if (this.st.mode === "simulate") {
        this.st.rxBytes += Math.round(80_000 + Math.random() * 900_000);
        this.st.txBytes += Math.round(10_000 + Math.random() * 120_000);
      } else if (this.st.iface) {
        try {
          const base = `/sys/class/net/${this.st.iface}/statistics`;
          this.st.rxBytes = Number(fs.readFileSync(`${base}/rx_bytes`, "utf8"));
          this.st.txBytes = Number(fs.readFileSync(`${base}/tx_bytes`, "utf8"));
        } catch {
          /* interfaz no disponible */
        }
      }
      this.bus.publish("vpn.status", this.status());
    }, 3000);
    this.statsTimer.unref();
  }

  async disconnect(by: string) {
    this.manualStop = true;
    clearTimeout(this.reconnectTimer);
    if (this.st.mode === "simulate") {
      this.simTimers.forEach(clearTimeout);
      const wasUp = this.st.state === "connected";
      this.log(`» Túnel cerrado por ${by}`);
      clearInterval(this.statsTimer);
      this.set({ state: "disconnected", assignedIp: null, iface: null, error: null });
      if (wasUp) this.hooks.onDown?.(this.status(), false);
      return;
    }
    if (!this.proc) {
      this.set({ state: "disconnected", error: null });
      return;
    }
    this.set({ state: "disconnecting" });
    this.log(`» Cerrando túnel (solicitado por ${by})`);
    this.proc.kill("SIGTERM");
    const p = this.proc;
    setTimeout(() => p.exitCode === null && p.kill("SIGKILL"), 8000).unref();
  }

  private simulateConnect(p: VpnProfileRow, password: string, otp?: string) {
    const steps: Array<[number, () => void]> = [
      [600, () => this.log(`INFO:   Connected to gateway.`)],
      [
        1400,
        () => {
          if (password.length < 3) {
            this.log("ERROR:  Could not authenticate to gateway. Please check the password, client certificate, etc.");
            this.set({ state: "error", error: "Autenticación rechazada (simulado)" });
            this.simTimers.forEach(clearTimeout);
            return;
          }
          this.log(otp ? "INFO:   Authenticated (OTP ok)." : "INFO:   Authenticated.");
        },
      ],
      [1900, () => this.log("INFO:   Remote gateway has allocated a VPN.")],
      [2400, () => this.parseLine(`INFO:   Got addresses: [10.212.134.${10 + Math.floor(Math.random() * 200)}], ns [192.168.109.1]`)],
      [2800, () => this.parseLine("INFO:   Interface ppp0 is UP.")],
      [3100, () => this.log(`INFO:   Adding VPN nameservers... (set-dns=${p.set_dns})`)],
      [3400, () => this.parseLine("INFO:   Tunnel is up and running.")],
    ];
    this.simTimers = steps.map(([ms, fn]) => setTimeout(() => this.st.state === "connecting" && fn(), ms));
  }

  stop() {
    this.manualStop = true;
    this.simTimers.forEach(clearTimeout);
    clearTimeout(this.reconnectTimer);
    clearInterval(this.statsTimer);
    this.proc?.kill("SIGTERM");
    this.wipeConfig();
  }
}
