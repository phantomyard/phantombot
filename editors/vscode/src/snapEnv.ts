/**
 * Snap-aware environment pinning for the spawned `phantombot acp` subprocess.
 *
 * THE BUG THIS FIXES (exit 2 under the Ubuntu App Center / strict-snap VS Code):
 *
 *   When VS Code is installed as a STRICT SNAP (the one Ubuntu's App Center
 *   ships), snapd confines the editor — and every process it spawns — into the
 *   snap sandbox. Inside that sandbox `$HOME` is REDIRECTED from the user's real
 *   home (`/home/alice`) to a per-snap data dir (`/home/alice/snap/code/current`).
 *   phantombot resolves its persona/config store from `$HOME`/`$XDG_*` at
 *   runtime (see src/config.ts: xdgConfigHome/xdgDataHome ultimately fall back to
 *   the redirected `$HOME`). That redirected store is EMPTY — no personas were
 *   ever installed there — so `phantombot acp` finds zero personas and exits 2
 *   with "no other personas exist", killing the editor connector on first use.
 *
 *   A NATIVE install (e.g. the .deb, or Zed) sees the real `$HOME`, so it finds
 *   the real persona store and works — which is exactly the asymmetry observed.
 *
 * THE FIX:
 *
 *   snapd exposes the real (un-redirected) home via `$SNAP_REAL_HOME` and signals
 *   "we are inside a snap" via `$SNAP` (the path to the mounted snap). When we
 *   detect a snap, we PIN phantombot's store resolution back to the real home with
 *   two complementary moves:
 *
 *     1. PHANTOMBOT_CONFIG = <real home>/.config/phantombot/config.toml
 *        — so loadConfig reads the REAL config.toml, not the empty redirected one.
 *
 *     2. XDG_DATA_HOME  = <real home>/.local/share
 *        XDG_CONFIG_HOME = <real home>/.config
 *        — restored to the real home, OVERRIDING the values snapd redirects into
 *        the sandbox.
 *
 *   Why (2) is REQUIRED and (1) alone is NOT enough — the blocker Kai flagged on
 *   the second review pass (verified against src/config.ts):
 *
 *     loadConfig derives the DEFAULT persona/memory/state locations from
 *     `xdgDataHome()`, NOT from where PHANTOMBOT_CONFIG points:
 *
 *         dataDir      = join(xdgDataHome(), "phantombot")
 *         personasDir  = env.PHANTOMBOT_PERSONAS_DIR ?? toml.personas_dir ?? join(dataDir,"personas")
 *         memoryDbPath = env.PHANTOMBOT_MEMORY_DB    ?? toml.memory_db    ?? join(dataDir,"memory.sqlite")
 *         state.json / memory-index → also under xdgDataHome()
 *
 *     So a DEFAULT install (config.toml with no explicit `personas_dir`) still
 *     falls back to `join(xdgDataHome(),"phantombot","personas")`. Under a strict
 *     snap `XDG_DATA_HOME` is redirected into the empty sandbox store, so even with
 *     PHANTOMBOT_CONFIG pinned the child finds zero personas and exits 2. Restoring
 *     `XDG_DATA_HOME` to the real home fixes the default case; restoring
 *     `XDG_CONFIG_HOME` keeps config resolution consistent for any code path that
 *     reads it directly.
 *
 *   We deliberately DO NOT set `PHANTOMBOT_PERSONAS_DIR`. That env var is an
 *   absolute override that wins over `personas_dir` in config.toml, so pinning it
 *   would silently break any user who configured a custom persona root — exactly
 *   the regression Kai flagged in the FIRST review pass. With XDG_DATA_HOME pointing
 *   at the real home, loadConfig does the right thing for BOTH default installs and
 *   custom `personas_dir`/`memory_db` (which take precedence over the default and
 *   so keep working untouched).
 *
 *   NOTE on overriding XDG_*: snapd always populates `XDG_DATA_HOME`/`XDG_CONFIG_HOME`
 *   with the redirected sandbox paths, so there is no way to distinguish a
 *   deliberate user value from snapd's auto-redirect — and the redirected value is
 *   precisely the bug. We therefore force them to the real home inside the snap
 *   branch. A user who genuinely wants a custom store sets `personas_dir`/`memory_db`
 *   in config.toml, which still wins. We DO still respect an explicit
 *   `PHANTOMBOT_CONFIG` (snapd never sets that one) — if it's already present the
 *   user/wrapper chose it on purpose, so we leave it alone.
 *
 * This module is PURE (env in → env out, no fs, no process, no `vscode`) so the
 * exit-2 reproduction + the pinning behaviour are unit-tested under `bun test`.
 */

