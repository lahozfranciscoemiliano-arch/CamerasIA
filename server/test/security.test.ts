import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { base32Decode, base32Encode, hotp, generateRecoveryCodes, normalizeRecoveryCode, totp, verifyTotp, currentStep } from "../src/security/totp.js";
import { checkPasswordPolicy, hashPassword, verifyPassword } from "../src/security/passwords.js";
import { KeyRing } from "../src/security/crypto.js";

test("base32 ida y vuelta", () => {
  const buf = crypto.randomBytes(20);
  assert.deepEqual(base32Decode(base32Encode(buf)), buf);
  assert.equal(base32Encode(Buffer.from("12345678901234567890")), "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
});

test("TOTP cumple los vectores del RFC 6238 (SHA1, 6 dígitos)", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  // RFC 6238 Apéndice B (8 dígitos) → últimos 6 dígitos
  assert.equal(totp(secret, 59 * 1000), "287082");
  assert.equal(totp(secret, 1111111109 * 1000), "081804");
  assert.equal(totp(secret, 1234567890 * 1000), "005924");
  assert.equal(totp(secret, 2000000000 * 1000), "279037");
  // RFC 4226 HOTP
  assert.equal(hotp(Buffer.from("12345678901234567890"), 0), "755224");
});

test("verifyTotp acepta ±1 ventana y rechaza reutilización (anti-replay)", () => {
  const secret = base32Encode(crypto.randomBytes(20));
  const now = Date.now();
  const code = totp(secret, now);
  const step = verifyTotp(secret, code, 0, now);
  assert.equal(step, currentStep(now));
  assert.equal(verifyTotp(secret, code, step!, now), null, "el mismo paso no puede reutilizarse");
  assert.equal(verifyTotp(secret, totp(secret, now - 30_000), 0, now), currentStep(now) - 1);
  assert.equal(verifyTotp(secret, totp(secret, now - 120_000), 0, now), null);
  assert.equal(verifyTotp(secret, "abc123", 0, now), null);
});

test("códigos de recuperación", () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const c of codes) assert.match(c, /^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  assert.equal(normalizeRecoveryCode("abcd-efgh-ijkl"), "ABCDEFGHIJKL");
});

test("hash de contraseñas scrypt", async () => {
  const h = await hashPassword("Un4-Clave_Segura!");
  assert.match(h, /^scrypt\$131072\$8\$1\$/);
  assert.equal(await verifyPassword("Un4-Clave_Segura!", h), true);
  assert.equal(await verifyPassword("otra", h), false);
  assert.notEqual(await hashPassword("Un4-Clave_Segura!"), h, "sal aleatoria");
});

test("política de contraseñas", () => {
  assert.ok(checkPasswordPolicy("corta").length > 0);
  assert.ok(checkPasswordPolicy("todasminusculas").length > 0);
  assert.ok(checkPasswordPolicy("Operador-2026!x", "operador").length > 0, "no puede contener el usuario");
  assert.deepEqual(checkPasswordPolicy("Monitoreo-2026!x", "jperez"), []);
});

test("KeyRing AES-256-GCM: cifra, descifra y detecta manipulación", () => {
  const ring = new KeyRing({ 1: crypto.randomBytes(32) }, 1);
  const blob = ring.encrypt("secreto-fortivpn", "vault:abc");
  assert.match(blob, /^v1\./);
  assert.equal(ring.decryptString(blob, "vault:abc"), "secreto-fortivpn");
  assert.throws(() => ring.decrypt(blob, "vault:otro"), "AAD distinto debe fallar");
  const parts = blob.split(".");
  const ct = Buffer.from(parts[3]!, "base64");
  ct[0] = ct[0]! ^ 0xff;
  assert.throws(() => ring.decrypt([parts[0], parts[1], parts[2], ct.toString("base64")].join("."), "vault:abc"));
  const other = new KeyRing({ 1: crypto.randomBytes(32) }, 1);
  assert.throws(() => other.decrypt(blob, "vault:abc"), "otra clave no descifra");
});
