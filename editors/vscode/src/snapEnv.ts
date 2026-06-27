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
 *   detect a snap, we PIN phantombot's config resolution back to the real home by
 *   setting a single absolute override the config resolver already honours:
 *
 *     - PHANTOMBOT_CONFIG = <real home>/.config/phantombot/config.toml
 *
 *   (Verified against src/config.ts: loadConfig reads `process.env.PHANTOMBOT_CONFIG`
 *   first.) Pointing PHANTOMBOT_CONFIG at the real config.toml is enough to escape
 *   the sandbox: loadConfig then resolves `personas_dir` from that config normally,
 *   honouring either the default layout OR a custom `personas_dir` the user set.
 *
 *   We deliberately DO NOT set `PHANTOMBOT_PERSONAS_DIR`. That env var is an
 *   absolute override that wins over `personas_dir` in config.toml, so pinning it
 *   would silently break any user who configured a custom persona root — exactly
 *   the regression Kai flagged in review. Leaving it unset lets loadConfig do the
 *   right thing for both default and custom persona roots.
 *
 *   We NEVER clobber an override the user already set explicitly — if
 *   `PHANTOMBOT_CONFIG` is already present in the env, the user (or a wrapper)
 *   chose it on purpose; we leave it alone.
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

/**
 * Given the ambient env, return the env the `phantombot acp` subprocess should be
 * spawned with. Outside a snap this is the input unchanged. Inside a snap we add
 * an absolute `PHANTOMBOT_CONFIG` derived from `$SNAP_REAL_HOME`, so phantombot
 * reads the REAL config.toml instead of the empty redirected one — fixing the
 * exit-2 "no other personas exist" crash. loadConfig then resolves `personas_dir`
 * from that config (default OR custom), so we deliberately leave
 * `PHANTOMBOT_PERSONAS_DIR` unset to avoid overriding a custom persona root.
 *
 * Idempotent + non-destructive: returns a NEW object, never mutates the input,
 * and never overwrites an override the user already set explicitly.
 */
export function snapAwareSpawnEnv(env: EnvMap): EnvMap {
  if (!isSnapConfined(env)) return env;

  const realHome = env.SNAP_REAL_HOME!.trim();
  const next: EnvMap = { ...env };

  // Respect an explicit user override — they chose it on purpose.
  if (!next.PHANTOMBOT_CONFIG || !next.PHANTOMBOT_CONFIG.trim()) {
    next.PHANTOMBOT_CONFIG = configPathFor(realHome);
  }

  return next;
}
