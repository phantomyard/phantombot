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
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { defaultEnvFilePath, loadEnvFile } from "./envFile.ts";

/** Files to source, in priority order (first file wins on key collision). */
function envFilesToLoad(): string[] {
  const userEnv = join(homedir(), ".env");
  return [userEnv, defaultEnvFilePath()];
}

/**
 * Cache entry for a single .env file. Keyed in the cache map by absolute path.
 *
 * Invalidation uses `(mtimeNs, size)` together. Either changing means the file
 * was edited; both must match for a cache hit:
 *   - `mtimeNs` (BigInt nanoseconds) catches almost all real edits — modern
 *     filesystems on Linux/macOS update it on every write.
 *   - `size` is the belt to the mtime suspenders. Some VFS layers (overlayfs,
 *     tmpfs under heavy load, NFS) coalesce same-millisecond writes onto a
 *     single mtime tick, and a `phantombot env set` flow in tests can land
 *     two writes inside that window. Almost any real-world content change
 *     also changes the byte length, so combining them is reliable in
 *     practice without ever reading the file body.
 */
interface CachedParse {
  mtimeNs: bigint;
  size: bigint;
  parsed: Record<string, string>;
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
  /**
   * Override the per-path parse cache. Defaults to a module-scope singleton
   * shared between `preloadEnvFiles()` and `reloadEnvFiles()` so an unchanged
   * file is statted but not re-parsed across spawns. Tests pass their own to
   * keep runs isolated.
   */
  statCache?: Map<string, CachedParse>;
}

/** Module-scope tracking of which keys came from a file at boot. */
const _moduleTracked = new Set<string>();

/** Module-scope mtime+parse cache shared across preload and reload calls. */
const _moduleStatCache = new Map<string, CachedParse>();

/**
 * For tests: clear the module-scope tracked set. Production code never calls
 * this — the daemon process keeps one tracking set for its lifetime.
 */
export function _resetTrackingForTesting(): void {
  _moduleTracked.clear();
}

/**
 * For tests: clear the module-scope stat cache. Production code never calls
 * this — the cache lives for the daemon's lifetime and is invalidated only
 * by mtime changes.
 */
export function _resetStatCacheForTesting(): void {
  _moduleStatCache.clear();
}

/**
 * Stat the file; if its mtime matches the cached entry, return the previously
 * parsed object (skipping the read + parse). Otherwise read, parse, and refresh
 * the cache. Returns `null` if the file is missing or the parse fails — the
 * caller treats null as "skip this file silently", matching legacy behaviour.
 *
 * Per-spawn cost on a hot, unchanged file: one `fs.stat` (~0.1ms) instead of a
 * stat + read + parse (~1ms+). The win compounds across two files × every
 * agent spawn.
 */
async function readEnvFileCached(
  path: string,
  cache: Map<string, CachedParse>,
): Promise<Record<string, string> | null> {
  if (!existsSync(path)) {
    // File no longer exists — drop any stale cache entry so a recreated
    // file later isn't served from the old parse.
    cache.delete(path);
    return null;
  }
  let mtimeNs: bigint;
  let size: bigint;
  try {
    const st = await stat(path, { bigint: true });
    mtimeNs = st.mtimeNs;
    size = st.size;
  } catch {
    cache.delete(path);
    return null;
  }
  const cached = cache.get(path);
  if (cached && cached.mtimeNs === mtimeNs && cached.size === size) {
    return cached.parsed;
  }
  let parsed: Record<string, string>;
  try {
    parsed = await loadEnvFile(path);
  } catch {
    // Malformed .env shouldn't crash startup or a spawn — `phantombot env`
    // commands surface the parse error in a more useful way.
    return null;
  }
  cache.set(path, { mtimeNs, size, parsed });
  return parsed;
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
  const cache = opts.statCache ?? _moduleStatCache;
  const loaded: string[] = [];

  for (const path of files) {
    const vars = await readEnvFileCached(path, cache);
    if (vars === null) continue;
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
  const cache = opts.statCache ?? _moduleStatCache;

  // Collect every key the union of files would contribute, with first-file
  // priority — same precedence rule preloadEnvFiles uses. Cache lookups
  // short-circuit the read+parse when a file's mtime hasn't changed, so a
  // hot per-spawn reload on an unchanged ~/.env costs roughly one stat call.
  const fileValues = new Map<string, string>();
  for (const path of files) {
    const vars = await readEnvFileCached(path, cache);
    if (vars === null) continue;
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
