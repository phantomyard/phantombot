/**
 * One-time (idempotent) migration of the legacy PLAINTEXT credential files
 * into the per-persona encrypted vaults.
 *
 * Two source files, two policies:
 *
 *   1. `~/.env` (legacy per-account secrets) → migrated into the DEFAULT/active
 *      persona's vault ONLY. These were always the single-box operator's own
 *      credentials, so they belong to the one active persona.
 *
 *   2. `~/.config/phantombot/.env` (central phantombot-managed secrets, e.g.
 *      TTS keys) → FANNED OUT into EVERY persona's vault, since any persona's
 *      turn might need them. On a per-key COLLISION (a persona already received
 *      that key from `~/.env`), the persona-local value from `~/.env` WINS — so
 *      we skip overwriting it during the central fan-out.
 *
 * Safety (per source file):
 *   - VALIDATION GATE: after every encrypted write we read the value back
 *     THROUGH the vault (decrypt) and assert byte-for-byte equality with the
 *     source. For the central fan-out this is verified in EVERY persona written
 *     to. Only if ALL keys from a source file pass read-back do we DELETE that
 *     plaintext file (clean delete, no .bak). If ANY key fails, we abort the
 *     delete, LEAVE the file, and log-only — never a user-facing error, never
 *     a process exit.
 *   - Idempotent: a re-run with the plaintext files already gone is a no-op.
 *     A partial prior run (file still present because one key failed) is simply
 *     retried — the vault writes are upserts, so re-writing an already-migrated
 *     key is harmless.
 */

