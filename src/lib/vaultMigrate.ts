/**
 * One-time (idempotent) ONE-WAY import of the legacy PLAINTEXT credential files
 * into the per-persona encrypted vaults.
 *
 * Two source files, both FANNED OUT to every persona:
 *
 *   1. `~/.env` (legacy per-account secrets) → FANNED OUT into EVERY persona's
 *      vault. In the old world these were loaded globally (systemd
 *      `EnvironmentFile=` / startup self-source), so every persona could read
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
 * ONE-WAY, AND THE FILE SURVIVES (#452). We used to DELETE each plaintext file
 * once every key read back. We no longer do: the file is kept so an operator
 * can roll back to an older phantombot (which still sourced it) without having
 * lost anything. Instead each migrated file gets a sibling STAMP —
 * `<file>.migrated-to-vault` — and the stamp, not the file's absence, is what
 * makes the migration a no-op on later startups.
 *
 * The stamp is load-bearing, not decoration. Without it a retained plaintext
 * file would be re-imported on EVERY startup, so a `vault set` rotating a key
 * would be silently stomped back to the stale plaintext value at the next
 * restart. With it, the file is imported exactly once and is thereafter inert
 * — nothing in the runtime reads it (see envBootstrap.ts), and its continued
 * existence only earns a loud deprecation warning at startup.
 *
 * Safety (per source file):
 *   - VALIDATION GATE: after every encrypted write we read the value back
 *     THROUGH the vault (decrypt) and assert byte-for-byte equality with the
 *     source. For the central fan-out this is verified in EVERY persona written
 *     to. Only if ALL keys from a source file pass read-back do we STAMP that
 *     file as migrated. If ANY key fails we do not stamp, so the next startup
 *     retries — log-only, never a user-facing error, never a process exit.
 *   - Idempotent: a re-run with the stamp present (or the file absent) is a
 *     no-op. A partial prior run is simply retried — the vault writes are
 *     upserts, so re-writing an already-migrated key is harmless.
 */

import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  type Config,
  isConfigOwnedEnvMirror,
  isRoutingEnvName,
  personaDir,
} from "../config.ts";
import { defaultEnvFilePath, loadEnvFile } from "./envFile.ts";
import { log } from "./logger.ts";
import { openPersonaVault, type Vault } from "./vault.ts";

/** Sibling marker that records a plaintext file as already imported. */
export function migrationStampPath(envPath: string): string {
  return `${envPath}.migrated-to-vault`;
}

/**
 * Record `envPath` as imported. Content is informational only (an operator
 * reading it wants to know WHEN and WHICH keys); the mere existence of the
 * file is what suppresses re-import. Key NAMES only — never values — and
 * mode 600 to match the secrets file it sits beside.
 *
 * Returns false if the stamp could not be written: the caller must then treat
 * the migration as unfinished, because an unstamped retained file would be
 * re-imported (and could stomp a later vault rotation) on the next startup.
 */
async function stampMigrated(
  envPath: string,
  keys: string[],
): Promise<boolean> {
  const body =
    `# phantombot: imported into the encrypted persona vaults on ` +
    `${new Date().toISOString()}.\n` +
    `# This file's plaintext sibling is NO LONGER READ at runtime. It is kept\n` +
    `# only so you can roll back to an older phantombot. Delete both when you\n` +
    `# are satisfied; manage secrets with \`phantombot vault\`.\n` +
    keys.map((k) => `# key: ${k}`).join("\n") +
    (keys.length > 0 ? "\n" : "");
  try {
    await writeFile(migrationStampPath(envPath), body, {
      encoding: "utf8",
      mode: 0o600,
    });
    return true;
  } catch (e) {
    log.warn("vault-migrate: could not write migration stamp — will retry next startup", {
      path: migrationStampPath(envPath),
      error: (e as Error).message,
    });
    return false;
  }
}

