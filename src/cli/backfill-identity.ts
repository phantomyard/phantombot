/**
 * `phantombot backfill-identity` — ensure every persona has the split
 * identity files (SOUL.md + IDENTITY.md).
 *
 * Onboarding writes both for new personas, but personas created before the
 * split — or copied in by hand — may be missing them. This walks the personas
 * dir and fills only the gaps, per persona:
 *
 *   - SOUL.md missing      → write the default shared behaviour template.
 *   - no facts file at all → write an IDENTITY.md stub for the owner to fill.
 *
 * Never overwrites an existing SOUL.md / IDENTITY.md / BOOT.md — a legacy
 * BOOT.md keeps its content and gains a SOUL.md beside it. Idempotent: safe
 * to run repeatedly (a second run reports everything already complete).
 */

import { defineCommand } from "citty";
import { join } from "node:path";

import { type Config, loadConfig } from "../config.ts";
import type { WriteSink } from "../lib/io.ts";
import {
  backfillAllPersonas,
  backfillPersonaDir,
  type PersonaBackfillResult,
} from "../lib/personaBackfill.ts";
import { listPersonaDirs } from "../lib/personaDefault.ts";

export interface RunBackfillInput {
  config?: Config;
  /** Limit to a single persona by name (default: all). */
  persona?: string;
  /** Report what would change without writing. */
  dryRun?: boolean;
  out?: WriteSink;
  err?: WriteSink;
}

function describe(r: PersonaBackfillResult): string {
  const parts: string[] = [];
  if (r.wroteSoul) parts.push("SOUL.md");
  if (r.wroteIdentityStub) parts.push("IDENTITY.md (stub)");
  return parts.length > 0
    ? `${r.name}: wrote ${parts.join(" + ")}`
    : `${r.name}: already complete`;
}

/**
 * Dry-run variant of backfillPersonaDir — reports what WOULD be written
 * without touching disk. Mirrors the real logic in personaBackfill.ts.
 */
async function planPersonaDir(
  name: string,
  dir: string,
): Promise<PersonaBackfillResult> {
  const { existsSync } = await import("node:fs");
  const hasFacts =
    existsSync(join(dir, "BOOT.md")) || existsSync(join(dir, "IDENTITY.md"));
  return {
    name,
    wroteSoul: !existsSync(join(dir, "SOUL.md")),
    wroteIdentityStub: !hasFacts,
  };
}

export async function runBackfillIdentity(
  input: RunBackfillInput = {},
): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const config = input.config ?? (await loadConfig());

  const names = listPersonaDirs(config);
  if (input.persona && !names.includes(input.persona)) {
    err.write(`persona '${input.persona}' not found under ${config.personasDir}\n`);
    return 2;
  }

  let results: PersonaBackfillResult[];
  if (input.dryRun) {
    const targets = input.persona ? [input.persona] : names;
    results = [];
    for (const name of targets) {
      results.push(await planPersonaDir(name, join(config.personasDir, name)));
    }
  } else if (input.persona) {
    results = [
      await backfillPersonaDir(
        input.persona,
        join(config.personasDir, input.persona),
      ),
    ];
  } else {
    results = await backfillAllPersonas(config);
  }

  const changed = results.filter((r) => r.wroteSoul || r.wroteIdentityStub);
  for (const r of results) out.write(`  ${describe(r)}\n`);
  out.write(
    `${input.dryRun ? "[dry-run] " : ""}backfill: ${changed.length} persona(s) ` +
      `${input.dryRun ? "would be" : ""} updated, ` +
      `${results.length - changed.length} already complete\n`,
  );
  return 0;
}

export default defineCommand({
  meta: {
    name: "backfill-identity",
    description:
      "Ensure every persona has SOUL.md (shared behaviour) + IDENTITY.md (per-phantom facts). Fills only gaps; never overwrites. Idempotent.",
  },
  args: {
    persona: {
      type: "string",
      description: "Limit to a single persona (default: all personas).",
    },
    "dry-run": {
      type: "boolean",
      description: "Report what would change without writing anything.",
      default: false,
    },
  },
  async run({ args }) {
    process.exitCode = await runBackfillIdentity({
      persona: args.persona ? String(args.persona) : undefined,
      dryRun: Boolean(args["dry-run"]),
    });
  },
});
