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
 * PERSONA SCOPING (PR #606 review, Kai/Robbie): the agent dir is PER-PERSONA —
 * `personas/<persona>/agent` under the native root — because its auth.json
 * holds PER-PERSONA state (the provider key a wizard wrote, an oauth login the
 * operator made). One shared file made every persona's credential decide every
 * other persona's turns: a relayed turn's strip deleted a sibling's tier-2
 * fallback, one persona's oauth login aborted every other persona's relayed
 * turns, and last-onboarded silently won billing. Each persona now resolves
 * (and strips) only its own store; the managed extension is handed to the
 * child explicitly via pi's `--extension` flag, so it stays stamped ONCE at
 * the host level (piExtensionProvision) instead of per persona.
 *
 * The LEGACY host-level dir (`<root>/agent`) remains for contexts with no
 * persona (a bare `phantombot __pi` hand-run) and as the MIGRATION SOURCE:
 * the first persona-scoped ensure() absorbs a legacy auth.json into that
 * persona's own store (absorbLegacyNativeAuth), so an upgrade keeps every
 * tier-2 fallback working without anyone re-running Configure→Brain.
 */

import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { xdgDataHome } from "../config.ts";

/** Pi's own env var for relocating its agent dir (pi config.js ENV_AGENT_DIR). */
export const ENV_PI_AGENT_DIR = "PI_CODING_AGENT_DIR";

/** The phantombot-owned root for the embedded engine's files. */
export function nativeAgentRoot(dataHome: string = xdgDataHome()): string {
  return join(dataHome, "pi-native");
}

/** The agent dir the embedded pi sees as "its" `~/.pi/agent`.
 *
 * PER-PERSONA when a persona is given (`personas/<persona>/agent`): auth.json
 * is per-persona state (PR #606 review). Without a persona — a bare
 * `phantombot __pi` hand-run — the LEGACY host-level dir, which is also the
 * migration source a persona's first ensure() absorbs from.
 */
export function nativeAgentDir(
  dataHome: string = xdgDataHome(),
  persona?: string,
): string {
  return persona
    ? join(nativeAgentRoot(dataHome), "personas", persona, "agent")
    : join(nativeAgentRoot(dataHome), "agent");
}

/**
 * One-time absorb of the LEGACY host-level auth.json into a persona's own
 * store. Runs inside ensureNativeAgentDir for persona-scoped dirs: if the
 * persona has no auth.json yet and the pre-persona-scoping shared store does,
 * copy it verbatim (oauth logins included — the shared store is exactly what
 * every persona resolved against before this change, so absorbing it preserves
 * the upgrade-time status quo per persona; PR #606 review, Robbie's "safely
 * preserve B's credential"). After the absorb, each persona's store diverges
 * honestly: relayed turns strip their OWN entry, tier-2 keeps its own.
 *
 * Best-effort, never throws: a failed copy degrades to "no stored fallback
 * this turn" (the vault-relayed key path is unaffected) rather than blocking
 * a spawn. A subsequent ensure() retries.
 */
export function absorbLegacyNativeAuth(
  dataHome: string = xdgDataHome(),
  persona: string,
): boolean {
  const legacy = join(nativeAgentDir(dataHome), "auth.json");
  const dir = nativeAgentDir(dataHome, persona);
  const target = join(dir, "auth.json");
  if (!existsSync(legacy) || existsSync(target)) return false;
  const staged = `${target}.absorb-${process.pid}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    copyFileSync(legacy, staged);
    renameSync(staged, target);
    return true;
  } catch {
    try {
      unlinkSync(staged);
    } catch {
      /* nothing to clean up */
    }
    return false;
  }
}

/** Create the agent dir if missing and return it. Synchronous on purpose:
/** every caller is about to hand the path to a child env or a file write.
 * Persona-scoped callers also absorb the legacy shared auth.json (above).
 */
export function ensureNativeAgentDir(
  dataHome: string = xdgDataHome(),
  persona?: string,
): string {
  const dir = nativeAgentDir(dataHome, persona);
  mkdirSync(dir, { recursive: true });
  if (persona) absorbLegacyNativeAuth(dataHome, persona);
  return dir;
}

/**
 * Child-env fragment isolating the embedded engine. ALWAYS fresh values —
 * callers spread this into an env object; nobody should hold it long-term.
 */
export function nativeAgentEnv(
  dataHome: string = xdgDataHome(),
  persona?: string,
): Record<string, string> {
  return { [ENV_PI_AGENT_DIR]: ensureNativeAgentDir(dataHome, persona) };
}

/** auth.json INSIDE the (persona-scoped when given) agent dir. */
export function nativeAuthPath(
  dataHome: string = xdgDataHome(),
  persona?: string,
): string {
  return join(nativeAgentDir(dataHome, persona), "auth.json");
}

/** Managed extension dir. Deliberately HOST-level even for persona dirs: the
 * extension is stamped once (piExtensionProvision) and handed to each persona
 * child explicitly via pi's `--extension` flag (harnesses/pi.ts) — the child's
 * persona-scoped agent dir carries only its OWN auth, never a copy of the
 * managed stamp. */
export function nativeExtensionsDir(dataHome: string = xdgDataHome()): string {
  return join(nativeAgentDir(dataHome), "extensions");
}