/**
 * `phantombot import-persona` — copy an OpenClaw agent directory into
 * phantombot's personas dir so it can be used by `ask` / `chat`.
 *
 * The work is in src/importer/openclaw.ts; this file is the Citty wrapper.
 */

import { defineCommand } from "citty";
import { loadConfig } from "../config.ts";
import {
  type ImportPersonaResult,
  importPersona,
} from "../importer/openclaw.ts";
import type { WriteSink } from "../lib/io.ts";

export interface RunImportPersonaInput {
  source: string;
  as?: string;
  overwrite?: boolean;
  /** Override personas root (defaults to config.personasDir). */
  personasDir?: string;
  out?: WriteSink;
  err?: WriteSink;
}

export async function runImportPersona(
  input: RunImportPersonaInput,
): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;

  const personasDir =
    input.personasDir ?? (await loadConfig()).personasDir;

  let result: ImportPersonaResult;
  try {
    result = await importPersona({
      source: input.source,
      personasDir,
      as: input.as,
      overwrite: input.overwrite,
    });
  } catch (e) {
    err.write(`error: ${(e as Error).message}\n`);
    return 1;
  }

  out.write(`imported persona '${result.name}' to ${result.targetDir}\n`);
  out.write(`copied (${result.copied.length}):\n`);
  for (const f of result.copied) out.write(`  ${f}\n`);
  if (result.skipped.length > 0) {
    out.write(`skipped (${result.skipped.length}):\n`);
    for (const f of result.skipped) out.write(`  ${f}\n`);
  }
  out.write(
    "\nNote: conversation history was NOT imported (phantombot v1 has no transcript importer).\n",
  );
  return 0;
}

export default defineCommand({
  meta: {
    name: "import-persona",
    description:
      "Import a persona from an OpenClaw agent directory. Copies BOOT.md / SOUL.md / IDENTITY.md / MEMORY.md / tools.md / AGENTS.md and any other top-level .md files into the phantombot personas dir.",
  },
  args: {
    path: {
      type: "positional",
      description: "Path to the OpenClaw agent directory to import.",
      required: true,
    },
    as: {
      type: "string",
      description:
        "Target persona name (defaults to the basename of the source directory).",
    },
    overwrite: {
      type: "boolean",
      description: "Replace any existing persona with the same name.",
      default: false,
    },
  },
  async run({ args }) {
    const code = await runImportPersona({
      source: String(args.path),
      as: args.as ? String(args.as) : undefined,
      overwrite: Boolean(args.overwrite),
    });
    process.exitCode = code;
  },
});
