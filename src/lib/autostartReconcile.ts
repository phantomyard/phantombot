/**
 * Autostart reconciler — make the recorded autostart config match observable
 * reality, once, at startup.
 *
 * The TUI presents autostart as two axes:
 *
 *   on | off      does the daemon start this persona at all?
 *                 → `servedPersonasOf` = default_persona + autostart_personas
 *   login | boot  when it does start, does it need a login first?
 *                 → the `[autostart_modes]` record for that persona
 *
 * Both axes are read from config, so config that has drifted from reality
 * makes the selector LIE — a persona that no longer exists still holds an
 * autostart slot, a served persona with no mode record renders Off, a `boot`
 * record survives the LaunchDaemon it described. #509/#511/#512/#513 each
 * fixed one facet of that at the display layer; this module fixes the data.
 *
 * MIRROR-ONLY DOCTRINE — the load-bearing safety property. Reconciliation
 * reads the platform and writes CONFIG. It never enables, disables, installs
 * or removes a unit, a task, a plist, a linger flag or a login hook. The
 * worst case for a wrong reconciliation is therefore a wrong LABEL, which the
 * next operator action overwrites — never a machine that stops booting the
 * agent. Keep it that way: if you find yourself importing a mutator from
 * autostartBoot.ts, you are in the wrong module.
 *
 * That doctrine is exactly why Linux mode records are never inferred here.
 * On Linux a `boot` record is not just a label: it is the teardown authority
 * (autostartBoot.ts), so switching a persona to Login/Off later disables the
 * daemon unit. `systemctl --user is-enabled` is TRUE on every standard
 * install because the installer enables it unconditionally, so inferring
 * `boot` from it would arm that teardown against state phantombot never
 * chose — the #509 review blocker. Linux keeps records-only semantics:
 * missing records are backfilled as `login` (the conservative label, and the
 * pre-#509 behaviour), and an existing record is left alone. macOS and
 * Windows probes DO carry provenance (our own plist / our own password-mode
 * task), so there both directions are inferable.
 *
 * The planner is pure and total: it takes a snapshot of facts and returns the
 * writes to make. Every rule below is testable without a filesystem, a
 * daemon, or a platform, which is the only way "bulletproof" is checkable.
 */

import type { Config } from "../config.ts";
import { log } from "./logger.ts";

export type AutostartMode = "login" | "boot";

/** Everything the planner is allowed to know. No I/O below this line. */
export interface AutostartFacts {
  /** Persona directories that actually exist. Empty means "could not read". */
  personasOnDisk: readonly string[];
  /** The resolved host default persona, if any. */
  defaultPersona?: string;
  /**
   * Where the default came from. "builtin" is the bare fallback name on a
   * host that configured nothing — it is NOT a choice, so it is never treated
   * as served and never backfilled a mode record.
   */
  defaultProvenance: "env" | "state" | "config" | "builtin";
  /** `autostart_personas` exactly as configured, order preserved. */
  autostartPersonas: readonly string[];
  /** `[autostart_modes]` exactly as configured. */
  autostartModes: Readonly<Record<string, AutostartMode>>;
  /**
   * Per-persona boot probe. `true`/`false` is a provenance-carrying answer
   * (macOS plist, Windows password-mode task); `undefined` means "this
   * platform cannot tell a Boot choice from an installer default" — Linux,
   * and any probe that threw. Undefined NEVER overrides a record.
   */
  bootProbe: Readonly<Record<string, boolean | undefined>>;
}

export interface ModeChange {
  persona: string;
  from?: AutostartMode;
  /** `undefined` means "delete this record". */
  to?: AutostartMode;
  reason: string;
}

export interface AutostartPlan {
  /** True when the recorded default names no persona that exists on disk. */
  healDefaultPersona: boolean;
  /** Set only when the list needs rewriting. */
  autostartPersonas?: { from: readonly string[]; to: string[]; reason: string };
  modes: ModeChange[];
  /** Nothing to do — the common case on a healthy host. */
  empty: boolean;
}

/** Which personas the daemon serves, given a set of facts. */
function servedFrom(facts: AutostartFacts, list: readonly string[]): string[] {
  const served: string[] = [];
  // A "builtin" default is a fallback name, not a choice: on a host that
  // configured nothing it may not even exist on disk, and inventing autostart
  // records for it would be fabricating a decision the operator never made.
  if (facts.defaultProvenance !== "builtin" && facts.defaultPersona) {
    served.push(facts.defaultPersona);
  }
  for (const name of list) if (!served.includes(name)) served.push(name);
  return served;
}

/**
 * Compute the config writes that would make autostart match reality.
 *
 * Pure. Total. Idempotent by construction: applying the plan and re-planning
 * on the result yields an empty plan, which the test suite asserts on every
 * case rather than trusting this sentence.
 */
