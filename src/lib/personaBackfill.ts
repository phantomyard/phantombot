/**
 * Backfill the split identity files (SOUL.md + IDENTITY.md) into personas
 * that predate them.
 *
 * Phantombot only started guaranteeing a SOUL.md (shared behaviour anchor)
 * and IDENTITY.md (per-phantom facts) at onboarding recently. Personas
 * created before that — or copied in by hand — may have neither, or may have
 * a single combined BOOT.md. This walks the personas dir and, per persona,
 * fills only the gaps:
 *
 *   - SOUL.md missing        → write the default shared SOUL template.
 *   - No facts file at all   → write an IDENTITY.md stub (labelled blanks for
 *     (no BOOT.md and no        the owner to complete; persona name pre-filled).
 *      IDENTITY.md)
 *
 * It NEVER overwrites an existing SOUL.md, IDENTITY.md, or BOOT.md — a legacy
 * BOOT.md keeps its content and simply gains a SOUL.md alongside it, which the
 * loader concatenates. This makes the backfill safe to re-run (idempotent).
 */

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Config } from "../config.ts";
import { listPersonaDirs } from "./personaDefault.ts";
import { generateIdentityStub, generateSoulMd } from "./personaTemplate.ts";

export interface PersonaBackfillResult {
  /** Persona directory name. */
  name: string;
  /** True if SOUL.md was written (was missing). */
  wroteSoul: boolean;
  /** True if an IDENTITY.md stub was written (no facts file existed). */
  wroteIdentityStub: boolean;
}

/**
 * Backfill a single persona directory. Pure-ish: only writes missing files.
 * Returns what it did (both false = already complete, nothing written).
 */
export async function backfillPersonaDir(
  name: string,
  dir: string,
): Promise<PersonaBackfillResult> {
  const result: PersonaBackfillResult = {
    name,
    wroteSoul: false,
    wroteIdentityStub: false,
  };

  if (!existsSync(join(dir, "SOUL.md"))) {
    await writeFile(join(dir, "SOUL.md"), generateSoulMd(), "utf8");
    result.wroteSoul = true;
  }

  // A "facts" file is either the legacy combined BOOT.md or a modern
  // IDENTITY.md. Only stub one in when neither exists — never clobber the
  // persona's real identity.
  const hasFacts =
    existsSync(join(dir, "BOOT.md")) || existsSync(join(dir, "IDENTITY.md"));
  if (!hasFacts) {
    await writeFile(
      join(dir, "IDENTITY.md"),
      generateIdentityStub(name),
      "utf8",
    );
    result.wroteIdentityStub = true;
  }

  return result;
}

/**
 * Backfill every persona under config.personasDir. Idempotent — safe to run
 * repeatedly. Returns one result per persona (including no-op ones, so the
 * caller can report "3 already complete").
 */
export async function backfillAllPersonas(
  config: Config,
): Promise<PersonaBackfillResult[]> {
  const names = listPersonaDirs(config);
  const results: PersonaBackfillResult[] = [];
  for (const name of names) {
    results.push(
      await backfillPersonaDir(name, join(config.personasDir, name)),
    );
  }
  return results;
}
