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

import { loadConfig, personaDir as resolvePersonaDir, type Config } from "../config.ts";
import { log } from "./logger.ts";
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
  // journal_mode = DELETE (rollback journal, not WAL): the vault is tiny and
  // low-traffic, so WAL's concurrency win is irrelevant, and WAL would leave a
  // `vault.sqlite-wal` sidecar holding uncheckpointed rows. That sidecar breaks
  // the portability promise — "copy the persona folder and its secrets travel"
  // must hold for the single `vault.sqlite` alone. DELETE mode keeps everything
  // in the one file at rest (the -journal file exists only mid-transaction).
  db.exec("PRAGMA journal_mode = DELETE");
  // synchronous = FULL: fsync on every commit. The migration deletes the ONLY
  // plaintext copy of a secret right after writing it here, so the ciphertext
  // must be durably on disk before that unlink — NORMAL could lose the last
  // write on power loss and leave neither copy. Perf cost is nil at this volume.
  db.exec("PRAGMA synchronous = FULL");
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
 * Read EVERY secret out of a persona's vault into a decrypted Map, then close
 * the vault. Best-effort: returns `null` if the vault can't be OPENED (fresh
 * install, missing identity, DB-level corruption) so callers can distinguish
 * "no vault" from "empty vault". Never logs secret values.
 *
 * Decryption is PER-ROW resilient: a single undecryptable row (corrupt nonce/
 * ciphertext/tag, or a value written under a different key) is skipped and its
 * name collected in `badKeys` — it must NOT abort the read and blank every
 * OTHER secret for the turn. This is fail-*partial*, not fail-open: we never
 * invent or substitute a value, so a row we can't decrypt (already unusable) is
 * simply dropped, with no security regression. The caller decides how to
 * surface `badKeys`.
 */
async function readAllVaultValues(
  personaDirPath: string,
): Promise<{ values: Map<string, string>; badKeys: string[] } | null> {
  let vault: Vault;
  try {
    vault = await openPersonaVault(personaDirPath);
  } catch {
    return null;
  }
  const values = new Map<string, string>();
  const badKeys: string[] = [];
  try {
    for (const name of vault.list()) {
      try {
        const value = vault.get(name);
        if (value !== undefined) values.set(name, value);
      } catch {
        // One poisoned row shouldn't cost the persona its other secrets.
        // Record the name (never the value) and keep loading the good rows.
        badKeys.push(name);
      }
    }
  } finally {
    vault.close();
  }
  return { values, badKeys };
}

/**
 * Key-set signatures we've already warned about. An undecryptable vault row is
 * surfaced ONCE per process start, deduped by the exact set of bad keys, so
 * corruption stays visible without spamming a warning on every per-turn reload.
 */
const _warnedBadKeySets = new Set<string>();

/** For tests: reset the warn-once-per-process dedupe of undecryptable keys. */
export function _resetVaultWarningsForTesting(): void {
  _warnedBadKeySets.clear();
}

/** Warn once per process start about undecryptable vault rows. Never logs values. */
function warnBadVaultKeys(badKeys: string[]): void {
  if (badKeys.length === 0) return;
  const sorted = [...badKeys].sort();
  const signature = sorted.join(" ");
  if (_warnedBadKeySets.has(signature)) return;
  _warnedBadKeySets.add(signature);
  log.warn(
    `vault: ${sorted.length} undecryptable key${sorted.length === 1 ? "" : "s"} ` +
      `(${sorted.join(", ")}) — skipped; other secrets loaded normally`,
    { count: sorted.length, keys: sorted },
  );
}

/**
 * Module-scope set of env keys THIS process injected from a vault. Mirrors
 * envBootstrap's `_moduleTracked`: it lets a later reload for a DIFFERENT
 * persona reconcile — updating a key to the new persona's value, or removing it
 * if the new persona doesn't have it — without ever touching a key that was
 * already in the environment at boot (shell export / systemd EnvironmentFile=).
 */
const _vaultTracked = new Set<string>();

/** The persona dir whose vault we last successfully injected, for transient-fail handling. */
let _vaultLoadedPersonaDir: string | undefined;

/** For tests: reset the module-scope vault env tracking. */
export function _resetVaultTrackingForTesting(): void {
  _vaultTracked.clear();
  _vaultLoadedPersonaDir = undefined;
}