/**
 * Loud, unmissable startup warning for a plaintext file that is still on disk.
 * Deliberately fires on EVERY startup for as long as the file exists: it is
 * the only signal an operator gets that a file they may still be editing has
 * stopped having any effect.
 */
function warnLegacyEnvFilePresent(path: string, imported: boolean): void {
  log.warn(
    `DEPRECATED: plaintext env file ${path} still exists and is NO LONGER READ. ` +
      (imported
        ? "Its keys were imported into the encrypted persona vaults; edits to it now do NOTHING. "
        : "It has NOT been imported (see the errors above); its keys are NOT available. ") +
      "Manage secrets with `phantombot vault set/get/list`. The file is kept only for rollback — " +
      "delete it once you are satisfied.",
  );
}

/** Legacy per-account secrets file. */
export function legacyUserEnvPath(): string {
  return process.env.PHANTOMBOT_USER_ENV_FILE ?? join(homedir(), ".env");
}

/**
 * The key names recorded in a migration stamp, or [] if it is unreadable.
 *
 * Load-bearing for split-state recovery: `~/.env` and the central file are
 * stamped independently, so a startup where one persona's vault failed to open
 * can leave `~/.env` stamped and the central file not. On the retry the
 * `~/.env` import is (correctly) a no-op — but without its key list the
 * central fan-out no longer knows which keys `~/.env` already won, and would
 * overwrite them with the central file's values. Reading the names back off
 * the stamp keeps "local wins" true across restarts. Names only; the stamp
 * never contains values.
 */
