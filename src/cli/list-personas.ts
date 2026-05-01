/**
 * `phantombot list-personas` — print every persona under personasDir,
 * marking which is currently the default.
 *
 * A "persona" is a subdirectory that contains an identity file
 * (BOOT.md / SOUL.md / IDENTITY.md). Subdirs without one are skipped
 * silently — they're not personas phantombot can use.
 */

import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type Config, loadConfig } from "../config.ts";
import type { WriteSink } from "../lib/io.ts";

const IDENTITY_FILES = ["BOOT.md", "SOUL.md", "IDENTITY.md"];

export interface RunListPersonasInput {
  config?: Config;
  out?: WriteSink;
  err?: WriteSink;
}

export interface PersonaListing {
  name: string;
  identityFile: string;
  isDefault: boolean;
}

export async function listPersonas(config: Config): Promise<PersonaListing[]> {
  if (!existsSync(config.personasDir)) return [];
  const entries = await readdir(config.personasDir, { withFileTypes: true });
  const out: PersonaListing[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const personaPath = join(config.personasDir, e.name);
    const identity = IDENTITY_FILES.find((f) =>
      existsSync(join(personaPath, f)),
    );
    if (!identity) continue;
    out.push({
      name: e.name,
      identityFile: identity,
      isDefault: e.name === config.defaultPersona,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function runListPersonas(
  input: RunListPersonasInput = {},
): Promise<number> {
  const out = input.out ?? process.stdout;
  const config = input.config ?? (await loadConfig());
  const personas = await listPersonas(config);

  if (personas.length === 0) {
    out.write(`no personas found at ${config.personasDir}\n`);
    out.write("import one with `phantombot import-persona <openclaw-agent-dir>`\n");
    return 0;
  }

  out.write(`personas at ${config.personasDir}:\n`);
  for (const p of personas) {
    const marker = p.isDefault ? "*" : " ";
    out.write(`  ${marker} ${p.name}  (${p.identityFile})\n`);
  }
  out.write("\n* = default. Change with `phantombot set-default-persona <name>`.\n");
  return 0;
}

export default defineCommand({
  meta: {
    name: "list-personas",
    description: "List all available personas and which is the default.",
  },
  async run() {
    const code = await runListPersonas();
    process.exitCode = code;
  },
});
