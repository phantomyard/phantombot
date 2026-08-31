/**
 * Is a persona FINISHED — usable as a phantom you can actually talk to?
 *
 * One predicate, defined once, so the TUI's launch gate and `phantombot doctor`
 * can never disagree about what "configured" means. Getting two answers here is
 * how a user ends up in a wizard for a phantom doctor calls healthy, or in a
 * chat box wired to a harness that does not exist.
 *
 * Three requirements, and deliberately no more:
 *
 *   1. **The persona's OWN brain.** A harness chain recorded FOR this
 *      persona — its own config file, or a `[harnesses.personas.<name>]`
 *      entry in the host file (the legacy default-persona shape the Brain
 *      flow writes and the runtime honors, phantombot#441) — with at least
 *      one binary on disk. Inheriting the bare host chain is NOT configuring
 *      a brain: a phantom created without one must show as not-ready until
 *      its operator records a choice (Configure → Brain) — "it would work
 *      with the host's chain" is exactly the kind of implicit answer that
 *      produces a phantom nobody ever deliberately set up. Not "a chain is configured" either — a chain naming a `codex`
 *      that was never installed produces a phantom that fails on its first
 *      turn, which is exactly the failure a first-run wizard exists to
 *      prevent.
 *   2. **An identity.** `identity.json` is the persona's nsec, and the vault
 *      key is DERIVED from it — without it there are no credentials, so there
 *      is no working phantom regardless of what else is configured.
 *   3. **A memory database that opens.** Memory is not optional in this
 *      product; a phantom that cannot journal is not a phantom.
 *
 * **Channels are deliberately NOT part of it.** A cli-only phantom is a
 * finished phantom — you talk to it from the terminal (TUI screen 0). Making a
 * Telegram token a completeness requirement would push every new user through
 * @BotFather before they can say hello, and would mark a perfectly working
 * local phantom as broken.
 *
 * Every check is expressed as a `PersonaRequirement` with a stable `step` name
 * so the wizard can RESUME at the first unsatisfied one with everything before
 * it pre-filled, rather than restarting from the name question.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Config } from "../config.ts";
import { personaDir } from "../config.ts";
import { getIn, readConfigToml } from "../lib/configWriter.ts";
import { personaConfigPath } from "../lib/personaConfig.ts";
import { resolveHarnessAvailability } from "./harnessAvailability.ts";
import { IDENTITY_FILE } from "./personaIdentity.ts";

/**
 * Wizard steps, in the order the wizard asks them. `name` is not a
 * requirement — a persona that exists on disk necessarily has one — but it is
 * listed so a caller can map a requirement onto a step index without a second
 * table.
 */
export const WIZARD_STEPS = [
  "name",
  "identity",
  "tone",
  "done",
] as const;

export type WizardStep = (typeof WIZARD_STEPS)[number];

export interface PersonaRequirement {
  /** Which wizard step satisfies this requirement when it fails. */
  step: WizardStep;
  /** Stable id for tests and logs. */
  id: "brain" | "identity" | "memory";
  ok: boolean;
  /** Human-readable one-liner: what is wrong, or what was found. */
  detail: string;
}

export interface PersonaCompleteness {
  persona: string;
  complete: boolean;
  requirements: PersonaRequirement[];
  /**
   * The wizard step to resume at: the first unsatisfied requirement's step, or
   * `"done"` when everything passes. Never `"name"` for a persona that already
   * exists on disk.
   */
  resumeAt: WizardStep;
}

export interface PersonaCompletenessDeps {
  /** Test seam for the harness binary probe. */
  resolveHarness?: typeof resolveHarnessAvailability;
  /**
   * Test seam: the persona's OWN harness chain, read from its config file.
   * Defaults to the real reader; `undefined` means the persona has recorded
   * no brain of its own.
   */
  localChain?: () => Promise<readonly string[] | undefined>;
  /** Test seam: does this path exist? */
  exists?: (path: string) => boolean;
  /**
   * Test seam: can the memory database be opened? Production passes the real
   * store opener. Returning false (rather than throwing) keeps a corrupt DB a
   * *reportable* state instead of an exception on the launch path.
   */
  memoryOpens?: (dbPath: string) => Promise<boolean>;
}

