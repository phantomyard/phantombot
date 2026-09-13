/**
 * The ONE legacy-`pi` reconcile pass (native harness).
 *
 * Before the native harness there was a single `pi` harness id. It meant two
 * different things depending on config: "phantombot drives pi's provider and
 * models" (`[harnesses.pi.routing]` present) or "pi decides for itself" (no
 * routing, or the `use_local_config` opt-out). Those are now two ids:
 *
 *   native   — the pi engine EMBEDDED in the phantombot binary, with
 *              phantombot-managed provider + model routing. Always available.
 *   pi-host  — the user's own installed `pi`, configured by the user exactly
 *              like claude and codex. Only offered when pi is installed.
 *
 * This module decides what a legacy `pi` becomes. It is deliberately a single
 * pure function with injected facts, because it has TWO callers that must never
 * disagree:
 *
 *   1. `loadConfig` (read time, every startup). Maps legacy ids IN MEMORY and
 *      never writes, so a host that upgrades and never runs doctor still serves.
 *      It does not probe the filesystem, so `hostPiInstalled` is `undefined`
 *      ("unknown") there — and unknown preserves the pre-upgrade behaviour: a
 *      legacy pi without routing kept running the host pi, so it maps to
 *      `pi-host`.
 *   2. `phantombot doctor` (repair on). Runs the same decision WITH a live
 *      binary probe and writes the result into config.toml (backup first).
 *      Knowing pi is absent lets it repair a routing-less legacy pi to `native`
 *      — nothing else could ever have served that entry.
 *
 * Decision table (legacy `pi` only):
 *   routing configured                         -> native
 *   no routing, host pi known to be ABSENT      -> native   (repair)
 *   no routing, host pi present OR unknown      -> pi-host
 *
 * Everything else is a no-op, and that includes the most common config of all:
 * a claude-only or codex-only chain. No pi/native/pi-host anywhere is a NORMAL
 * state — this pass never adds `native` to a chain and never warns about it.
 *
 * Idempotent by construction: its output contains no legacy ids, so a second
 * pass finds nothing to change and reports zero changes (doctor then writes
 * nothing, leaving the file byte-identical).
 */

import type { TomlObject } from "./configWriter.ts";
import { ROUTING_LOCAL_CONFIG_KEY } from "./piRouting.ts";

export const NATIVE_HARNESS_ID = "native";
export const PI_HOST_HARNESS_ID = "pi-host";
export const LEGACY_PI_HARNESS_ID = "pi";

/** What a pi-engine harness slot is: embedded (native) or the host's pi. */
export type PiEngineType = typeof NATIVE_HARNESS_ID | typeof PI_HOST_HARNESS_ID;

export interface LegacyPiFacts {
  /** Does this slot have phantombot-managed routing (and no local opt-out)? */
  routingConfigured: boolean;
  /**
   * Is a host `pi` binary installed? `undefined` = not probed (read time).
   * Only a definite `false` may repair a routing-less legacy pi to native.
   */
  hostPiInstalled?: boolean;
}

/** The single decision. See the module doc for the table. */
export function decideLegacyPi(facts: LegacyPiFacts): PiEngineType {
  if (facts.routingConfigured) return NATIVE_HARNESS_ID;
  if (facts.hostPiInstalled === false) return NATIVE_HARNESS_ID;
  return PI_HOST_HARNESS_ID;
}

/** Is this a pi-engine instance type, legacy or current? */
export function isPiEngineType(type: unknown): type is PiEngineType | "pi" {
  return (
    type === NATIVE_HARNESS_ID ||
    type === PI_HOST_HARNESS_ID ||
    type === LEGACY_PI_HARNESS_ID
  );
}

/**
 * Does a raw `routing` TOML table (or resolved routing object) count as
 * "phantombot-managed routing"? Any model or provider stated, and no
 * `use_local_config` opt-out. Accepts both the TOML snake_case keys and the
 * resolved camelCase fields so read time and doctor share it.
 */
export function routingIsConfigured(routing: unknown): boolean {
  if (!routing || typeof routing !== "object" || Array.isArray(routing)) {
    return false;
  }
  const r = routing as Record<string, unknown>;
  if (r[ROUTING_LOCAL_CONFIG_KEY] === true || r.useLocalConfig === true) {
    return false;
  }
  const keys = [
    "provider",
    "primary_model",
    "image_model",
    "coding_model",
    "primaryModel",
    "imageModel",
    "codingModel",
  ];
  return keys.some((k) => typeof r[k] === "string" && (r[k] as string).trim() !== "");
}

/** Map one chain's legacy ids. Returns the same array when nothing changed. */
export function mapLegacyChain(
  chain: readonly string[],
  facts: LegacyPiFacts,
): string[] {
  if (!chain.includes(LEGACY_PI_HARNESS_ID)) return [...chain];
  const target = decideLegacyPi(facts);
  const out: string[] = [];
  for (const id of chain) {
    const next = id === LEGACY_PI_HARNESS_ID ? target : id;
    // A chain like ["pi", "pi-host"] would collapse into a duplicate; a
    // duplicate entry adds nothing but a second identical attempt.
    if (out.includes(next) && next !== id) continue;
    out.push(next);
  }
  return out;
}