import { posix } from "node:path";

export type EnvMap = Record<string, string | undefined>;

/**
 * True iff we're running inside a snap sandbox. snapd sets `$SNAP` (the absolute
 * path to the mounted snap, e.g. `/snap/code/158`) for every confined process,
 * and `$SNAP_REAL_HOME` to the user's un-redirected home. We require BOTH: `$SNAP`
 * proves confinement, `$SNAP_REAL_HOME` is what we need to actually rebuild paths.
 */
export function isSnapConfined(env: EnvMap): boolean {
  return Boolean(env.SNAP && env.SNAP.trim()) &&
    Boolean(env.SNAP_REAL_HOME && env.SNAP_REAL_HOME.trim());
}

/**
 * Does `$HOME` look REDIRECTED into the snap sandbox? Under a strict snap, HOME
 * becomes `<real home>/snap/<name>/<rev>` — i.e. it sits under SNAP_REAL_HOME but
 * is not equal to it. This is the precise condition that empties phantombot's
 * persona store. Exposed for tests that reproduce the exit-2 case directly.
 */
export function isHomeRedirected(env: EnvMap): boolean {
  const home = env.HOME?.trim();
  const real = env.SNAP_REAL_HOME?.trim();
  if (!home || !real) return false;
  if (home === real) return false;
  // HOME redirected under the real home's snap/ subtree.
  return home.startsWith(real + "/snap/") || home.includes("/snap/");
}

/** Absolute config.toml under a given home, per phantombot's default layout. */
export function configPathFor(realHome: string): string {
  return posix.join(realHome, ".config", "phantombot", "config.toml");
}

/** Absolute `$XDG_DATA_HOME` under a given home (phantombot's default layout). */
export function dataHomeFor(realHome: string): string {
  return posix.join(realHome, ".local", "share");
}

/** Absolute `$XDG_CONFIG_HOME` under a given home (phantombot's default layout). */
export function configHomeFor(realHome: string): string {
  return posix.join(realHome, ".config");
}

/**
 * Given the ambient env, return the env the `phantombot acp` subprocess should be
 * spawned with. Outside a snap this is the input unchanged. Inside a snap we pin
 * phantombot's store resolution back to the REAL home (`$SNAP_REAL_HOME`):
 *
 *   - PHANTOMBOT_CONFIG → real config.toml (respecting an explicit override).
 *   - XDG_DATA_HOME / XDG_CONFIG_HOME → real home, FORCED over snapd's redirected
 *     sandbox values, so loadConfig's DEFAULT personasDir/memoryDbPath/state/
 *     memory-index (all derived from xdgDataHome()) point at the real, populated
 *     store instead of the empty sandbox one — fixing the exit-2 "no other personas
 *     exist" crash for default installs, not just custom-config ones.
 *
 * We deliberately leave `PHANTOMBOT_PERSONAS_DIR` unset so a custom `personas_dir`
 * in config.toml keeps working (it takes precedence over the default anyway).
 *
 * Idempotent + non-destructive: returns a NEW object, never mutates the input.
 */
export function snapAwareSpawnEnv(env: EnvMap): EnvMap {
  if (!isSnapConfined(env)) return env;

  const realHome = env.SNAP_REAL_HOME!.trim();
  const next: EnvMap = { ...env };

  // Respect an explicit PHANTOMBOT_CONFIG — snapd never sets it, so its presence
  // means the user/wrapper chose it on purpose.
  if (!next.PHANTOMBOT_CONFIG || !next.PHANTOMBOT_CONFIG.trim()) {
    next.PHANTOMBOT_CONFIG = configPathFor(realHome);
  }

  // Force the XDG dirs back to the real home. snapd ALWAYS redirects these into
  // the sandbox, so there's no deliberate-user-value to preserve — the redirected
  // value is exactly the bug. A user wanting a custom store sets personas_dir/
  // memory_db in config.toml, which still wins over the XDG-derived default.
  next.XDG_DATA_HOME = dataHomeFor(realHome);
  next.XDG_CONFIG_HOME = configHomeFor(realHome);

  return next;
}