/**
 * The harness chain recorded FOR this persona, in order of precedence —
 * mirroring `harnessChainIds` so the gate and the runtime can never disagree
 * about whether a brain exists:
 *
 *   1. the persona's OWN config file (`<persona>/config.toml`),
 *   2. a persona-specific entry in the host file (`[harnesses.personas.<name>]`)
 *      — the legacy default-persona shape the Brain flow writes while the
 *      persona has no file of its own.
 *
 * The bare host chain (`[harnesses].chain`) is deliberately NOT consulted:
 * inheriting it is not a recorded choice. A missing record is a phantom that
 * has configured no brain yet, not an error.
 *
 * Exported so every consumer of "did this persona record a brain of its own?"
 * (the completeness gate, the settings badge, the status block) reads ONE
 * source of truth instead of drifting — the drift between this predicate and
 * the snapshot's own-file reader is exactly what produced a red `required`
 * badge on a phantom that was chatting.
 */
export async function defaultLocalChain(
  config: Config,
  persona: string,
): Promise<readonly string[] | undefined> {
  try {
    const toml = await readConfigToml(
      personaConfigPath(config.personasDir, persona),
    );
    const chain = getIn(toml, ["harnesses", "chain"]);
    if (Array.isArray(chain) && chain.length > 0) {
      return chain as readonly string[];
    }
  } catch {
    // No persona file — fall through to the host personas table.
  }
  // `config` is the persona's EFFECTIVE config, so its personas table already
  // carries the host file's `[harnesses.personas.<name>]` entry for THIS
  // persona (and only this one is read — other personas' rows are theirs).
  const recorded = config.harnesses.personas?.[persona]?.chain;
  return Array.isArray(recorded) && recorded.length > 0
    ? (recorded as readonly string[])
    : undefined;
}

async function defaultMemoryOpens(dbPath: string): Promise<boolean> {
  try {
    const { openMemoryStore } = await import("../memory/store.ts");
    const store = await openMemoryStore(dbPath);
    await store.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Evaluate the three requirements for `config.personaLayer` (or an explicit
 * persona). `config` must already be the persona's EFFECTIVE config — load it
 * with `loadConfigForPersona(name)`, not the default layer, or a non-default
 * persona is judged on someone else's harness chain (AGENTS.md persona
 * invariant 1).
 */
export async function personaCompleteness(
  config: Config,
  persona: string,
  deps: PersonaCompletenessDeps = {},
): Promise<PersonaCompleteness> {
  const exists = deps.exists ?? existsSync;
  const resolveHarness = deps.resolveHarness ?? resolveHarnessAvailability;
  const memoryOpens = deps.memoryOpens ?? defaultMemoryOpens;
  const localChain =
    (await deps.localChain?.()) ?? (await defaultLocalChain(config, persona));
  const dir = personaDir(config, persona);

  const requirements: PersonaRequirement[] = [];

  // 1. Brain. The persona must have recorded its own chain, and at least one
  //    harness on it must actually resolve — that is the one a turn would use.
  const chain = localChain ?? [];
  let brainDetail = "no brain configured — set one under Configure → Brain";
  let brainOk = false;
  if (localChain) {
    for (const id of chain) {
      const availability = await resolveHarness(config, id);
      if (availability?.resolved) {
        brainOk = true;
        brainDetail = `${id} → ${availability.resolved}`;
        break;
      }
      brainDetail = `${chain.join(" → ")}: none found on PATH`;
    }
  }
  requirements.push({
    // Not a wizard question anymore — a brain gap routes to Configure (tier
    // 2 of the opening doctrine), so `step` only needs a legal value.
    step: "done",
    id: "brain",
    ok: brainOk,
    detail: brainDetail,
  });

  // 2. Identity. The vault key is derived from this file; losing it loses every
  //    secret, so its absence is not a warning, it is "not configured yet".
  const identityPath = join(dir, IDENTITY_FILE);
  const identityOk = exists(identityPath);
  requirements.push({
    // The one gap the wizard itself fixes: resume at the identity question.
    step: "identity",
    id: "identity",
    ok: identityOk,
    detail: identityOk ? identityPath : `missing ${identityPath}`,
  });

  // 3. Memory database.
  const dbOk = await memoryOpens(config.memoryDbPath);
  requirements.push({
    // Also not a wizard question — a corrupt DB is a repair case, not a
    // setup flow; it surfaces as the not-ready badge instead.
    step: "done",
    id: "memory",
    ok: dbOk,
    detail: dbOk ? config.memoryDbPath : `cannot open ${config.memoryDbPath}`,
  });

  const firstBad = requirements.find((r) => !r.ok);
  return {
    persona,
    complete: !firstBad,
    requirements,
    resumeAt: firstBad ? firstBad.step : "done",
  };
}
