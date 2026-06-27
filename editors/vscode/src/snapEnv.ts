/**
 * Snap-aware environment pinning for the spawned `phantombot acp` subprocess.
 *
 * THE BUG THIS FIXES (exit 2 under the snap-packaged VS Code):
 *
 *   When VS Code is installed as a SNAP, snapd redirects the XDG base dirs of the
 *   editor — and every process it spawns — into a per-snap sandbox. This happens
 *   under BOTH confinement modes, and the difference between them is exactly what
 *   the original fix got wrong:
 *
 *     - STRICT snap: `$HOME` itself is redirected to `/home/alice/snap/code/<rev>`,
 *       and snapd sets `$SNAP_REAL_HOME=/home/alice` so the real home is still
 *       recoverable.
 *     - CLASSIC snap (what Ubuntu's `code` snap actually ships): `$HOME` STAYS at
 *       the real `/home/alice` and `$SNAP_REAL_HOME` is NOT set — BUT snapd still
 *       redirects `$XDG_DATA_HOME`/`$XDG_CONFIG_HOME` to
 *       `/home/alice/snap/code/<rev>/.local/share` (and `/.config`).
 *
 *   phantombot resolves its persona/config store from `$XDG_DATA_HOME` at runtime
 *   (see src/config.ts: xdgDataHome → personas_dir/memory/state). Under EITHER snap
 *   mode that resolves into the empty sandbox store — no personas were ever
 *   installed there — so `phantombot acp` finds zero personas and exits 2 with
 *   "no other personas exist", killing the editor connector on first use.
 *
 *   A NATIVE install (e.g. the .deb, or Zed) sees real `$XDG_*`, so it finds the
 *   real persona store and works — which is exactly the asymmetry observed.
 *
 * THE FIX:
 *
 *   snapd signals "we are inside a snap" via `$SNAP` (the path to the mounted
 *   snap) under BOTH confinement modes. The real (un-redirected) home is then
 *   `$SNAP_REAL_HOME` if present (strict) or `$HOME` itself (classic) — see
 *   `realHomeFor`. When we detect a snap, we PIN phantombot's store resolution
 *   back to the real home with two complementary moves:
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
 * path to the mounted snap, e.g. `/snap/code/158`) for EVERY confined process,
 * whether the snap uses STRICT or CLASSIC confinement — so `$SNAP` alone is the
 * reliable signal that we're inside a snap.
 *
 * We deliberately do NOT also require `$SNAP_REAL_HOME` here. That was the
 * original bug: `$SNAP_REAL_HOME` is only populated under STRICT confinement
 * (where `$HOME` itself is redirected). A CLASSIC snap (the confinement Ubuntu's
 * `code` snap actually ships with) leaves `$HOME` at the real home and does NOT
 * set `$SNAP_REAL_HOME` — yet it STILL redirects `$XDG_DATA_HOME`/`$XDG_CONFIG_HOME`
 * into the per-snap sandbox (`$HOME/snap/code/<rev>/.local/share`). That empties
 * phantombot's persona store just like the strict case, so `phantombot acp` exits
 * 2 with "no other personas exist". Requiring `$SNAP_REAL_HOME` made the fix skip
 * exactly the classic-snap case that bites real users. We now detect on `$SNAP`
 * and derive the real home separately (see `realHomeFor`).
 */
export function isSnapConfined(env: EnvMap): boolean {
  return Boolean(env.SNAP && env.SNAP.trim());
}

/**
 * The user's REAL (un-redirected) home, however the snap exposes it:
 *
 *   - STRICT snap: `$HOME` is redirected into the sandbox, but snapd hands us the
 *     real home in `$SNAP_REAL_HOME` — use that.
 *   - CLASSIC snap: `$SNAP_REAL_HOME` is absent and `$HOME` is already the real
 *     home (only `$XDG_*` got redirected) — use `$HOME`.
 *
 * Returns `undefined` if neither is usable (we then make no changes).
 */
export function realHomeFor(env: EnvMap): string | undefined {
  const real = env.SNAP_REAL_HOME?.trim();
  if (real) return real;
  const home = env.HOME?.trim();
  if (home) return home;
  return undefined;
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

  const realHome = realHomeFor(env);
  if (!realHome) return env;

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