export function planAutostartReconcile(facts: AutostartFacts): AutostartPlan {
  const plan: AutostartPlan = { healDefaultPersona: false, modes: [], empty: true };

  // GUARD: an empty persona list is ambiguous — a genuinely empty install and
  // an unreadable personas dir look identical from here, and the destructive
  // reading of the second is "delete every autostart record on the host".
  // Reconciliation is a convenience; refusing to act on a fact we do not have
  // costs one stale label until the next start.
  if (facts.personasOnDisk.length === 0) return plan;

  const exists = (name: string): boolean => facts.personasOnDisk.includes(name);

  // ── default_persona ──────────────────────────────────────────────────────
  // Only flagged, never chosen here: healDefaultPersonaIfBroken already owns
  // the choice (case-variant match, then the operator-explicit config layer,
  // then alphabetical) and is the single writer of state.json. An env-pinned
  // default is the operator speaking in the loudest layer there is; a broken
  // one is their problem to see, not ours to silently overwrite.
  if (
    facts.defaultProvenance !== "env" &&
    facts.defaultProvenance !== "builtin" &&
    facts.defaultPersona !== undefined &&
    !exists(facts.defaultPersona)
  ) {
    plan.healDefaultPersona = true;
    plan.empty = false;
  }

  // ── autostart_personas ───────────────────────────────────────────────────
  // Prune names with no persona directory, and de-duplicate. Both are pure
  // subtraction: nothing is ever ADDED to this list by reconciliation, so a
  // persona can never start booting because of a repair. Order of survivors
  // is preserved so a repair reads as a deletion in the user's config.toml,
  // not a reshuffle.
  const prunedList: string[] = [];
  for (const name of facts.autostartPersonas) {
    if (!exists(name)) continue;
    if (prunedList.includes(name)) continue;
    prunedList.push(name);
  }
  const listChanged =
    prunedList.length !== facts.autostartPersonas.length ||
    prunedList.some((n, i) => n !== facts.autostartPersonas[i]);
  if (listChanged) {
    const dropped = facts.autostartPersonas.filter((n) => !prunedList.includes(n));
    plan.autostartPersonas = {
      from: facts.autostartPersonas,
      to: prunedList,
      reason: dropped.length
        ? `autostart_personas named personas that do not exist: ${[...new Set(dropped)].join(", ")}`
        : "autostart_personas contained duplicate entries",
    };
    plan.empty = false;
  }

  // ── [autostart_modes] ────────────────────────────────────────────────────
  // Served is computed from the PRUNED list: a record must never be
  // backfilled for a persona this same plan is about to remove.
  const served = servedFrom(facts, prunedList).filter(exists);

  for (const [persona, mode] of Object.entries(facts.autostartModes)) {
    // Records for personas that no longer exist are pure noise: nothing can
    // display them and nothing can act on them. This is the one deletion, and
    // it is gated on the same existence fact as the list prune.
    if (!exists(persona)) {
      plan.modes.push({
        persona,
        from: mode,
        reason: "no persona directory — stale mode record",
      });
      continue;
    }
    // A record that CONTRADICTS a provenance-carrying probe is a lie about
    // the machine. Only macOS/Windows get here; on Linux the probe is
    // undefined and an existing record is authoritative by doctrine.
    const probe = facts.bootProbe[persona];
    if (probe === undefined) continue;
    const observed: AutostartMode = probe ? "boot" : "login";
    if (observed !== mode) {
      plan.modes.push({
        persona,
        from: mode,
        to: observed,
        reason:
          observed === "boot"
            ? "platform starts this persona without a login, but the record said login"
            : "recorded boot, but no boot-level job exists for this persona",
      });
    }
  }

  // Backfill: every SERVED persona needs a record, or the selector renders it
  // Off — a persona the daemon demonstrably starts, labelled as not starting
  // (#512). Per-persona, not all-or-nothing: the previous one-shot migration
  // was gated on the table being entirely empty, so a host that recorded one
  // persona left every later one unlabelled forever.
  for (const persona of served) {
    if (persona in facts.autostartModes) continue;
    const probe = facts.bootProbe[persona];
    plan.modes.push({
      persona,
      to: probe === true ? "boot" : "login",
      reason:
        probe === true
          ? "served with no mode record; platform starts it without a login"
          : "served with no mode record; login is the conservative label",
    });
  }

  if (plan.modes.length > 0) plan.empty = false;
  return plan;
}

/** Human-readable one-liner per write, for the log and for `doctor`. */
export function describeAutostartPlan(plan: AutostartPlan): string[] {
  const lines: string[] = [];
  if (plan.healDefaultPersona) {
    lines.push("default_persona: names a persona that does not exist — healing");
  }
  if (plan.autostartPersonas) {
    lines.push(
      `autostart_personas: [${plan.autostartPersonas.from.join(", ")}] -> [${plan.autostartPersonas.to.join(", ")}] (${plan.autostartPersonas.reason})`,
    );
  }
  for (const m of plan.modes) {
    lines.push(
      `autostart_modes.${m.persona}: ${m.from ?? "(none)"} -> ${m.to ?? "(removed)"} (${m.reason})`,
    );
  }
  return lines;
}

