#!/usr/bin/env bun
/**
 * Phantombot CLI entry point.
 *
 * Imports the Citty dispatcher and runs it. The dispatcher itself lives in
 * src/cli/index.ts so it can be imported by tests without auto-running.
 *
 * Before dispatch we bootstrap credentials, in order:
 *
 *   1. `migratePlaintextToVault` — an idempotent, best-effort migration of any
 *      leftover plaintext `~/.env` / `~/.config/phantombot/.env` into the
 *      per-persona ENCRYPTED vaults, deleting each plaintext file only after
 *      every key read back byte-for-byte. A no-op once the files are gone.
 *   2. `loadVaultIntoEnv` — decrypt the ACTIVE persona's vault and inject its
 *      secrets into process.env, with the same "existing value wins" policy the
 *      old plaintext loader used (a shell export / systemd EnvironmentFile= key
 *      is never overwritten). This is the vault replacement for the old
 *      plaintext self-source.
 *   3. `preloadEnvFiles` — retained for the transitional path: harness.ts still
 *      writes the Pi routing key to `~/.env` mid-session, and the harnesses
 *      re-source it before each spawn; the NEXT startup migration folds it into
 *      the vault. Once no plaintext files remain this is a cheap no-op.
 *
 * Wrapped so a bootstrap hiccup never blocks the CLI from running.
 */

import { runMain } from "citty";
import { mainCommand } from "./cli/index.ts";
import { loadConfig, personaDir } from "./config.ts";
import { preloadEnvFiles } from "./lib/envBootstrap.ts";
import { log } from "./lib/logger.ts";
import { loadVaultIntoEnv } from "./lib/vault.ts";
import { migratePlaintextToVault } from "./lib/vaultMigrate.ts";

try {
  const config = await loadConfig();
  await migratePlaintextToVault(config);
  const activePersona = process.env.PHANTOMBOT_PERSONA || config.defaultPersona;
  await loadVaultIntoEnv(personaDir(config, activePersona));
} catch (e) {
  // Never let credential bootstrap wedge the CLI — log and carry on. The
  // subcommand may still work (e.g. `phantombot persona` on a fresh box).
  log.warn("startup: vault bootstrap failed", { error: (e as Error).message });
}
await preloadEnvFiles();
runMain(mainCommand);
