/**
 * Per-persona encrypted secrets vault.
 *
 * Replaces the plaintext `~/.env` / `~/.config/phantombot/.env` credential
 * store with an at-rest-encrypted, per-persona SQLite database. Each persona
 * owns its own `<personaDir>/vault.sqlite` — self-contained and portable, the
 * same design principle as phantomchat.json and identity.json: copy a persona
 * folder to another box and its secrets travel with it (still encrypted; only
 * that persona's nsec can decrypt them).
 *
 * Crypto:
 *   - The AES key is DERIVED from the persona's nsec secret bytes via
 *     HKDF-SHA256 with the domain-separation label "phantombot-vault-v1".
 *     The raw nsec is NEVER used directly as the key — HKDF isolates the vault
 *     key from any other use of the same secret (e.g. Nostr ECDH), so a bug in
 *     one can't compromise the other.
 *   - Each entry is encrypted with AES-256-GCM under a fresh random 12-byte
 *     nonce. Nonce + ciphertext (which includes the GCM auth tag) are stored
 *     per row. Wrong key → GCM auth failure → decrypt throws (never silent).
 *
 * API mirrors `phantombot env` 1:1: set / get / list (names only) / unset.
 * Values only ever exist decrypted in-process.
 */

import { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { getOrCreatePersonaIdentity } from "./personaIdentity.ts";

/** Filename of the per-persona encrypted secrets DB inside a persona dir. */
export const VAULT_FILE = "vault.sqlite";

/**
 * HKDF domain-separation label. Versioned so a future key-schedule change can
 * coexist / migrate. Bump the suffix only alongside a migration path.
 */
const VAULT_HKDF_INFO = "phantombot-vault-v1";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS secrets (
  name        TEXT PRIMARY KEY,
  nonce       BLOB NOT NULL,
  ciphertext  BLOB NOT NULL,
  updated_at  TEXT NOT NULL
);
`;

/** Path to a persona's vault DB given its dir. */
export function vaultPath(personaDir: string): string {
  return join(personaDir, VAULT_FILE);
}

/**
 * Derive the 32-byte AES-256 vault key from the persona's nsec secret bytes.
 * HKDF-SHA256, no salt, info = the versioned domain label. Deterministic: the
 * same secret always yields the same key (so a reopened vault decrypts), and a
 * DIFFERENT secret yields a different key (so another persona can't decrypt).
 */
export function deriveVaultKey(secretKey: Uint8Array): Uint8Array {
  const info = new TextEncoder().encode(VAULT_HKDF_INFO);
  return hkdf(sha256, secretKey, undefined, info, 32);
}

/** An open, key-loaded vault for one persona. */
export interface Vault {
  /** Encrypt + store (or replace) NAME=value. Idempotent per name. */
  set(name: string, value: string): void;
  /** Decrypt + return the value for NAME, or undefined if absent. */
  get(name: string): string | undefined;
  /** All stored secret NAMES (values never returned), sorted. */
  list(): string[];
  /** Remove NAME. No-op if absent. */
  unset(name: string): void;
  /** Close the underlying SQLite connection. Idempotent. */
  close(): void;
}

class SqliteVault implements Vault {
  private setStmt;
  private getStmt;
  private listStmt;
  private unsetStmt;
  private closed = false;

  constructor(
    private db: Database,
    private aesKeyRaw: Uint8Array,
  ) {
    db.exec(SCHEMA);
    this.setStmt = db.prepare(
      "INSERT INTO secrets (name, nonce, ciphertext, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(name) DO UPDATE SET nonce = excluded.nonce, " +
        "ciphertext = excluded.ciphertext, updated_at = excluded.updated_at",
    );
    this.getStmt = db.prepare(
      "SELECT nonce, ciphertext FROM secrets WHERE name = ?",
    );
    this.listStmt = db.prepare("SELECT name FROM secrets ORDER BY name ASC");
    this.unsetStmt = db.prepare("DELETE FROM secrets WHERE name = ?");
  }

  set(name: string, value: string): void {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(value);
    const ciphertext = encryptGcmSync(this.aesKeyRaw, nonce, plaintext);
    this.setStmt.run(
      name,
      Buffer.from(nonce),
      Buffer.from(ciphertext),
      new Date().toISOString(),
    );
  }

  get(name: string): string | undefined {
    const row = this.getStmt.get(name) as
      | { nonce: Uint8Array; ciphertext: Uint8Array }
      | null;
    if (!row) return undefined;
    const nonce = new Uint8Array(row.nonce);
    const ciphertext = new Uint8Array(row.ciphertext);
    const plain = decryptGcmSync(this.aesKeyRaw, nonce, ciphertext);
    return new TextDecoder().decode(plain);
  }

  list(): string[] {
    return (this.listStmt.all() as Array<{ name: string }>).map((r) => r.name);
  }

  unset(name: string): void {
    this.unsetStmt.run(name);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

// AES-256-GCM via node:crypto (synchronous), matching the byte layout the
// codebase's crypto uses elsewhere (12-byte nonce, GCM 16-byte tag appended to
// the ciphertext so decrypt can split it off). node:crypto gives us a
// synchronous cipher so the vault API stays synchronous like bun:sqlite.
function encryptGcmSync(
  keyRaw: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  const cipher = createCipheriv("aes-256-gcm", keyRaw, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Store ciphertext||tag so one BLOB round-trips the whole thing.
  return new Uint8Array(Buffer.concat([body, tag]));
}

function decryptGcmSync(
  keyRaw: Uint8Array,
  nonce: Uint8Array,
  ciphertextWithTag: Uint8Array,
): Uint8Array {
  if (ciphertextWithTag.length < 16) {
    throw new Error("vault: ciphertext too short (missing GCM auth tag)");
  }
  const body = ciphertextWithTag.slice(0, ciphertextWithTag.length - 16);
  const tag = ciphertextWithTag.slice(ciphertextWithTag.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", keyRaw, nonce);
  decipher.setAuthTag(tag);
  // .final() throws on auth-tag mismatch — this is the wrong-key rejection.
  return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]));
}

/**
 * Open (creating if needed) a persona's vault, deriving the encryption key from
 * a supplied 32-byte secret key. Lower-level entry point used by tests and by
 * openPersonaVault (which resolves the persona's nsec first).
 */
export function openVaultWithSecret(
  personaDir: string,
  secretKey: Uint8Array,
): Vault {
  const path = vaultPath(personaDir);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  const keyRaw = deriveVaultKey(secretKey);
  return new SqliteVault(db, keyRaw);
}

/**
 * Open (creating if needed) a persona's vault, resolving the persona's shared
 * identity (identity.json, migrating from phantomchat.json / generating as
 * needed) and deriving the vault key from its nsec. This is the entry point CLI
 * + migration use.
 */
export async function openPersonaVault(personaDir: string): Promise<Vault> {
  const identity = await getOrCreatePersonaIdentity(personaDir);
  return openVaultWithSecret(personaDir, identity.secretKey);
}

/**
 * Decrypt a persona's vault and copy each secret into `env`, with the same
 * "existing value wins" policy the old plaintext env loader used
 * (preloadEnvFiles): a key already present in the environment (shell export,
 * systemd EnvironmentFile=) is never overwritten. Returns the names loaded.
 *
 * Best-effort: a missing / unopenable vault yields an empty result rather than
 * throwing, so a fresh install with no vault yet starts cleanly. Never logs
 * secret values.
 */
export async function loadVaultIntoEnv(
  personaDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ loaded: string[] }> {
  const loaded: string[] = [];
  let vault: Vault;
  try {
    vault = await openPersonaVault(personaDir);
  } catch {
    return { loaded };
  }
  try {
    for (const name of vault.list()) {
      if (env[name] !== undefined) continue; // existing wins
      const value = vault.get(name);
      if (value === undefined) continue;
      env[name] = value;
      loaded.push(name);
    }
  } finally {
    vault.close();
  }
  return { loaded };
}