/**
 * Which pi engine a chain id runs on, or undefined for a non-pi id (claude,
 * codex, unknown). The single place every consumer — chain builder, binary
 * detection, /model, the probe — asks "is this pi, and which one?".
 *
 * Structural parameter (not `Config`) so this module stays import-free of
 * config.ts. A legacy `pi` should already have been mapped at read time; it is
 * still decided here, through the same function, so a hand-built config can
 * never reach a harness that silently means something else.
 */
export function piEngineFor(
  harnesses: {
    pi: { routing?: unknown };
    instances?: Record<string, { type: string; routing?: unknown }>;
  },
  id: string,
): PiEngineType | undefined {
  if (id === NATIVE_HARNESS_ID || id === PI_HOST_HARNESS_ID) return id;
  if (id === LEGACY_PI_HARNESS_ID) {
    return decideLegacyPi({ routingConfigured: routingIsConfigured(harnesses.pi.routing) });
  }
  const instance = harnesses.instances?.[id];
  if (!instance || !isPiEngineType(instance.type)) return undefined;
  if (instance.type === LEGACY_PI_HARNESS_ID) {
    return decideLegacyPi({ routingConfigured: routingIsConfigured(instance.routing) });
  }
  return instance.type;
}

export interface ReconcileChange {
  /** Dotted TOML path that changed, e.g. `harnesses.chain`. */
  path: string;
  from: string;
  to: string;
  reason: string;
}

export interface ReconcileFacts {
  /**
   * Effective routing presence for the unnamed `[harnesses.pi]` slot, per
   * persona. `persona` is undefined for the file's own `[harnesses].chain`.
   * A function (not a boolean) because `[harnesses.personas.<name>]` chains in
   * the global file each resolve routing through their own persona layer.
   */
  routingConfigured(persona?: string): boolean;
  hostPiInstalled?: boolean;
}

export interface ReconcileResult {
  toml: TomlObject;
  changes: ReconcileChange[];
}

function isTable(v: unknown): v is TomlObject {
  return !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);
}

function reasonFor(facts: LegacyPiFacts, to: PiEngineType): string {
  if (to === PI_HOST_HARNESS_ID) {
    return "no phantombot routing — runs the host's own pi configuration";
  }
  return facts.routingConfigured
    ? "phantombot provider/model routing is configured — runs on the embedded pi engine"
    : "no host pi installed and no routing — repaired to the embedded pi engine";
}

/**
 * Reconcile one config.toml document. Pure: returns a NEW document plus the
 * list of changes; the input is never mutated. Zero changes means the caller
 * must not write (that is what keeps a second doctor run byte-identical).
 */
export function reconcileHarnessToml(
  input: TomlObject,
  facts: ReconcileFacts,
): ReconcileResult {
  const toml = structuredClone(input) as TomlObject;
  const changes: ReconcileChange[] = [];
  const harnesses = toml.harnesses;
  if (!isTable(harnesses)) return { toml, changes };

  const mapChainAt = (
    holder: TomlObject,
    path: string,
    persona: string | undefined,
  ): void => {
    const chain = holder.chain;
    if (!Array.isArray(chain)) return;
    const ids = chain.filter((x): x is string => typeof x === "string");
    if (!ids.includes(LEGACY_PI_HARNESS_ID)) return;
    const legacyFacts: LegacyPiFacts = {
      routingConfigured: facts.routingConfigured(persona),
      hostPiInstalled: facts.hostPiInstalled,
    };
    const next = mapLegacyChain(ids, legacyFacts);
    const to = decideLegacyPi(legacyFacts);
    holder.chain = next;
    changes.push({
      path,
      from: JSON.stringify(ids),
      to: JSON.stringify(next),
      reason: reasonFor(legacyFacts, to),
    });
  };

  mapChainAt(harnesses, "harnesses.chain", undefined);

  if (isTable(harnesses.personas)) {
    for (const [name, entry] of Object.entries(harnesses.personas)) {
      if (isTable(entry)) mapChainAt(entry, `harnesses.personas.${name}.chain`, name);
    }
  }

  if (isTable(harnesses.instances)) {
    for (const [id, entry] of Object.entries(harnesses.instances)) {
      if (!isTable(entry) || entry.type !== LEGACY_PI_HARNESS_ID) continue;
      const legacyFacts: LegacyPiFacts = {
        routingConfigured: routingIsConfigured(entry.routing),
        hostPiInstalled: facts.hostPiInstalled,
      };
      const to = decideLegacyPi(legacyFacts);
      entry.type = to;
      changes.push({
        path: `harnesses.instances.${id}.type`,
        from: LEGACY_PI_HARNESS_ID,
        to,
        reason: reasonFor(legacyFacts, to),
      });
    }
  }

  return { toml, changes };
}
