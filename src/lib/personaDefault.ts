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
export async function defaultPersonaProvenance(
  config: Config,
): Promise<DefaultPersonaSource> {
  if (process.env.PHANTOMBOT_DEFAULT_PERSONA?.trim()) return "env";
  const state = await loadState();
  if (state.default_persona) return "state";
  try {
    const toml = parseToml(await readFile(config.configPath, "utf8")) as Record<
      string,
      unknown
    >;
    if (typeof toml.default_persona === "string") return "config";
  } catch {
    // Missing or unparseable config.toml: nothing came from that layer.
  }
  return "builtin";
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
