/**
 * Filesystem isolation for the NATIVE (embedded) pi engine.
 *
 * Native mode must NEVER touch the user's own `~/.pi` — not to read keys, not
 * to write auth, not to stamp extensions. Two directions of breakage forced
 * this (2026-09-13, Atlas): a user who deletes their pi install and `~/.pi`
 * took native mode's only API key with it, and the embedded engine recreated
 * `~/.pi/agent/auth.json` + `models-store.json` behind the user's back. Both
 * are the same root cause: the embedded engine shared the host pi's agent dir.
 *
 * The fix is one environment variable. Pi resolves EVERYTHING user-owned
 * (auth.json, models-store.json, settings, themes, extensions) through
 * `getAgentDir()`, which honours `PI_CODING_AGENT_DIR` (pi's own
 * `ENV_AGENT_DIR`, config.js). Native mode sets it to a phantombot-owned
 * directory; the host's pi (`pi-host`) never gets it and keeps `~/.pi/agent`.
 *
 * Every native side door must go through HERE:
 *   - the harness child env (harnesses/pi.ts),
 *   - `--list-models` spawned for the embedded engine (piModels callers),
 *   - auth-store writes the wizards make for native (piAuthStore),
 *   - the managed capability-routing extension dir (piExtensionProvision).
 *
 * The directory is HOST-level (one per machine, not per persona): persona
 * state that varies per turn (delegate models, the API key) travels per-turn
 * via env (`PHANTOMBOT_ROUTING_JSON`, the provider's native key var — issue
 * #602), never via files here.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { xdgDataHome } from "../config.ts";

/** Pi's own env var for relocating its agent dir (pi config.js ENV_AGENT_DIR). */
export const ENV_PI_AGENT_DIR = "PI_CODING_AGENT_DIR";

/** The phantombot-owned root for the embedded engine's files. */
export function nativeAgentRoot(dataHome: string = xdgDataHome()): string {
  return join(dataHome, "pi-native");
}

/** The agent dir the embedded pi sees as "its" `~/.pi/agent`. */
export function nativeAgentDir(dataHome: string = xdgDataHome()): string {
  return join(nativeAgentRoot(dataHome), "agent");
}

/** Create the agent dir if missing and return it. Synchronous on purpose: */
/** every caller is about to hand the path to a child env or a file write. */
export function ensureNativeAgentDir(dataHome: string = xdgDataHome()): string {
  const dir = nativeAgentDir(dataHome);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Child-env fragment isolating the embedded engine. ALWAYS fresh values —
 * callers spread this into an env object; nobody should hold it long-term.
 */
export function nativeAgentEnv(dataHome: string = xdgDataHome()): Record<string, string> {
  return { [ENV_PI_AGENT_DIR]: ensureNativeAgentDir(dataHome) };
}

/** auth.json INSIDE the isolated agent dir (what native reads and wizards write). */
export function nativeAuthPath(dataHome: string = xdgDataHome()): string {
  return join(nativeAgentDir(dataHome), "auth.json");
}

/** Managed extension dir inside the isolated agent dir. */
export function nativeExtensionsDir(dataHome: string = xdgDataHome()): string {
  return join(nativeAgentDir(dataHome), "extensions");
}