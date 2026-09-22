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
 * The LEGACY host-level dir (`<root>/agent`) is now STRICTLY the migration
 * source (plus the agent dir for a bare persona-less NON-relayed `phantombot
 * __pi` hand-run): every persona-scoped ensure() absorbs from it (below) and
 * NOTHING ever mutates it after the upgrade — in particular the relayed-turn
 * strip NEVER reaches it, because a persona-less RELAYED turn (threat judge,
 * durable-fact extraction — HarnessRequest.persona deliberately undefined)
 * runs on a per-turn EPHEMERAL agent dir instead (harnesses/pi.ts): it carries
 * its key in env and needs no store at all (PR #606 round-5, Robbie).
 *
 * UPGRADE MIGRATION (absorbLegacyNativeAgent, PR #606 rounds 4+5):
 * a persona's first scoped ensure() inherits the legacy dir's state so an
 * upgrade keeps tier-2 (`useLocalConfig`) turns working without re-running
 * Configure→Brain:
 *   - auth.json is copied FILTERED: api_key entries only. A legacy OAUTH
 *     login is deliberately NOT absorbed (round-5, Robbie): the shared file
 *     has no persona attribution — exactly one operator did that interactive
 *     login — and absorbing it into every persona would make the FAIL-CLOSED
 *     oauth abort fire on every persona's first relayed turn (a fleet-wide
 *     outage delivered by the migration itself). The one operator who logged
 *     in re-runs Configure→Brain once; nobody else sees a mystery abort.
 *   - the LOCAL-CONFIG files pi resolves `useLocalConfig` turns from —
 *     settings.json (default model/provider), models.json (custom
 *     providers/models), models-store.json (catalog) — are copied verbatim
 *     (round-5, Kai): without them a pre-upgrade local-config persona keeps
 *     its credential but silently loses its model/provider choice.
 *   - sessions/, skills/, themes/ are NOT absorbed: conversation history and
 *     cosmetics are per-persona by nature and duplicating them per persona
 *     buys nothing the config files don't already cover.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
 * migration source a persona's first ensure() absorbs from. A persona-less
 * RELAYED turn never uses either (harnesses/pi.ts gives it an ephemeral dir).
 */
export function nativeAgentDir(
  dataHome: string = xdgDataHome(),
  persona?: string,
): string {
  return persona
    ? join(nativeAgentRoot(dataHome), "personas", persona, "agent")
    : join(nativeAgentRoot(dataHome), "agent");
}

/** Pi LOCAL-CONFIG files that a persona dir must inherit from the legacy dir
 * so `useLocalConfig` (tier-2) turns keep resolving the same provider/models
 * after the scoping upgrade (PR #606 round-5, Kai): settings.json = default
 * model/provider choice, models.json = custom providers/models,
 * models-store.json = model catalog. auth.json is handled separately
 * (oauth-filtered) in absorbLegacyNativeAgent. */
const LEGACY_AGENT_CONFIG_FILES = ["settings.json", "models.json", "models-store.json"] as const;

/** What absorbLegacyNativeAgent inherited from the legacy dir. */
export interface LegacyAbsorbResult {
  /** True when a (filtered) auth.json was written into the persona store. */
  auth: boolean;
  /** Local-config files copied verbatim (subset of LEGACY_AGENT_CONFIG_FILES). */
  configFiles: string[];
}

/** Copy one legacy agent-dir file into a persona's own dir without clobbering
 * an existing target. Staged write + atomic rename, best-effort (never throws). */
function absorbFileInto(dir: string, dataHome: string, name: string): boolean {
  const legacy = join(nativeAgentDir(dataHome), name);
  const target = join(dir, name);
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

/** Read the legacy auth.json under `dataHome`, drop every OAUTH entry, and
 * return the filtered store — or undefined when there is nothing safe to
 * absorb (no file, or a file phantombot refuses to interpret). An empty
 * result is still a RESULT: the persona never had a stored fallback to
 * inherit, and writing `{}` converges the absorb instead of retrying (and
 * re-failing) every ensure(). */
function filteredLegacyAuth(dataHome: string): Record<string, unknown> | undefined {
  const legacy = join(nativeAgentDir(dataHome), "auth.json");
  if (!existsSync(legacy)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(legacy, "utf8"));
  } catch {
    return undefined; // unparseable: refuse to interpret, retry next ensure()
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined; // not an auth store: refuse, retry next ensure()
  }
  const filtered: Record<string, unknown> = {};
  for (const [provider, entry] of Object.entries(parsed)) {
    // Same oauth test as removePiApiKey (lib/piAuthStore.ts): a login entry
    // is type "oauth" and belongs to the ONE operator who made it — it must
    // not become a stored fallback (or a fail-closed abort) for a persona
    // that never logged in. Everything else is kept verbatim.
    if (entry && typeof entry === "object" && (entry as { type?: unknown }).type === "oauth") {
      continue;
    }
    filtered[provider] = entry;
  }
  return filtered;
}

/**
 * One-time absorb of the LEGACY host-level agent dir into a persona's own
 * scope. Runs inside ensureNativeAgentDir for persona-scoped dirs:
 *  - auth.json, OAUTH-FILTERED (see the module header — round-5, Robbie),
 *  - the local-config files pi resolves `useLocalConfig` turns from,
 *    verbatim (round-5, Kai),
 * each only when the persona doesn't already have that file (a store/config
 * written after the upgrade, or by the wizard, is never clobbered).
 *
 * Best-effort, never throws: a failed copy degrades to "no stored fallback
 * this turn" (the vault-relayed key path is unaffected) rather than blocking
 * a spawn. A subsequent ensure() retries whatever is still missing.
 */
export function absorbLegacyNativeAgent(
  dataHome: string = xdgDataHome(),
  persona: string,
): LegacyAbsorbResult {
  const dir = nativeAgentDir(dataHome, persona);
  const configFiles: string[] = [];
  for (const name of LEGACY_AGENT_CONFIG_FILES) {
    if (absorbFileInto(dir, dataHome, name)) configFiles.push(name);
  }
  // auth.json: filtered copy, only when the persona has no auth.json yet.
  let auth = false;
  const target = join(dir, "auth.json");
  if (!existsSync(target)) {
    const filtered = filteredLegacyAuth(dataHome);
    if (filtered !== undefined) {
      const staged = `${target}.absorb-${process.pid}.tmp`;
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(staged, JSON.stringify(filtered, null, 2) + "\n", "utf8");
        renameSync(staged, target);
        auth = true;
      } catch {
        try {
          unlinkSync(staged);
        } catch {
          /* nothing to clean up */
        }
      }
    }
  }
  return { auth, configFiles };
}

/** Create the agent dir if missing and return it. Synchronous on purpose:
 * every caller is about to hand the path to a child env or a file write.
 * Persona-scoped callers also absorb the legacy agent dir (above).
 */
export function ensureNativeAgentDir(
  dataHome: string = xdgDataHome(),
  persona?: string,
): string {
  const dir = nativeAgentDir(dataHome, persona);
  mkdirSync(dir, { recursive: true });
  if (persona) absorbLegacyNativeAgent(dataHome, persona);
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