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
 * The LEGACY host-level dir (`<root>/agent`) is now the migration source
 * (plus the agent dir for a bare persona-less NON-relayed `phantombot __pi`
 * hand-run): every persona-scoped ensure() absorbs from it (below). The
 * LEGACY auth/config files are never mutated after the upgrade — in
 * particular the relayed-turn strip NEVER reaches them, because a
 * persona-less RELAYED turn (threat judge, durable-fact extraction —
 * HarnessRequest.persona deliberately undefined) runs on a per-turn EPHEMERAL
 * agent dir instead (harnesses/pi.ts): it carries its key in env and needs no
 * stored credential at all (PR #606 round-5, Robbie). The one deliberate
 * exception is the managed capability-routing EXTENSION stamp
 * (piExtensionProvision writes into the legacy dir's extensions/ on native
 * turns) — state the migration never touches, and exactly what the
 * `--extension` hand-off needs. (PR #606 round-7, Robbie: the module header
 * previously claimed the legacy dir was STRICTLY read-only; narrowed to the
 * files the migration cares about.)
 *
 * RELAYED TURNS SKIP THE AUTH ABSORB (PR #606 round-7, Robbie/Kai): a
 * relayed turn's pre-spawn strip (harnesses/pi.ts) removes the relayed
 * provider's entry from the persona's own store — if that same turn had just
 * absorbed the legacy auth.json, the strip would consume the migrated
 * credential and the absorb's "already migrated" test (target file exists)
 * would then block the first tier-2 turn from ever inheriting it. With the
 * issue-#609 sentinel the strip now ALSO deletes the marker, so the loss is
 * no longer permanent — but the skip stays: it keeps relayed turns from
 * pointless write+strip churn and preserves the reviewed behavior. So
 * ensure()/absorb() take an `absorbAuth: false` option, the harness passes it
 * on relayed turns, and the first genuinely tier-2 turn does the migration
 * intact. Local-config files still absorb on relayed turns — no strip touches
 * those, and a turn that never runs cannot leave config half-migrated.
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

/** Sentinel file (written into the persona agent dir) marking the legacy
 * auth.json migration as CONVERGED (issue #609). The persona store's own
 * existence used to carry that meaning, but the relayed-turn strip empties
 * the store one entry at a time and the `{}` it leaves behind is
 * indistinguishable from an unmigrated store — "target exists" then blocked
 * the re-absorb forever. The marker is the ONLY convergence signal, and the
 * strip (removePiApiKey, lib/piAuthStore.ts) deletes it whenever it removes
 * an entry, so a stripped store always becomes re-absorbable on the next
 * ensure(). */
export const LEGACY_ABSORBED_MARKER = ".legacy-absorbed";

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

/** Options for ensure()/absorb()/nativeAgentEnv(). */
export interface NativeAgentDirOptions {
  /** Set `false` on a RELAYED turn (harnesses/pi.ts): skip the legacy
   * auth.json absorb — the pre-spawn strip would empty the migrated entry
   * this same turn (round-7, Robbie/Kai). The issue-#609 marker makes that
   * loss recoverable (the strip deletes the marker too), but the skip still
   * avoids write+strip churn on every relayed turn.
   * Local-config files are still absorbed; default `true`. */
  absorbAuth?: boolean;
}

/** Copy one legacy agent-dir file into a persona's own dir without clobbering
 * an existing target. Staged write + atomic rename, best-effort (never throws). */
function absorbFileInto(dir: string, dataHome: string, name: string): boolean {
  const legacy = join(nativeAgentDir(dataHome), name);
  const target = join(dir, name);
  if (!existsSync(legacy) || existsSync(target)) return false;
  const staged = `${target}.absorb-${process.pid}.tmp`;
  try {
    // Explicit 0700 (umask-masked, so it survives a 0002 umask): the dir holds
    // credential and model-config files — group-writable would let another
    // local user unlink/substitute them (round-7, Kai/Robbie).
    mkdirSync(dir, { recursive: true, mode: 0o700 });
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

/** Best-effort write of the legacy-absorb sentinel (issue #609). Never
 * throws: a failed marker write only costs a redundant legacy re-read (the
 * merge is idempotent) on the next ensure(). */
function markLegacyAuthAbsorbed(dir: string): void {
  try {
    writeFileSync(
      join(dir, LEGACY_ABSORBED_MARKER),
      "Written by phantombot (absorbLegacyNativeAgent): the legacy auth.json " +
        "migration has converged. Deleted automatically whenever the " +
        "relayed-turn strip removes a store entry, so the next ensure() " +
        "re-absorbs.\n",
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    /* best-effort */
  }
}

/** Merge the (filtered) legacy providers a persona store is MISSING into a
 * copy of that store — the restore path for a store the relayed-turn strip
 * has emptied or thinned (issue #609). Never overwrites an existing entry
 * (the persona's own / wizard-written choice always wins). Returns undefined
 * when the target is unparseable or not a JSON object: unknown state is
 * refused, not clobbered, and the absorb retries on the next ensure(). */
function mergeMissingLegacyProviders(
  targetPath: string,
  filtered: Record<string, unknown>,
): { store: Record<string, unknown>; added: number } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(targetPath, "utf8"));
  } catch {
    return undefined; // unparseable: refuse, retry next ensure()
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined; // not an auth store: refuse, retry next ensure()
  }
  const store = { ...(parsed as Record<string, unknown>) };
  let added = 0;
  for (const [provider, entry] of Object.entries(filtered)) {
    if (!(provider in store)) {
      store[provider] = entry;
      added += 1;
    }
  }
  return { store, added };
}

/**
 * One-time absorb of the LEGACY host-level agent dir into a persona's own
 * scope. Runs inside ensureNativeAgentDir for persona-scoped dirs:
 *  - auth.json, OAUTH-FILTERED (see the module header — round-5, Robbie),
 *  - the local-config files pi resolves `useLocalConfig` turns from,
 *    verbatim (round-5, Kai),
 * each only when the persona doesn't already have that file (a store/config
 * written after the upgrade, or by the wizard, is never clobbered). auth.json
 * is additionally gated on the LEGACY_ABSORBED_MARKER sentinel (issue #609)
 * at PROVIDER level: an existing store only inherits the legacy providers
 * it is MISSING, so a store the relayed-turn strip emptied or thinned is
 * re-absorbed while the persona's own entries stay untouched.
 *
 * Best-effort, never throws: a failed copy degrades to "no stored fallback
 * this turn" (the vault-relayed key path is unaffected) rather than blocking
 * a spawn. A subsequent ensure() retries whatever is still missing.
 */
export function absorbLegacyNativeAgent(
  dataHome: string = xdgDataHome(),
  persona: string,
  opts?: NativeAgentDirOptions,
): LegacyAbsorbResult {
  const dir = nativeAgentDir(dataHome, persona);
  const configFiles: string[] = [];
  for (const name of LEGACY_AGENT_CONFIG_FILES) {
    if (absorbFileInto(dir, dataHome, name)) configFiles.push(name);
  }
  // auth.json (issue #609): gated on the SENTINEL marker, never on the
  // target file's existence — the relayed-turn strip empties a migrated store
  // entry by entry, and the `{}` it leaves behind must stay re-absorbable.
  // SKIPPED ENTIRELY on a relayed turn (absorbAuth: false, round-7): this
  // turn's strip would empty the entry the absorb just wrote. With the marker
  // the strip also deletes the marker, so the loss is no longer permanent —
  // but the skip still keeps relayed turns from write+strip churn.
  let auth = false;
  const target = join(dir, "auth.json");
  if (opts?.absorbAuth !== false && !existsSync(join(dir, LEGACY_ABSORBED_MARKER))) {
    const filtered = filteredLegacyAuth(dataHome);
    if (filtered !== undefined) {
      const writeStore = (store: Record<string, unknown>): boolean => {
        const staged = `${target}.absorb-${process.pid}.tmp`;
        try {
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          // Explicit 0600: the copied store holds live API keys, so the file
          // must not inherit the process umask (round-6, Kai — a 0002 umask
          // would otherwise land it at 0664). rename() preserves the staged
          // mode, so the final auth.json is 0600 too.
          writeFileSync(staged, JSON.stringify(store, null, 2) + "\n", {
            encoding: "utf8",
            mode: 0o600,
          });
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
      };
      // Converged = the migration decision is final for this legacy store:
      // either the store was written, or the persona's existing store already
      // covers every legacy provider. A failed write or an uninterpretable
      // target stays UNconverged and retries on the next ensure().
      let converged = false;
      if (!existsSync(target)) {
        auth = writeStore(filtered);
        converged = auth;
      } else {
        const merged = mergeMissingLegacyProviders(target, filtered);
        if (merged) {
          if (merged.added > 0) {
            auth = writeStore(merged.store);
            converged = auth;
          } else {
            converged = true; // persona store already covers the legacy set
          }
        }
        // merged === undefined: unparseable / not a JSON object — refuse to
        // clobber unknown state, no marker, retry next ensure().
      }
      if (converged) markLegacyAuthAbsorbed(dir);
    }
  }
  return { auth, configFiles };
}

/** Create the agent dir if missing and return it. Synchronous on purpose:
 * every caller is about to hand the path to a child env or a file write.
 * Persona-scoped callers also absorb the legacy agent dir (above) — pass
 * `absorbAuth: false` on a RELAYED turn (see NativeAgentDirOptions).
 *
 * The created directories get an explicit 0700 mode (umask-masked): they hold
 * credential and model-config files, and a group-writable dir would let
 * another local user unlink/substitute them even when the files themselves
 * are 0600 (round-7, Kai/Robbie).
 */
export function ensureNativeAgentDir(
  dataHome: string = xdgDataHome(),
  persona?: string,
  opts?: NativeAgentDirOptions,
): string {
  const dir = nativeAgentDir(dataHome, persona);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (persona) absorbLegacyNativeAgent(dataHome, persona, opts);
  return dir;
}

/** Copy the LEGACY local-config files (settings.json / models.json /
 * models-store.json) into a fresh per-turn EPHEMERAL agent dir
 * (harnesses/pi.ts), best-effort, never clobbering what is already there.
 *
 * Why a persona-less relayed turn needs config at all (round-7, Robbie
 * non-blocking 2): it pins `--provider`/`--model` explicitly and carries its
 * key in env, so it never needs auth.json — but a host may define its judge
 * routing model through a CUSTOM models.json provider, and the ephemeral dir
 * is otherwise empty. Seeding the host-level config (the same files that
 * governed these turns pre-upgrade, when they ran on the legacy dir) keeps
 * custom model resolution working without inheriting any credential. */
export function seedEphemeralAgentConfig(
  dir: string,
  dataHome: string = xdgDataHome(),
): void {
  for (const name of LEGACY_AGENT_CONFIG_FILES) {
    const legacy = join(nativeAgentDir(dataHome), name);
    const target = join(dir, name);
    if (!existsSync(legacy) || existsSync(target)) continue;
    try {
      copyFileSync(legacy, target);
    } catch {
      /* best-effort: a config that can't be seeded degrades to pi defaults */
    }
  }
}

/**
 * Child-env fragment isolating the embedded engine. ALWAYS fresh values —
 * callers spread this into an env object; nobody should hold it long-term.
 */
export function nativeAgentEnv(
  dataHome: string = xdgDataHome(),
  persona?: string,
  opts?: NativeAgentDirOptions,
): Record<string, string> {
  return { [ENV_PI_AGENT_DIR]: ensureNativeAgentDir(dataHome, persona, opts) };
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