/**
 * Shared "adopt this persona as default if the current default is broken"
 * helper. Used by every code path that creates, imports, or restores a
 * persona — without this, a fresh box keeps `default_persona = "phantom"`
 * (the built-in fallback), and `phantombot run` fails with
 * "persona 'phantom' not found at .../personas/phantom" because the
 * directory was never created.
 *
 * Doesn't override a working default — additive create/import/restore
 * operations stay non-destructive.
 */

import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseToml } from "smol-toml";

import { type Config, personaDir } from "../config.ts";
import { loadState, saveState } from "../state.ts";
import type { WriteSink } from "./io.ts";
import { log } from "./logger.ts";
import { updateConfigToml, type TomlObject } from "./configWriter.ts";

/**
 * Marker files that mean "a phantom lives here". Any ONE of them is enough.
 *
 * Deliberately a union, not an intersection, and deliberately NOT
 * `personaCompleteness`. Completeness asks "is this phantom finished" and is
 * right for the TUI launch gate, but heal REWRITES state.json unprompted, so
 * its trigger has to be something that cannot be transiently false. Both of
 * completeness's other requirements can be: `identity.json` is created LAZILY
 * on the first vault open, so a persona created seconds ago legitimately has
 * none, and the harness-binary probe reads the current PATH. Keying heal on
 * either would let a fresh install repoint its brand-new default at some older
 * persona — a far worse bug than the one being fixed here.
 */
const PERSONA_MARKERS = [
  "identity.json",
  "config.toml",
  "vault.sqlite",
  "mcp.json",
  "IDENTITY.md",
  "SOUL.md",
  "MEMORY.md",
  "BOOT.md",
  "memory",
  "kb",
] as const;

/**
 * Is `name` usable AS THE HOST DEFAULT? (#505)
 *
 * `existsSync(personaDir)` was the whole test, and a bare directory is a poor
 * proxy for "there is a phantom here": a create that died after `mkdir`, or a
 * migration that moved the contents out, leaves the folder behind. Heal then
 * sees a healthy default and does nothing, while every command that omits
 * `--persona` resolves against a husk — empty MCP registry, no vault, no
 * memory — and SUCCEEDS, quietly, against the wrong persona.
 *
 * Scope note, so nobody expects more of this than it gives: a persona that was
 * migrated to another HOST but left its files here is indistinguishable from a
 * working one, and this will not catch it. Detecting that is `doctor`'s job
 * (it reports the resolved default, its provenance, and whether its MCP
 * registry is empty while a sibling's is not), because reporting is safe and
 * silently rewriting the host default on a guess is not.
 *
 * Returns null when usable, or a short reason when not.
 */
export function defaultPersonaDefect(
  config: Config,
  name: string,
): string | null {
  const dir = personaDir(config, name);
  if (!existsSync(dir)) return "no persona dir on disk";
  if (!PERSONA_MARKERS.some((f) => existsSync(join(dir, f)))) {
    return "persona dir is empty (no identity, config, vault or memory)";
  }
  return null;
}

