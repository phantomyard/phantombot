/**
 * Where a persona's HARNESS settings are written (phantombot#441).
 *
 * Lives in lib/ rather than in the wizard because the wizard is not the only
 * writer: `/model` changes a harness model from a chat turn, and a writer that
 * lands somewhere the reader does not look reports success and changes
 * nothing. One resolver, used by every harness writer, is the only way the
 * read and write paths stay in lockstep.
 */

import { personaEnvSuffix } from "../config.ts";
import {
  personaConfigPath,
  resolvePersonaWriteTarget,
  type PersonaWriteScope,
} from "./personaConfig.ts";

/** The host fields the resolver needs; `Config` satisfies it structurally. */
export interface HarnessWriteHost {
  configPath: string;
  personasDir: string;
  defaultPersona: string;
}

/**
 * Where this wizard run persists everything it collects (phantombot#441).
 *
 * `[harnesses]` is persona-scoped, so the chain, the models and Pi's routing
 * all have to land in the SAME place the reader looks for them — the persona's
 * own config.toml once it exists — and the env mirror has to be scoped with
 * them, or the shared env file's unsuffixed vars would overwrite every
 * persona's models with the last one configured.
 *
 * `envSuffix` is undefined for the default persona (it keeps the unsuffixed
 * vars it has always used) and `<PERSONA>` for every other one.
 */
export interface HarnessWriteTarget {
  path: string;
  scope: PersonaWriteScope;
  persona?: string;
  envSuffix?: string;
}

/**
 * Suffix the env keys of a routing write for a non-default persona, so
 * `PHANTOMBOT_PRIMARY_MODEL` becomes `PHANTOMBOT_PRIMARY_MODEL_LENA`. Config
 * reads the suffixed var first for that persona and never falls back to the
 * unsuffixed one when the persona states the key itself (see config.ts
 * harnessEnv) — the same shape as the Telegram token isolation in #440.
 */
export function suffixEnvKeys(
  env: Record<string, string>,
  envSuffix?: string,
): Record<string, string> {
  if (!envSuffix) return env;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) out[`${k}_${envSuffix}`] = v;
  return out;
}

/**
 * Where the harness wizard writes for `persona` (phantombot#441).
 *
 * The generic rule (`resolvePersonaWriteTarget`) falls back to the GLOBAL file
 * in its legacy shape while a persona has no config.toml of its own. For the
 * chain that is safe — the fallback writes `[harnesses.personas.<name>].chain`,
 * which only that persona reads. It is NOT safe for the models: routing is
 * written as a plain `[harnesses.pi.routing]` table, which in the global file
 * is the HOST default that every other persona inherits under the per-key
 * merge. Configuring Lena's brain would then move Kai's — via TOML, exactly the
 * leak the suffixed env mirror closes on the env side.
 *
 * So a NON-DEFAULT persona is always written in persona scope, materialising
 * `<persona>/config.toml` on first write. The default persona keeps the
 * historical global-file behaviour until migration gives it a file, so an
 * unmigrated host stays readable by an older binary (release rings make
 * rollback real).
 */
export async function resolveHarnessWriteTarget(
  config: HarnessWriteHost,
  persona?: string,
): Promise<HarnessWriteTarget> {
  const name = persona ?? config.defaultPersona;
  const isDefault = !persona || persona === config.defaultPersona;
  const resolved = isDefault
    ? await resolvePersonaWriteTarget({
      configPath: config.configPath,
      personasDir: config.personasDir,
      persona: name,
    })
    : {
      path: personaConfigPath(config.personasDir, name),
      scope: "persona" as PersonaWriteScope,
    };
  return {
    ...resolved,
    persona: name,
    envSuffix: isDefault ? undefined : personaEnvSuffix(name),
  };
}
