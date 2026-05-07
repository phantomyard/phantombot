/**
 * Self-load `~/.env` and `~/.config/phantombot/.env` into process.env at
 * startup, with a `reloadEnvFiles()` re-source path used by the harnesses
 * before each agent spawn so `phantombot env set` takes effect mid-session.
 *
 * Why startup load: launchd has no equivalent of systemd's `EnvironmentFile=`
 * plist key, so on macOS phantombot has to source these files itself before
 * any subcommand reads `process.env.X`. On Linux the systemd unit already
 * sources both files, so this is a (cheap) no-op there — the `existing-wins`
 * policy below means anything systemd already set keeps its value.
 *
 * Why reload-on-spawn: `phantombot env set NAME value` writes atomically to
 * disk but does NOT mutate the running phantombot daemon's `process.env`.
 * Without re-sourcing, a freshly-saved secret is invisible to the harnessed
 * agent until the daemon restarts. Each harness calls `reloadEnvFiles()`
 * right before spawning so the agent sees the latest file state.
 *
 * Sticky-vs-reloadable semantics:
 *   - At boot we track which keys were FILLED IN FROM A FILE. Those keys
 *     are reloadable: a later `reloadEnvFiles()` may update or delete them
 *     to match the file.
 *   - Keys that were already in `process.env` at boot (shell-export, systemd
 *     EnvironmentFile=, parent process) are sticky: they were never tracked
 *     as file-sourced, so reload won't touch them. This preserves the
 *     "explicit shell export wins" guarantee for the launching shell.
 *   - A new key that appears in the file post-boot AND isn't already in
 *     the env gets loaded and tracked (so a future reload can also update
 *     it). If a new file-key collides with an existing env key, the env
 *     wins — same shell-wins rule.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { defaultEnvFilePath, loadEnvFile } from "./envFile.ts";

/** Files to source, in priority order (first file wins on key collision). */
function envFilesToLoad(): string[] {
  const userEnv = join(homedir(), ".env");
  return [userEnv, defaultEnvFilePath()];
}

export interface PreloadOptions {
  /** Override the file list — tests use this to point at fixture files. */
  files?: readonly string[];
  /** Override the env target — defaults to process.env. Tests inject a mutable map. */
  env?: NodeJS.ProcessEnv;
  /**
   * Override the file-sourced-key tracking set. Defaults to a module-scope
   * singleton (so `reloadEnvFiles()` can re-sync against the same set that
   * `preloadEnvFiles()` populated at boot). Tests pass their own to keep
   * runs isolated.
   */
  tracked?: Set<string>;
}

/** Module-scope tracking of which keys came from a file at boot. */
const _moduleTracked = new Set<string>();

/**
 * For tests: clear the module-scope tracked set. Production code never calls
 * this — the daemon process keeps one tracking set for its lifetime.
 */
export function _resetTrackingForTesting(): void {
  _moduleTracked.clear();
}

/**
 * Read each .env file in turn and copy missing keys into env. Existing
 * values are not overwritten. Silent on missing files (a fresh install
 * has neither .env yet).
 *
 * Records loaded keys in the tracking set so a later `reloadEnvFiles()`
 * call knows which keys it's allowed to update or delete.
 *
 * Returns the names of variables we set, so tests can assert on the
 * effect without intercepting process.env writes.
 */
export async function preloadEnvFiles(
  opts: PreloadOptions = {},
): Promise<{ loaded: string[] }> {
  const env = opts.env ?? process.env;
  const files = opts.files ?? envFilesToLoad();
  const tracked = opts.tracked ?? _moduleTracked;
  const loaded: string[] = [];

  for (const path of files) {
    if (!existsSync(path)) continue;
    let vars: Record<string, string>;
    try {
      vars = await loadEnvFile(path);
    } catch {
      // A malformed .env shouldn't crash startup. The follow-up `phantombot
      // env` commands will surface the parse error in a more useful way.
      continue;
    }
    for (const [k, v] of Object.entries(vars)) {
      if (env[k] === undefined) {
        env[k] = v;
        tracked.add(k);
        loaded.push(k);
      }
    }
  }

  return { loaded };
}

/**
 * Re-read each .env file and reconcile against the tracked set:
 *   - tracked key still present in file → update env if value changed
 *   - tracked key dropped from file       → delete from env, untrack
 *   - new key in file (not tracked, not in env) → load + track
 *   - new key in file but already in env (shell-export) → leave alone
 *
 * The harnesses call this right before spawning the agent so a freshly
 * persisted credential (`phantombot env set FOO bar`) is visible to the
 * subprocess on the very next turn — no daemon restart required.
 *
 * Returns the keys that changed and the keys that were removed, in case
 * the caller wants to log the reconciliation.
 */
export async function reloadEnvFiles(
  opts: PreloadOptions = {},
): Promise<{ updated: string[]; removed: string[] }> {
  const env = opts.env ?? process.env;
  const files = opts.files ?? envFilesToLoad();
  const tracked = opts.tracked ?? _moduleTracked;

  // Collect every key the union of files would contribute, with first-file
  // priority — same precedence rule preloadEnvFiles uses.
  const fileValues = new Map<string, string>();
  for (const path of files) {
    if (!existsSync(path)) continue;
    let vars: Record<string, string>;
    try {
      vars = await loadEnvFile(path);
    } catch {
      continue;
    }
    for (const [k, v] of Object.entries(vars)) {
      if (!fileValues.has(k)) fileValues.set(k, v);
    }
  }

  const updated: string[] = [];
  const removed: string[] = [];

  // Phase 1: reconcile previously-tracked keys against the file state.
  // We snapshot the tracked set before mutating it inside the loop.
  for (const k of [...tracked]) {
    const fresh = fileValues.get(k);
    if (fresh === undefined) {
      // The file no longer has this key. Treat the file as truth and
      // delete it from env so the next subprocess matches what's on disk.
      if (env[k] !== undefined) delete env[k];
      tracked.delete(k);
      removed.push(k);
    } else if (env[k] !== fresh) {
      env[k] = fresh;
      updated.push(k);
    }
  }

  // Phase 2: pick up new file keys that we haven't seen before. Existing
  // env values still win (shell-export sticky guarantee), but if the slot
  // is empty we load and start tracking.
  for (const [k, v] of fileValues) {
    if (tracked.has(k)) continue;
    if (env[k] === undefined) {
      env[k] = v;
      tracked.add(k);
      updated.push(k);
    }
  }

  return { updated, removed };
}