async function stampedKeys(envPath: string): Promise<string[]> {
  try {
    const body = await readFile(migrationStampPath(envPath), "utf8");
    return body
      .split("\n")
      .map((line) => /^#\s*key:\s*(\S+)\s*$/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined);
  } catch {
    return [];
  }
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
 * Drop the retired non-secret config.toml mirrors before importing (#452).
 *
 * A plaintext file on an upgraded host carries whatever the pre-#452 wizards
 * wrote, which includes `PHANTOMBOT_*_MODEL` / `_BIN` / `_CHAIN` mirrors that
 * now live only in config.toml. Migrating those into the vault would not
 * preserve them, it would PROMOTE them: vault keys are injected into
 * `process.env` at startup and env outranks config.toml, so the stale mirror
 * would permanently override the store `/model` now writes — and, with the
 * file retained and stamped, the old re-import loop can no longer heal it.
 *
 * They are dropped rather than migrated: they are not secrets and they have a
 * live home. Names only in the log — a dropped key is still a key an operator
 * may be looking for.
 */
function importableEntries(
  vars: Record<string, string>,
  path: string,
): Array<[string, string]> {
  const kept: Array<[string, string]> = [];
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(vars)) {
    // Routing names (#576) are dropped for a sharper reason than the mirrors:
    // a plaintext `~/.env` on an upgraded host may well hold the
    // PHANTOMBOT_PERSONA of whichever phantom the box mostly runs, and fanning
    // that into EVERY persona's vault would give each of them a row naming
    // some other phantom. They are not secrets and they are not per-phantom
    // settings — they are the caller's choice of phantom.
    if (isConfigOwnedEnvMirror(name) || isRoutingEnvName(name))
      dropped.push(name);
    else kept.push([name, value]);
  }
  if (dropped.length > 0) {
    log.warn(
      `vault-migrate: NOT importing non-secret names from ${path} — retired ` +
        "config.toml mirrors would override config.toml on every startup, and " +
        "routing names would let a vault choose which phantom a process is. " +
        "Set a model with `phantombot /model` or in config.toml; choose a " +
        `phantom with --persona or the configured default: ${dropped.join(", ")}`,
    );
  }
  return kept;
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
 * credentials). Read-back is verified in every persona written to; the file is
 * STAMPED as imported (never deleted) only if ALL personas passed. Returns
 * `imported: true` (with the migrated keys) only on full success. Best-effort —
 * never throws to the caller.
 */
async function migrateUserEnv(
  config: Config,
  personas: string[],
): Promise<{ settled: boolean; keys: string[] }> {
  const path = legacyUserEnvPath();
  if (!existsSync(path)) return { settled: false, keys: [] };
  if (existsSync(migrationStampPath(path))) {
    // Already imported on an earlier startup. Re-importing would overwrite any
    // vault rotation made since with the stale plaintext value. Still report
    // the keys it won — the central file may be unstamped and about to fan
    // out, and those keys must keep losing to this file's values.
    warnLegacyEnvFilePresent(path, true);
    return { settled: true, keys: await stampedKeys(path) };
  }
  let vars: Record<string, string>;
  try {
    vars = await loadEnvFile(path);
  } catch (e) {
    log.warn("vault-migrate: could not parse ~/.env — leaving it unimported", {
      error: (e as Error).message,
    });
    return { settled: false, keys: [] };
  }
  const entries = importableEntries(vars, path);
  const keys = entries.map(([k]) => k);
  if (personas.length === 0) {
    // No personas to fan out to — leave the file unstamped for a later run.
    return { settled: false, keys };
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
      log.warn("vault-migrate: could not open vault for ~/.env fan-out — not stamping as imported", {
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
    if (await stampMigrated(path, keys)) {
      log.info("vault-migrate: fanned ~/.env into all persona vaults", {
        personaCount: personas.length,
        keyCount: keys.length,
      });
      warnLegacyEnvFilePresent(path, true);
      return { settled: true, keys };
    }
    // Verified but unstamped: report NOT imported so the caller does not treat
    // these keys as settled, and so the next startup retries the whole file.
  } else {
    log.warn(
      "vault-migrate: ~/.env read-back failed in at least one persona — not stamping as imported",
    );
  }
  warnLegacyEnvFilePresent(path, false);
  return { settled: false, keys };
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
  if (existsSync(migrationStampPath(path))) {
    warnLegacyEnvFilePresent(path, true);
    return false;
  }
  let vars: Record<string, string>;
  try {
    vars = await loadEnvFile(path);
  } catch (e) {
    log.warn(
      "vault-migrate: could not parse central .env — leaving it unimported",
      { error: (e as Error).message },
    );
    return false;
  }
  const entries = importableEntries(vars, path);
  if (personas.length === 0) {
    // No personas to fan out to — nothing we can safely migrate into. Leave the
    // file unstamped so a later run (once a persona exists) can migrate it.
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
    if (await stampMigrated(path, entries.map(([k]) => k))) {
      log.info("vault-migrate: fanned central .env into all persona vaults", {
        personaCount: personas.length,
        keyCount: entries.length,
      });
      warnLegacyEnvFilePresent(path, true);
      return true;
    }
  } else {
    log.warn(
      "vault-migrate: central .env read-back failed in at least one persona — not stamping as imported",
    );
  }
  warnLegacyEnvFilePresent(path, false);
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
  // (skips them) in EVERY persona. ONLY when those keys are SETTLED — either
  // written and read back in every persona just now, or recorded in an
  // existing stamp from a previous startup. If the import FAILED and we
  // skipped these keys, a persona could end up with the value from NEITHER
  // source; on failure we let the central value populate it, and a later
  // ~/.env retry re-asserts local-wins. The stamped case matters because the
  // two files are stamped independently: `~/.env` can be settled while the
  // central file is still waiting to fan out.
  //
  // `settled`, not `imported`: a key does not stop having been won by
  // `~/.env` just because the run that won it was a previous one.
  const localKeys = new Map<string, Set<string>>();
  if (userResult.settled && userResult.keys.length > 0) {
    const won = new Set(userResult.keys);
    for (const persona of personas) localKeys.set(persona, won);
  }

  // 2. central .env → every persona (local wins on collision).
  await migrateCentralEnv(config, personas, localKeys);
}
