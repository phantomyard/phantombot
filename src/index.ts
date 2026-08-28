#!/usr/bin/env bun
/**
 * Phantombot CLI entry point.
 *
 * Imports the Citty dispatcher and runs it. The dispatcher itself lives in
 * src/cli/index.ts so it can be imported by tests without auto-running.
 *
 * Before dispatch we bootstrap credentials, in order:
 *
 *   1. `migratePlaintextToVault` — a ONE-WAY, idempotent, best-effort import of
 *      any plaintext `~/.env` / `~/.config/phantombot/.env` into the per-persona
 *      ENCRYPTED vaults. The plaintext file is KEPT (rollback), marked done with
 *      a sibling `.migrated-to-vault` stamp, and never read again at runtime —
 *      each startup it only earns a loud deprecation warning.
 *   2. `loadVaultIntoEnv` — decrypt the ACTIVE persona's vault and inject its
 *      secrets into process.env, with the same "existing value wins" policy the
 *      old plaintext loader used (a shell export is never overwritten). This is
 *      the vault replacement for the old plaintext self-source, and the ONLY
 *      runtime path by which a secret reaches `process.env`.
 *
 * Wrapped so a bootstrap hiccup never blocks the CLI from running.
 */

import { runMain } from "citty";
import { mainCommand } from "./cli/index.ts";
import { loadConfig, personaDir } from "./config.ts";
import { isReadOnlyInvocation } from "./lib/cliInvocation.ts";
import { bareInvocationMode, currentTty } from "./lib/tuiGate.ts";
import { cleanupPersonaTmpDir } from "./lib/harnessArgvFiles.ts";
import { runComplete } from "./lib/completion.ts";
import { log } from "./lib/logger.ts";
import { loadVaultIntoEnv } from "./lib/vault.ts";
import { migratePlaintextToVault } from "./lib/vaultMigrate.ts";

// Hidden dynamic-completion backend. The shell stubs emitted by
// `phantombot completion <shell>` call `phantombot _complete -- <words…>` on
// every <TAB>. Handle it here, before the credential bootstrap, so a tab press
// is as cheap and side-effect-free as --help and never touches the vault. It is
// intentionally not a Citty subcommand, so it stays out of --help output.
if (process.argv[2] === "_complete") {
  const candidates = await runComplete(mainCommand, process.argv.slice(3));
  if (candidates.length > 0) process.stdout.write(candidates.join("\n") + "\n");
  process.exit(0);
}

// A bare, TTY-attached `phantombot` opens the full-screen app (issue #471):
// chat with the default phantom, or the wizard when it is not configured yet.
//
// The gate is TTY-based, NOT argv-based, and it is a SECOND question asked
// after `isReadOnlyInvocation` rather than a change to it. A bare call stays
// read-only whenever nobody is watching — CI uses bare/`--help` as "does the
// binary run?" smoke tests and every <TAB> shells through this same entry, so
// an argv-based gate would write to disk on a runner and hang `phantombot |
// head` forever on a renderer nobody can see. See lib/tuiGate.ts.
const bareMode = bareInvocationMode(process.argv, currentTty());

// Skip the credential bootstrap entirely for read-only invocations
// (--help/--version/bare-and-unwatched) so they never mutate disk or provision
// a persona. An interactive TUI is the one bare invocation that DOES need the
// bootstrap: it is about to open a vault-backed conversation.
if (!isReadOnlyInvocation(process.argv) || bareMode === "tui") {
  try {
    const config = await loadConfig();
    await migratePlaintextToVault(config);
    const activePersona = process.env.PHANTOMBOT_PERSONA || config.defaultPersona;
    const activePersonaDir = personaDir(config, activePersona);
    await loadVaultIntoEnv(activePersonaDir);
    // Aggressive startup sweep of the persona's tmp dir (issue #365): reap
    // harness/route residue older than 1h left by crashed/SIGKILL'd turns that
    // never ran their `finally`. Age-gated so a live in-flight turn survives;
    // best-effort so it never wedges startup. The run lock is NOT in this dir.
    try {
      cleanupPersonaTmpDir(activePersonaDir);
    } catch (e) {
      log.warn("startup: persona tmp cleanup failed", {
        error: (e as Error).message,
      });
    }
  } catch (e) {
    // Never let credential bootstrap wedge the CLI — log and carry on. The
    // subcommand may still work (e.g. `phantombot persona` on a fresh box).
    log.warn("startup: vault bootstrap failed", { error: (e as Error).message });
  }
}
if (bareMode === "tui") {
  const { startTui } = await import("./tui/index.tsx");
  process.exitCode = await startTui();
} else if (bareMode === "repl") {
  const { runRepl } = await import("./tui/index.tsx");
  process.exitCode = await runRepl();
} else {
  runMain(mainCommand);
}