/** Gather the facts for the running host. All the I/O lives here. */
export async function collectAutostartFacts(
  config: Config,
  opts?: {
    /** Test seam: per-persona boot probe. Undefined result = no signal. */
    bootProbe?: (persona: string) => Promise<boolean | undefined>;
    platform?: "linux" | "darwin" | "windows" | "unsupported";
  },
): Promise<AutostartFacts> {
  const { listPersonaDirs, defaultPersonaProvenance } = await import("./personaDefault.ts");
  const { currentPlatform } = await import("./platform.ts");
  const platform = opts?.platform ?? currentPlatform();
  const personasOnDisk = listPersonaDirs(config);

  const probe = async (persona: string): Promise<boolean | undefined> => {
    // Linux cannot distinguish a Boot choice from the installer's
    // unconditionally-enabled unit, so it reports NO SIGNAL rather than
    // `false` — a `false` here would rewrite operator-chosen `boot` records
    // to `login` on every start.
    //
    // Checked BEFORE the test seam on purpose: this is the #509 doctrine, not
    // a default, so an injected probe must not be able to smuggle a `boot`
    // inference onto Linux. A test that wants probe results sets `platform`
    // as well, which is honest — that IS the platform-conditional behaviour.
    if (platform === "linux") return undefined;
    if (opts?.bootProbe) return opts.bootProbe(persona);
    try {
      const m = await import("./autostartBoot.ts");
      return await m.probeBootState(persona, {});
    } catch {
      return undefined; // an unreadable probe must never overwrite a record
    }
  };

  const autostartPersonas = config.autostartPersonas ?? [];
  const autostartModes = (config.autostartModes ?? {}) as Record<string, AutostartMode>;
  // Probe every persona a rule could consult: those already recorded, those
  // on the list, and the default.
  const interesting = new Set<string>([
    ...Object.keys(autostartModes),
    ...autostartPersonas,
    ...(config.defaultPersona ? [config.defaultPersona] : []),
  ]);
  const bootProbe: Record<string, boolean | undefined> = {};
  for (const persona of interesting) {
    if (!personasOnDisk.includes(persona)) continue; // never probe a ghost
    bootProbe[persona] = await probe(persona);
  }

  return {
    personasOnDisk,
    ...(config.defaultPersona ? { defaultPersona: config.defaultPersona } : {}),
    defaultProvenance: await defaultPersonaProvenance(config),
    autostartPersonas,
    autostartModes,
    bootProbe,
  };
}

/**
 * Collect, plan, apply. Silent when there is nothing to do, best-effort when
 * there is: a host whose config.toml is read-only is exactly the host this
 * repair exists for, and it must still start.
 *
 * Returns the plan that was applied (or attempted), for tests and for callers
 * that want to report it.
 */
export async function reconcileAutostart(
  config: Config,
  opts?: {
    bootProbe?: (persona: string) => Promise<boolean | undefined>;
    platform?: "linux" | "darwin" | "windows" | "unsupported";
    /** Plan and report only — used by `doctor`, which never repairs. */
    dryRun?: boolean;
  },
): Promise<AutostartPlan> {
  const facts = await collectAutostartFacts(config, opts);
  const plan = planAutostartReconcile(facts);
  if (plan.empty || opts?.dryRun) return plan;

  const { healDefaultPersonaIfBroken, writeAutostartMode, writeAutostartPersonas, configLayerDefaultPersona } =
    await import("./personaDefault.ts");

  // Order matters: heal the default FIRST. It is the only change that can
  // alter which personas are served, and every later write is derived from a
  // list this plan already pruned.
  if (plan.healDefaultPersona) {
    try {
      const healed = await healDefaultPersonaIfBroken(
        config,
        undefined,
        await configLayerDefaultPersona(config),
      );
      if (healed) config.defaultPersona = healed;
    } catch (err) {
      log.warn("autostart reconcile: default_persona heal failed", { error: String(err) });
    }
  }
  if (plan.autostartPersonas) {
    try {
      await writeAutostartPersonas(config, plan.autostartPersonas.to);
    } catch (err) {
      log.warn("autostart reconcile: autostart_personas write failed", { error: String(err) });
    }
  }
  for (const change of plan.modes) {
    try {
      await writeAutostartMode(config, change.persona, change.to);
    } catch (err) {
      log.warn("autostart reconcile: autostart_modes write failed", {
        persona: change.persona,
        error: String(err),
      });
    }
  }
  log.warn("autostart reconcile: repaired autostart config", {
    changes: describeAutostartPlan(plan),
  });
  return plan;
}
