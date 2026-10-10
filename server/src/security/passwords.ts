import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

// Parámetros recomendados por OWASP para scrypt (N=2^17, r=8, p=1).
const N = 2 ** 17;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 256 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password.normalize("NFKC"), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password.normalize("NFKC"), Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAXMEM,
  });
  return crypto.timingSafeEqual(actual, expected);
}

/** Hash ficticio para igualar tiempos cuando el usuario no existe (evita enumeración de usuarios). */
let dummyHash: Promise<string> | undefined;
export function getDummyHash() {
  dummyHash ??= hashPassword(crypto.randomBytes(16).toString("hex"));
  return dummyHash;
}

const COMMON = new Set([
  "password", "contraseña", "123456789012", "qwertyuiop12", "administrator", "admin1234567",
  "camaras12345", "seguridad123", "fortinet1234", "exacqvision1",
]);

/** Devuelve una lista de problemas; vacía si la contraseña cumple la política. */
export function checkPasswordPolicy(password: string, username?: string): string[] {
  const issues: string[] = [];
  if (password.length < 12) issues.push("Debe tener al menos 12 caracteres");
  if (password.length > 256) issues.push("Demasiado larga");
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) issues.push("Use al menos 3 de: minúsculas, mayúsculas, números, símbolos");
  if (username && password.toLowerCase().includes(username.toLowerCase())) issues.push("No puede contener el usuario");
  if (COMMON.has(password.toLowerCase())) issues.push("Contraseña demasiado común");
  return issues;
}