import { existsSync, readdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { type Config, personaDir } from "../config.ts";
import { defaultEnvFilePath, loadEnvFile } from "./envFile.ts";
import { log } from "./logger.ts";
import { openPersonaVault, type Vault } from "./vault.ts";

/** Legacy per-account secrets file. */
export function legacyUserEnvPath(): string {
  return process.env.PHANTOMBOT_USER_ENV_FILE ?? join(homedir(), ".env");
}

/** Every persona name that has a directory under personasDir. */
function listPersonaNames(config: Config): string[] {
  if (!existsSync(config.personasDir)) return [];
  try {
    return readdirSync(config.personasDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Write each `[name, value]` into `vault`, then read each back and confirm it
 * decrypts to exactly the source value. Returns true only if every key both
 * wrote and read back byte-for-byte. `skip` names are not written (used to let
 * a persona-local `~/.env` value win over a central-file value).
 */
function writeAndVerify(
  vault: Vault,
  entries: Array<[string, string]>,
  skip: Set<string> = new Set(),
): boolean {
  let allOk = true;
  for (const [name, value] of entries) {
    if (skip.has(name)) continue;
    try {
      vault.set(name, value);
      const readBack = vault.get(name);
      if (readBack !== value) {
        allOk = false;
        // Name only — never the value.
        log.warn("vault-migrate: read-back mismatch", { name });
      }
    } catch (e) {
      allOk = false;
      log.warn("vault-migrate: write/read-back failed", {
        name,
        error: (e as Error).message,
      });
    }
  }
  return allOk;
}

/**
 * Migrate `~/.env` into the default/active persona's vault. Returns true if the
 * plaintext file was (or already is) fully migrated and removed. Best-effort —
 * never throws to the caller.
 */
async function migrateUserEnv(
  config: Config,
  defaultPersona: string,
): Promise<{ removed: boolean; keys: string[] }> {
  const path = legacyUserEnvPath();
  if (!existsSync(path)) return { removed: false, keys: [] };
  let vars: Record<string, string>;
  try {
    vars = await loadEnvFile(path);
  } catch (e) {
    log.warn("vault-migrate: could not parse ~/.env — leaving it in place", {
      error: (e as Error).message,
    });
    return { removed: false, keys: [] };
  }
  const entries = Object.entries(vars);
  const keys = entries.map(([k]) => k);
  const vault = await openPersonaVault(personaDir(config, defaultPersona));
  let ok: boolean;
  try {
    ok = writeAndVerify(vault, entries);
  } finally {
    vault.close();
  }
  if (ok) {
    try {
      await unlink(path);
      log.info("vault-migrate: migrated ~/.env into vault, removed plaintext", {
        persona: defaultPersona,
        keyCount: keys.length,
      });
      return { removed: true, keys };
    } catch (e) {
      log.warn("vault-migrate: verified but could not remove ~/.env", {
        error: (e as Error).message,
      });
    }
  } else {
    log.warn(
      "vault-migrate: ~/.env read-back failed — leaving plaintext file in place",
    );
  }
  return { removed: false, keys };
}

/**
 * Migrate the central `~/.config/phantombot/.env` into EVERY persona's vault.
 * On a per-key collision with a key that came from `~/.env` (in `localKeys`),
 * the persona-local value wins — so we skip that key in the persona that
 * already has it. Read-back is verified in every persona written to; the file
 * is deleted only if ALL personas passed. Best-effort — never throws.
 *
 * `localKeys` maps persona name → the set of keys that persona already got from
 * `~/.env` (only ever the default persona, in practice).
 */
async function migrateCentralEnv(
  config: Config,
  personas: string[],
  localKeys: Map<string, Set<string>>,
): Promise<boolean> {
  const path = defaultEnvFilePath();
  if (!existsSync(path)) return false;
  let vars: Record<string, string>;
  try {
    vars = await loadEnvFile(path);
  } catch (e) {
    log.warn(
      "vault-migrate: could not parse central .env — leaving it in place",
      { error: (e as Error).message },
    );
    return false;
  }
  const entries = Object.entries(vars);
  if (personas.length === 0) {
    // No personas to fan out to — nothing we can safely migrate into. Leave the
    // file so a later run (once a persona exists) can migrate it.
    return false;
  }

  let allOk = true;
  for (const persona of personas) {
    const skip = localKeys.get(persona) ?? new Set<string>();
    const vault = await openPersonaVault(personaDir(config, persona));
    try {
      const ok = writeAndVerify(vault, entries, skip);
      if (!ok) allOk = false;
    } finally {
      vault.close();
    }
  }

  if (allOk) {
    try {
      await unlink(path);
      log.info(
        "vault-migrate: fanned central .env into all persona vaults, removed plaintext",
        { personaCount: personas.length, keyCount: entries.length },
      );
      return true;
    } catch (e) {
      log.warn("vault-migrate: verified but could not remove central .env", {
        error: (e as Error).message,
      });
    }
  } else {
    log.warn(
      "vault-migrate: central .env read-back failed in at least one persona — leaving plaintext file in place",
    );
  }
  return false;
}

/**
 * Run the full plaintext→vault migration. Idempotent and best-effort: any
 * failure is logged (never surfaced, never a process exit) and the plaintext
 * file is left in place so a later run can retry. Safe to call on every
 * startup — with no plaintext files present it does nothing.
 *
 * Order matters: `~/.env` migrates first so its keys are recorded as
 * persona-local; the central fan-out then honours "local wins" by skipping
 * those keys in the persona that already has them.
 */
export async function migratePlaintextToVault(config: Config): Promise<void> {
  const defaultPersona = config.defaultPersona;

  // Enumerate personas for the central fan-out. Ensure the default persona is
  // included even if it has no dir yet (openPersonaVault creates it), so its
  // ~/.env keys land somewhere.
  const personaSet = new Set(listPersonaNames(config));
  personaSet.add(defaultPersona);
  const personas = [...personaSet];

  // 1. ~/.env → default persona.
  const userResult = await migrateUserEnv(config, defaultPersona);

  // Record which keys the default persona already got locally, so the central
  // fan-out lets those win (skips them for that persona only).
  const localKeys = new Map<string, Set<string>>();
  if (userResult.keys.length > 0) {
    localKeys.set(defaultPersona, new Set(userResult.keys));
  }

  // 2. central .env → every persona (local wins on collision).
  await migrateCentralEnv(config, personas, localKeys);
}