/**
 * Decrypt a persona's vault and RECONCILE it into `env`, so `env` ends up
 * holding exactly this persona's vault secrets (plus any sticky boot keys).
 *
 * This is both the startup loader AND the per-turn reload: it mirrors
 * envBootstrap.reloadEnvFiles' semantics against the vault instead of a file.
 *
 *   - Phase 1: every key WE previously injected from a vault (in `tracked`) is
 *     reconciled — updated to this persona's value, or DELETED if this persona
 *     doesn't have it. This is what stops persona A's GITHUB_TOKEN leaking into
 *     persona B's turn, and what makes a `vault set` from the previous turn
 *     visible on the next one (the value changed on disk → we overwrite env).
 *   - Phase 2: new vault keys not already present are loaded + tracked. A key
 *     already in the env from boot (never tracked) is left alone — sticky
 *     shell/systemd wins, same guarantee the plaintext loader gave.
 *
 * Fail-closed on an unopenable vault: if this is a DIFFERENT persona than the
 * one last loaded we strip the tracked keys (better no secret than the wrong
 * persona's); if it's the SAME persona we treat it as a transient blip and
 * leave the already-injected secrets in place. Never throws, never logs values.
 */
export async function loadVaultIntoEnv(
  personaDirPath: string,
  env: NodeJS.ProcessEnv = process.env,
  tracked: Set<string> = _vaultTracked,
): Promise<{ updated: string[]; removed: string[]; badKeys: string[] }> {
  const updated: string[] = [];
  const removed: string[] = [];
  const result = await readAllVaultValues(personaDirPath);

  if (result === null) {
    // A null (unopenable) vault is a distinct failure mode from per-row
    // corruption: there are no decryptable-or-not rows to report, so badKeys
    // is empty. This is what lets a caller tell "no vault" from "1 bad row".
    if (personaDirPath === _vaultLoadedPersonaDir) {
      // Same persona, transient open failure — keep what we already injected.
      return { updated, removed, badKeys: [] };
    }
    // Different/first persona we can't read: fail closed, strip prior keys.
    for (const k of [...tracked]) {
      if (env[k] !== undefined) delete env[k];
      tracked.delete(k);
      removed.push(k);
    }
    _vaultLoadedPersonaDir = undefined;
    return { updated, removed, badKeys: [] };
  }

  const { values, badKeys } = result;

  // Corruption becomes visible instead of silent: surface undecryptable rows
  // once per process start. The good rows below still load — a bad SENTRY_DSN
  // no longer costs the persona its GITHUB_TOKEN.
  warnBadVaultKeys(badKeys);

  // Phase 1: reconcile previously vault-injected keys against this persona.
  for (const k of [...tracked]) {
    const fresh = values.get(k);
    if (fresh === undefined) {
      if (env[k] !== undefined) delete env[k];
      tracked.delete(k);
      removed.push(k);
    } else if (env[k] !== fresh) {
      env[k] = fresh;
      updated.push(k);
    }
  }

  // Phase 2: load new vault keys the env doesn't already hold (sticky wins).
  for (const [k, v] of values) {
    if (tracked.has(k)) continue;
    if (env[k] === undefined) {
      env[k] = v;
      tracked.add(k);
      updated.push(k);
    }
  }

  _vaultLoadedPersonaDir = personaDirPath;
  return { updated, removed, badKeys };
}

/**
 * Config is stable for the daemon's lifetime (a config change restarts the
 * service), so cache it for the hot per-spawn reload path rather than re-reading
 * config.toml + state.json on every turn.
 */
let _cachedConfig: Config | undefined;
async function cachedConfig(): Promise<Config> {
  if (!_cachedConfig) _cachedConfig = await loadConfig();
  return _cachedConfig;
}

/** For tests: drop the cached config so a fresh one is loaded next call. */
export function _resetConfigCacheForTesting(): void {
  _cachedConfig = undefined;
}

/**
 * Reconcile the given persona's vault into `process.env` before a harness spawn.
 * Resolves the persona the same way the CLI does (explicit name → the turn's
 * PHANTOMBOT_PERSONA → default persona). This is the vault equivalent of
 * envBootstrap.reloadEnvFiles — the harnesses call it right after that so a
 * secret saved via `phantombot vault set` on the previous turn is visible to
 * the subprocess on this one, AND so each persona's turn only ever sees its own
 * secrets. Best-effort: never throws.
 */
export async function reloadVaultForPersona(
  persona: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ updated: string[]; removed: string[]; badKeys: string[] }> {
  try {
    const config = await cachedConfig();
    const name = persona || process.env.PHANTOMBOT_PERSONA || config.defaultPersona;
    return await loadVaultIntoEnv(resolvePersonaDir(config, name), env);
  } catch {
    return { updated: [], removed: [], badKeys: [] };
  }
}
