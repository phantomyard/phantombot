/**
 * Engine scope — the per-call context an embedding application runs under.
 *
 * `phantombot` the CLI/daemon resolves every on-disk location from
 * `$XDG_CONFIG_HOME`/`$XDG_DATA_HOME`/`$XDG_STATE_HOME` (see `config.ts`) and
 * logs to stderr. An application that embeds the engine (`src/engine/`) must
 * NOT share those with the host's own phantombot: its personas, memory, vault
 * and turn registry live under the root it chose.
 *
 * The scope is carried by `AsyncLocalStorage`, NOT by mutating `process.env`:
 *   - the daemon and the CLI never enter a scope, so every helper that
 *     consults it falls through to the exact pre-engine behaviour — the
 *     library is strictly additive;
 *   - an application's own environment is never rewritten;
 *   - two engines on two roots in one process resolve independently.
 *
 * Only the XDG base directories and the log sink are scoped. Everything else
 * (config files, persona dirs, memory db, registry, digests, workspace locks)
 * already derives from those three helpers, which is what keeps this seam
 * small. Harness subprocesses receive the scoped roots as `XDG_*` variables
 * (`scopedChildEnv`), so a tool the model runs (`phantombot memory search`,
 * the embedded pi engine) resolves the same root as its parent.
 *
 * Async generators are the one trap: a generator body resumes in the context
 * of whoever calls `next()`, not the one that created it. `bindToScope` wraps
 * an async iterable so every step re-enters the scope.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface EngineScope {
  /** Replaces `$XDG_CONFIG_HOME` for everything run inside the scope. */
  configHome: string;
  /** Replaces `$XDG_DATA_HOME`. */
  dataHome: string;
  /** Replaces `$XDG_STATE_HOME`. */
  stateHome: string;
  /** Receives every structured log line emitted inside the scope. */
  logSink?: (line: string) => void;
}

const storage = new AsyncLocalStorage<EngineScope>();

/** The active scope, or undefined outside any engine call (CLI/daemon). */
export function currentEngineScope(): EngineScope | undefined {
  return storage.getStore();
}

/** Run `fn` (and every async continuation it starts) inside `scope`. */
export function runInEngineScope<T>(scope: EngineScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/**
 * Wrap an async iterable so each `next()`/`return()`/`throw()` runs inside
 * `scope`, whoever drives the iteration.
 */
export function bindToScope<T>(
  scope: EngineScope,
  iterable: AsyncIterable<T>,
): AsyncIterableIterator<T> {
  const it = runInEngineScope(scope, () => iterable[Symbol.asyncIterator]());
  return {
    next: (...args: [] | [unknown]) =>
      runInEngineScope(scope, () => it.next(...(args as []))),
    return: (value?: unknown) =>
      runInEngineScope(scope, () =>
        it.return
          ? it.return(value as T)
          : Promise.resolve({ done: true as const, value: value as T }),
      ),
    throw: (error?: unknown) =>
      runInEngineScope(scope, () =>
        it.throw ? it.throw(error) : Promise.reject(error),
      ),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

/**
 * The `XDG_*` variables a harness subprocess needs to resolve the same roots
 * as its parent. Empty outside a scope, so the daemon's child env is
 * byte-identical to what it was before the engine existed.
 */
export function scopedChildEnv(): Record<string, string> {
  const scope = storage.getStore();
  if (!scope) return {};
  return {
    XDG_CONFIG_HOME: scope.configHome,
    XDG_DATA_HOME: scope.dataHome,
    XDG_STATE_HOME: scope.stateHome,
  };
}

/**
 * Host-level LOCATION overrides: environment variables that point phantombot
 * at a specific file or directory. They name the HOST's phantombot (or a test
 * sandbox). Inside an engine scope the embedding application chose its root,
 * and honouring one of these there would silently aim the application at the
 * host's personas, memory, vault or state. Tuning variables (timeouts,
 * feature switches) are NOT listed — they still apply inside a scope.
 */
export const HOST_LOCATION_ENV = [
  "PHANTOMBOT_CONFIG",
  "PHANTOMBOT_PERSONAS_DIR",
  "PHANTOMBOT_MEMORY_DB",
  "PHANTOMBOT_DEFAULT_PERSONA",
  "PHANTOMBOT_STATE",
  "PHANTOMBOT_STATE_AUDIT",
  "PHANTOMBOT_TURN_REGISTRY_DIR",
  "PHANTOMBOT_TURN_DIGEST_DIR",
  "PHANTOMBOT_WORKSPACE_LOCK_DIR",
  "PHANTOMBOT_CHATTINESS_STATE",
  "PHANTOMBOT_COOLDOWN_STATE",
  "PHANTOMBOT_REPLY_MODE_STATE",
] as const;

export type HostLocationEnvName = (typeof HOST_LOCATION_ENV)[number];

/**
 * `process.env[name]` outside a scope (the CLI and the daemon are unchanged);
 * undefined inside one, so the location falls through to the scoped XDG root.
 */
export function hostLocationEnv(name: HostLocationEnvName): string | undefined {
  if (storage.getStore()) return undefined;
  return process.env[name];
}