/** Resolve a persona key to the exact directory spelling on disk. */
export function canonicalPersonaName(
  config: Config,
  name: string,
): string | null {
  const existing = listPersonaDirs(config);
  if (existing.includes(name)) return name;
  const matches = existing.filter(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  // Case-sensitive filesystems can contain ambiguous names. Never guess which
  // memory namespace the operator intended.
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * If the current `default_persona` points at a directory that doesn't
 * exist on disk, set `default_persona` to `name` (and write state.json).
 * Otherwise no-op.
 *
 * Returns true if the default was changed.
 */
export async function adoptAsDefaultIfMissing(
  config: Config,
  name: string,
  out?: WriteSink,
): Promise<boolean> {
  const canonical = canonicalPersonaName(config, config.defaultPersona);
  if (
    canonical === config.defaultPersona &&
    defaultPersonaDefect(config, canonical) === null
  ) {
    return false;
  }
  if (canonical !== null && defaultPersonaDefect(config, canonical) === null) {
    await writeDefaultPersona(canonical);
    log.warn("persona default case-normalized", {
      from: config.defaultPersona,
      to: canonical,
      reason: "case mismatch against persona dir",
    });
    out?.write(
      `\nnormalized default_persona: '${config.defaultPersona}' → '${canonical}' ` +
        `(the persona dir on disk is spelled '${canonical}')\n`,
    );
    return false;
  }
  await writeDefaultPersona(name);
  out?.write(
    `\nadopted '${name}' as default_persona (previous default '${config.defaultPersona}': ` +
      `${defaultPersonaDefect(config, config.defaultPersona)})\n`,
  );
  return true;
}

/**
 * Startup safety net: if the resolved `defaultPersona` is not usable, scan the
 * personas directory for a replacement, write it to state.json, and return the
 * healed name.
 *
 * Without this, a corrupted `state.json` (e.g. pointing at a persona
 * that was never created on this host, or one that was deleted) causes
 * `phantombot run` to crash-loop until the user manually runs
 * `phantombot persona` to switch back.
 *
 * Strategy:
 *   1. If the resolved default is usable → return it (no-op). "Usable" is
 *      `defaultPersonaDefect`, not `existsSync` — see there for why.
 *   2. Scan the personas dir. If empty → return null (caller bails).
 *   3. Prefer a USABLE name matching the broken default (case mismatch).
 *   4. Otherwise the first candidate that is itself usable.
 *   5. Otherwise a husk (case-match first), so a host with nothing but husks
 *      still boots somewhere rather than staying pointed at a missing dir.
 *
 * Returns the healed persona name, or null if no personas exist at all.
 */
export async function healDefaultPersonaIfBroken(
  config: Config,
  out?: WriteSink,
  /** Operator-explicit fallback (e.g. the config.toml-layer default) — tried
   *  after a case-variant of the broken name and before alphabetical order. */
  preferred?: string,
): Promise<string | null> {
  const canonical = canonicalPersonaName(config, config.defaultPersona);
  const defect =
    canonical === null
      ? defaultPersonaDefect(config, config.defaultPersona)
      : defaultPersonaDefect(config, canonical);
  if (canonical === config.defaultPersona && defect === null) {
    return config.defaultPersona;
  }

  const existing = listPersonaDirs(config);
  if (existing.length === 0) return null;

  // Prefer a USABLE persona whose name matches the broken default
  // (case-insensitive), then the first candidate that is itself usable, and
  // only then fall back to a husk (case-match first, then first on disk).
  // Without the middle step a host with two husks and one real phantom heals
  // alphabetically into another husk (#505).
  const brokenName = config.defaultPersona.toLowerCase();
  const others = existing.filter((n) => n !== config.defaultPersona);
  const usable = (n: string) => defaultPersonaDefect(config, n) === null;
  const caseMatch =
    canonical !== null && canonical !== config.defaultPersona
      ? canonical
      : others.find((n) => n.toLowerCase() === brokenName);
  // The case-only match only wins if it is itself usable: preferring a husk
  // named `Kai` over a working `real` would write the broken name to
  // state.json and leave the host unbootable (#506 review).
  let healed =
    caseMatch !== undefined && usable(caseMatch) ? caseMatch : undefined;
  healed ??=
    preferred !== undefined && preferred !== config.defaultPersona && usable(preferred)
      ? preferred
      : undefined;
  healed ??= others.find(usable);
  healed ??= caseMatch;
  healed ??= others[0] ?? existing[0]!;
  if (healed === config.defaultPersona) return config.defaultPersona;

  const state = await loadState();
  state.default_persona = healed;
  await saveState(state);
  log.warn("persona healed", {
    from: config.defaultPersona,
    to: healed,
    reason:
      canonical !== null && defect === null
        ? "case mismatch against persona dir"
        : defect,
  });
  out?.write(
    `healed default_persona: '${config.defaultPersona}' \u2192 '${healed}' ` +
      `(${canonical !== null && defect === null ? "case mismatch against persona dir" : `previous default: ${defect}`})\n`,
  );
  return healed;
}

/** Where the resolved `default_persona` came from. */
export type DefaultPersonaSource = "env" | "state" | "config" | "builtin";

/**
 * Which layer produced `config.defaultPersona`, for `doctor` to print (#505).
 *
 * Resolution order in `config.ts` is `PHANTOMBOT_DEFAULT_PERSONA` env >
 * `state.json` > `config.toml` > the built-in `"phantom"`. Operators reach for
 * `config.toml` first and it is the layer that LOSES, so the provenance line is
 * the difference between a one-line fix and an afternoon.
 */
/**
 * The raw `config.toml`-layer `default_persona`, if the operator set one —
 * regardless of what env/state layers resolved on top of it. The layer that
 * LOSES resolution is often the layer the operator actually edited.
 */
export async function configLayerDefaultPersona(
  config: Config,
): Promise<string | undefined> {
  try {
    const toml = parseToml(await readFile(config.configPath, "utf8")) as Record<
      string,
      unknown
    >;
    return typeof toml.default_persona === "string"
      ? toml.default_persona
      : undefined;
  } catch {
    return undefined;
  }
}

export async function defaultPersonaProvenance(
  config: Config,
): Promise<DefaultPersonaSource> {
  if (process.env.PHANTOMBOT_DEFAULT_PERSONA?.trim()) return "env";
  const state = await loadState();
  if (state.default_persona) return "state";
  if (await configLayerDefaultPersona(config)) return "config";
  return "builtin";
}

/**
 * Legacy-install migration: adopt the given persona as `default_persona` when
 * NOTHING configured a default anywhere (env > state.json > config.toml all
 * empty, i.e. provenance "builtin").
 *
 * Pre-#509 the TUI silently fell back to `personas[0]`'s chat, so every
 * legacy install without an explicit default landed in that persona. The
 * three-tier opening doctrine turned that silent fallback into the wizard,
 * which would shove a working, configured host into the create flow on first
 * launch after upgrade. This restores the pre-upgrade behaviour by making it
 * EXPLICIT: the fallback persona the old TUI would have picked is written to
 * config.toml (the operator-visible layer) once, and from then on the host is
 * an ordinary configured install.
 *
 * The caller gates on provenance — an explicitly-configured (or healed)
 * default, even a broken one, is never overwritten here; the heal path owns
 * broken defaults.
 *
 * Mutates `config.defaultPersona` to match, so an in-memory caller does not
 * have to reload to resolve the opening screen.
 */
export async function adoptLegacyDefaultPersona(
  config: Config,
  persona: string,
): Promise<void> {
  await updateConfigToml(config.configPath, (toml: TomlObject) => {
    toml.default_persona = persona;
  });
  config.defaultPersona = persona;
  log.warn("legacy install: adopted default_persona", {
    persona,
    reason:
      "no default_persona configured anywhere (pre-upgrade fallback made explicit)",
  });
}

/**
 * Legacy-install migration: backfill `[autostart_modes]` when the host has
 * SERVED personas but NO mode records at all — the exact signature of a
 * pre-#509 install, where being served meant "boot via linger/LaunchDaemon/
 * boot task".
 *
 * "Served" is `servedPersonasOf` — the default persona plus
 * `autostart_personas` — and NOT list membership alone. The first cut gated
 * on a non-empty `autostart_personas`, which made the whole migration a
 * no-op on the commonest install there is: a single-persona `phantombot
 * install` host that has a `default_persona` and never wrote an
 * `autostart_personas` key. Those hosts (Matt/macOS, Megan/Windows,
 * verified 2026-09-01) got no records at all, so the TUI fell back to
 * reporting Off for a persona the daemon starts at every login (#512).
 *
 * One-time by construction: the gate is "no records exist", and this write
 * CREATES records — from then on the table is the sole source of truth and
 * this migration is a no-op. Nothing here disables anything: boot stays boot,
 * login stays login.
 *
 * Signal per platform: Linux — ALWAYS `login`. A pre-#509 host cannot be
 * distinguished from a standard installer host: linger is an ordinary
 * systemd --user prerequisite enabled unconditionally by the installer
 * (cli/init.ts), so a linger probe is the same provenance-free bit #509
 * rejected — a `boot` record written from it would arm teardown against
 * installer default state. Failing toward `login` (display) and doing
 * nothing (teardown) beats a record that lies; an operator who really
 * boots sets Boot once in the TUI. macOS/Windows — the same ours-only
 * probes the display uses (dev.phantombot.* plists / per-persona markers);
 * those DO carry provenance, so they may still produce `boot`.
 *
 * All probes run BEFORE any write: a throw can then only happen in the
 * write loop, and a partial write leaves earlier personas with valid
 * (conservative) records rather than an inconsistent mix.
 */
export async function migrateLegacyAutostartModes(
  config: Config,
  opts?: {
    /** Test seam: overrides the per-platform boot probe. */
    bootProbe?: (name: string) => Promise<boolean>;
  },
): Promise<void> {
  // The default persona counts as served ONLY when something actually chose
  // it (env / state.json / config.toml). Provenance "builtin" is the bare
  // fallback name on a host that configured nothing, so backfilling a record
  // for it would invent an autostart record for a persona that may not even
  // exist on disk. `resolveOpeningScreen` runs the default-persona adoption
  // BEFORE this migration, so a genuine legacy host has already had its
  // implicit default made explicit by the time we get here.
  const { servedPersonasOf } = await import("../config.ts");
  const chosenDefault =
    (await defaultPersonaProvenance(config)) === "builtin"
      ? undefined
      : config.defaultPersona;
  const served = servedPersonasOf({
    ...(chosenDefault ? { defaultPersona: chosenDefault } : {}),
    autostartPersonas: config.autostartPersonas ?? [],
  } as Pick<Config, "defaultPersona" | "autostartPersonas">).filter(
    (n) => typeof n === "string" && n.length > 0,
  );
  if (!served.length) return;
  if (config.autostartModes && Object.keys(config.autostartModes).length > 0)
    return;
  const { currentPlatform } = await import("./platform.ts");
  const platform = currentPlatform();
  const bootProbe = (name: string): Promise<boolean> => {
    if (opts?.bootProbe) return opts.bootProbe(name);
    return import("./autostartBoot.ts").then((m) => m.probeBootState(name, {}));
  };
  // Probe everything first — probing never writes, so a probe failure here
  // leaves the config untouched and the migration can simply be retried.
  const modes: Record<string, "login" | "boot"> = {};
  for (const name of served) {
    modes[name] =
      platform === "linux" ? "login" : (await bootProbe(name)) ? "boot" : "login";
  }
  const recorded: Record<string, "login" | "boot"> = {};
  for (const [name, mode] of Object.entries(modes)) {
    await writeAutostartMode(config, name, mode);
    recorded[name] = mode;
  }
  log.warn("legacy install: backfilled [autostart_modes]", {
    ...recorded,
    reason:
      "pre-#509 served personas had no mode records; linux is always login (linger is an installer default, not a Boot choice), mac/win from ours-only probes",
  });
}

/** List persona subdirectory names. Returns [] if the dir doesn't exist. */
export function listPersonaDirs(config: Config): string[] {
  if (!existsSync(config.personasDir)) return [];
  try {
    return readdirSync(config.personasDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (e) {
    log.warn("personaDefault: failed to read personas dir", {
      personasDir: config.personasDir,
      error: (e as Error).message,
    });
    return [];
  }
}

async function writeDefaultPersona(name: string): Promise<void> {
  const state = await loadState();
  state.default_persona = name;
  await saveState(state);
}

/**
 * Write the host-global `autostart_personas` list.
 *
 * Extracted from the `phantombot persona` autostart picker so the TUI and the
 * CLI go through ONE writer. `autostart_personas` is a HOST-ONLY key
 * (`lib/personaConfig.ts` HOST_ONLY_KEYS): it lives in the global config.toml
 * and never in a persona file. A second writer that reached for the persona
 * layer instead would "save" successfully and change nothing, and two personas
 * editing their own copies would silently fight over who boots.
 *
 * The on-disk order of names already present is preserved and new names are
 * appended, so toggling one persona never shows up as an unrelated reorder in
 * the user's config file. An empty list removes the key entirely, which is
 * exactly the pre-existing "default persona only" behaviour.
 *
 * Mutates `config.autostartPersonas` to match, so an in-memory caller does not
 * have to reload to render the change it just made.
 */
export async function writeAutostartPersonas(
  config: Config,
  picked: readonly string[],
): Promise<string[]> {
  const current = config.autostartPersonas ?? [];
  const chosen = [
    ...current.filter((n) => picked.includes(n)),
    ...picked.filter((n) => !current.includes(n)),
  ];
  await updateConfigToml(config.configPath, (toml: TomlObject) => {
    if (chosen.length === 0) {
      delete toml.autostart_personas;
    } else {
      toml.autostart_personas = chosen;
    }
  });
  config.autostartPersonas = chosen;
  return chosen;
}

/**
 * Write ONE persona's autostart mode into the host-global `[autostart_modes]`
 * table. `undefined` removes the record entirely — a persona with no record
 * is "login", the historical behaviour, so existing agents inherit what they
 * already have and nothing about their setup changes under them.
 *
 * Mirrors `writeAutostartPersonas`' doctrine: HOST-ONLY key, one writer,
 * an empty table deletes the key rather than writing `{}` noise.
 *
 * Mutates `config.autostartModes` to match, so an in-memory caller does not
 * have to reload to render the change it just made.
 */
export async function writeAutostartMode(
  config: Config,
  persona: string,
  mode: "login" | "boot" | undefined,
): Promise<void> {
  await updateConfigToml(config.configPath, (toml: TomlObject) => {
    const table =
      toml.autostart_modes && typeof toml.autostart_modes === "object"
        ? { ...(toml.autostart_modes as Record<string, unknown>) }
        : {};
    if (mode === undefined) delete table[persona];
    else table[persona] = mode;
    if (Object.keys(table).length === 0) delete toml.autostart_modes;
    else toml.autostart_modes = table;
  });
  const modes = { ...(config.autostartModes ?? {}) };
  if (mode === undefined) delete modes[persona];
  else modes[persona] = mode;
  config.autostartModes = modes;
}

