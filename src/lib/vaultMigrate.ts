/**
 * One-time (idempotent) migration of the legacy PLAINTEXT credential files
 * into the per-persona encrypted vaults.
 *
 * Two source files, both FANNED OUT to every persona:
 *
 *   1. `~/.env` (legacy per-account secrets) → FANNED OUT into EVERY persona's
 *      vault. In the old world these were loaded globally (systemd
 *      `EnvironmentFile=` / `preloadEnvFiles`), so every persona could read
 *      them; on a single-operator multi-persona box (the dogfood plan: Lena +
 *      Kai) they must stay available to all personas, not just the default one,
 *      or the non-default personas silently lose `GITHUB_TOKEN` etc. once the
 *      plaintext file is deleted.
 *
 *   2. `~/.config/phantombot/.env` (central phantombot-managed secrets, e.g.
 *      TTS keys) → FANNED OUT into EVERY persona's vault, since any persona's
 *      turn might need them. On a per-key COLLISION (a key that also came from
 *      `~/.env`), the `~/.env` value WINS in every persona — so we skip
 *      overwriting it during the central fan-out.
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

/**
 * Every persona name that has a directory under personasDir. Hidden dirs
 * (leading dot — `.git`, `.DS_Store` dirs, editor scratch) are skipped so the
 * central fan-out doesn't spray an identity.json + a vault full of secrets into
 * non-persona junk. Real persona folders are never dot-prefixed.
 */
function listPersonaNames(config: Config): string[] {
  if (!existsSync(config.personasDir)) return [];
  try {
    return readdirSync(config.personasDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
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
 * Migrate `~/.env` by FANNING IT OUT into EVERY persona's vault (mirroring the
 * old global `EnvironmentFile=` behaviour, so non-default personas keep their
 * credentials). Read-back is verified in every persona written to; the plaintext
 * file is deleted only if ALL personas passed. Returns `removed: true` (with the
 * migrated keys) only on full success. Best-effort — never throws to the caller.
 */
async function migrateUserEnv(
  config: Config,
  personas: string[],
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
  if (personas.length === 0) {
    // No personas to fan out to — leave the file for a later run.
    return { removed: false, keys };
  }

  let allOk = true;
  for (const persona of personas) {
    let vault: Vault;
    try {
      vault = await openPersonaVault(personaDir(config, persona));
    } catch (e) {
      // One persona's vault won't open (identity mint failed, disk error) —
      // don't delete the plaintext (that persona would be left without the
      // secrets), but keep going so the others still migrate. Never throw.
      allOk = false;
      log.warn("vault-migrate: could not open vault for ~/.env fan-out — leaving it in place", {
        persona,
        error: (e as Error).message,
      });
      continue;
    }
    try {
      const ok = writeAndVerify(vault, entries);
      if (!ok) allOk = false;
    } finally {
      vault.close();
    }
  }

  if (allOk) {
    try {
      await unlink(path);
      log.info("vault-migrate: fanned ~/.env into all persona vaults, removed plaintext", {
        personaCount: personas.length,
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
      "vault-migrate: ~/.env read-back failed in at least one persona — leaving plaintext file in place",
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
    let vault: Vault;
    try {
      vault = await openPersonaVault(personaDir(config, persona));
    } catch (e) {
      // One persona's vault won't open — don't delete the plaintext (some
      // persona would be left without the central secrets), but keep going so
      // the others still get migrated. Never throw (best-effort).
      allOk = false;
      log.warn("vault-migrate: could not open vault for central fan-out", {
        persona,
        error: (e as Error).message,
      });
      continue;
    }
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

  // 1. ~/.env → fanned out to EVERY persona.
  const userResult = await migrateUserEnv(config, personas);

  // Record which keys came from `~/.env` so the central fan-out lets those win
  // (skips them) in EVERY persona. ONLY when the ~/.env migration actually
  // SUCCEEDED (removed === true, i.e. every key wrote and read back in every
  // persona): if it failed and we skipped these keys, a persona could end up
  // with the value from NEITHER source. On failure we let the central value
  // populate it, and a later ~/.env retry re-asserts local-wins.
  const localKeys = new Map<string, Set<string>>();
  if (userResult.removed && userResult.keys.length > 0) {
    const won = new Set(userResult.keys);
    for (const persona of personas) localKeys.set(persona, won);
  }

  // 2. central .env → every persona (local wins on collision).
  await migrateCentralEnv(config, personas, localKeys);
}
