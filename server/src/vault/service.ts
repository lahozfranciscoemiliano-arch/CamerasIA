import crypto from "node:crypto";
import { z } from "zod";
import type { Db } from "../db/index.js";
import type { KeyRing } from "../security/crypto.js";

export const VAULT_KINDS = ["fortivpn", "exacq", "anthropic", "camera", "api", "generic"] as const;
export type VaultKind = (typeof VAULT_KINDS)[number];

export const SecretSchema = z.object({
  username: z.string().max(256).optional(),
  password: z.string().max(4096).optional(),
  token: z.string().max(8192).optional(),
  extra: z.record(z.string(), z.string().max(4096)).optional(),
});
export type VaultSecret = z.infer<typeof SecretSchema>;

interface VaultRow {
  id: string;
  name: string;
  kind: VaultKind;
  host: string | null;
  notes: string | null;
  payload_enc: string;
  key_version: number;
  created_by: number | null;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

function mask(s?: string) {
  if (!s) return null;
  if (s.length <= 2) return "•".repeat(s.length);
  return `${s[0]}${"•".repeat(Math.min(6, s.length - 2))}${s[s.length - 1]}`;
}

/**
 * Bóveda de credenciales cifrada (AES-256-GCM). Los secretos nunca salen hacia el navegador:
 * la API sólo expone metadatos enmascarados; el backend los descifra en memoria al momento de usarlos
 * (login a exacqVision, túnel FortiVPN, API de IA).
 */
export class VaultService {
  constructor(
    private db: Db,
    private keys: KeyRing,
  ) {}

  private aad(id: string) {
    return `vault:${id}`;
  }

  private toMeta(r: VaultRow) {
    const s = this.decrypt(r);
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      host: r.host,
      notes: r.notes,
      usernameMasked: mask(s.username),
      hasPassword: Boolean(s.password),
      hasToken: Boolean(s.token),
      extraKeys: Object.keys(s.extra ?? {}),
      keyVersion: r.key_version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastUsedAt: r.last_used_at,
    };
  }

  private decrypt(r: VaultRow): VaultSecret {
    return SecretSchema.parse(JSON.parse(this.keys.decryptString(r.payload_enc, this.aad(r.id))));
  }

  list() {
    return this.db.all<VaultRow>("SELECT * FROM vault_entries ORDER BY kind, name").map((r) => this.toMeta(r));
  }

  meta(id: string) {
    const r = this.db.get<VaultRow>("SELECT * FROM vault_entries WHERE id = $id", { id });
    return r ? this.toMeta(r) : undefined;
  }

  create(input: { name: string; kind: VaultKind; host?: string; notes?: string; secret: VaultSecret }, userId?: number) {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db.run(
      `INSERT INTO vault_entries(id, name, kind, host, notes, payload_enc, key_version, created_by, created_at, updated_at)
       VALUES($id, $name, $kind, $host, $notes, $payload, $kv, $by, $now, $now)`,
      {
        id,
        name: input.name,
        kind: input.kind,
        host: input.host,
        notes: input.notes,
        payload: this.keys.encrypt(JSON.stringify(SecretSchema.parse(input.secret)), this.aad(id)),
        kv: this.keys.currentVersion,
        by: userId,
        now,
      },
    );
    return id;
  }

  /** Actualiza metadatos y/o reemplaza sólo los campos de secreto provistos (los omitidos se conservan). */
  update(id: string, input: { name?: string; host?: string | null; notes?: string | null; secret?: VaultSecret }) {
    const r = this.db.get<VaultRow>("SELECT * FROM vault_entries WHERE id = $id", { id });
    if (!r) return false;
    let payload = r.payload_enc;
    if (input.secret) {
      const current = this.decrypt(r);
      const merged: VaultSecret = { ...current };
      for (const [k, v] of Object.entries(input.secret)) {
        if (v !== undefined) (merged as Record<string, unknown>)[k] = v === "" ? undefined : v;
      }
      payload = this.keys.encrypt(JSON.stringify(merged), this.aad(id));
    }
    this.db.run(
      `UPDATE vault_entries SET name = $name, host = $host, notes = $notes, payload_enc = $payload,
       key_version = $kv, updated_at = $now WHERE id = $id`,
      {
        id,
        name: input.name ?? r.name,
        host: input.host === undefined ? r.host : input.host,
        notes: input.notes === undefined ? r.notes : input.notes,
        payload,
        kv: this.keys.currentVersion,
        now: Date.now(),
      },
    );
    return true;
  }

  delete(id: string) {
    return this.db.run("DELETE FROM vault_entries WHERE id = $id", { id }).changes > 0;
  }

  /** Uso interno del backend. Nunca devolver este objeto en una respuesta HTTP salvo "revelar" auditado. */
  getSecret(id: string): VaultSecret | undefined {
    const r = this.db.get<VaultRow>("SELECT * FROM vault_entries WHERE id = $id", { id });
    if (!r) return undefined;
    this.db.run("UPDATE vault_entries SET last_used_at = $now WHERE id = $id", { id, now: Date.now() });
    return this.decrypt(r);
  }

  findFirstByKind(kind: VaultKind) {
    const r = this.db.get<VaultRow>("SELECT * FROM vault_entries WHERE kind = $kind ORDER BY updated_at DESC LIMIT 1", { kind });
    return r ? { id: r.id, secret: this.decrypt(r) } : undefined;
  }

  /** Cifrado genérico para otros módulos (p.ej. secreto TOTP de usuarios). */
  seal(value: string, aad: string) {
    return this.keys.encrypt(value, aad);
  }

  open(blob: string, aad: string) {
    return this.keys.decryptString(blob, aad);
  }
}
