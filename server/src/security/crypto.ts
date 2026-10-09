import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Cifrado autenticado AES-256-GCM para la bóveda de credenciales.
 * Formato serializado: v<keyVersion>.<iv b64>.<tag b64>.<ciphertext b64>
 * Se usa AAD (datos adicionales autenticados) para atar cada blob a su registro,
 * de modo que no se pueda copiar un secreto cifrado de una fila a otra.
 */
export class KeyRing {
  private keys = new Map<number, Buffer>();
  readonly currentVersion: number;

  constructor(keys: Record<number, Buffer>, currentVersion: number) {
    for (const [v, k] of Object.entries(keys)) {
      if (k.length !== 32) throw new Error(`La clave de bóveda v${v} debe tener 32 bytes`);
      this.keys.set(Number(v), k);
    }
    if (!this.keys.has(currentVersion)) throw new Error("Versión de clave actual inexistente");
    this.currentVersion = currentVersion;
  }

  encrypt(plaintext: string | Buffer, aad: string): string {
    const key = this.keys.get(this.currentVersion)!;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v${this.currentVersion}.${iv.toString("base64")}.${tag.toString("base64")}.${ct.toString("base64")}`;
  }

  decrypt(blob: string, aad: string): Buffer {
    const parts = blob.split(".");
    if (parts.length !== 4 || !parts[0]!.startsWith("v")) throw new Error("Formato de secreto cifrado inválido");
    const version = Number(parts[0]!.slice(1));
    const key = this.keys.get(version);
    if (!key) throw new Error(`Clave de bóveda v${version} no disponible`);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(parts[1]!, "base64"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(parts[2]!, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(parts[3]!, "base64")), decipher.final()]);
  }

  decryptString(blob: string, aad: string): string {
    return this.decrypt(blob, aad).toString("utf8");
  }
}

function parseKey(material: string): Buffer {
  const trimmed = material.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  const b = Buffer.from(trimmed, "base64");
  if (b.length === 32) return b;
  throw new Error("VAULT_MASTER_KEY debe ser 32 bytes en base64 o 64 caracteres hex (openssl rand -base64 32)");
}

/**
 * Obtiene la clave maestra: VAULT_MASTER_KEY (env) > VAULT_KEY_FILE > archivo autogenerado en data/secrets.
 * El autogenerado sólo se permite fuera de producción; en producción la clave debe venir del entorno
 * (o de un secreto de Docker montado como archivo) para que no viva junto a la base de datos.
 */
export function loadKeyRing(opts: {
  masterKey?: string;
  keyFile?: string;
  secretsDir: string;
  isProd: boolean;
  log: (msg: string) => void;
}): KeyRing {
  if (opts.masterKey) return new KeyRing({ 1: parseKey(opts.masterKey) }, 1);
  if (opts.keyFile) return new KeyRing({ 1: parseKey(fs.readFileSync(opts.keyFile, "utf8")) }, 1);

  const file = path.join(opts.secretsDir, "vault.key");
  if (fs.existsSync(file)) return new KeyRing({ 1: parseKey(fs.readFileSync(file, "utf8")) }, 1);
  if (opts.isProd) {
    throw new Error("En producción defina VAULT_MASTER_KEY o VAULT_KEY_FILE (openssl rand -base64 32)");
  }
  fs.mkdirSync(opts.secretsDir, { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key.toString("base64"), { mode: 0o600 });
  opts.log(`⚠  Clave de bóveda generada en ${file}. En producción use VAULT_MASTER_KEY fuera del disco de datos.`);
  return new KeyRing({ 1: key }, 1);
}

export const sha256 = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
