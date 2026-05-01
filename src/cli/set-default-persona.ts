/**
 * `phantombot set-default-persona <name>` — write the new default to
 * state.json. Refuses to set a name that has no matching persona dir.
 */

import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { type Config, loadConfig, personaDir } from "../config.ts";
import type { WriteSink } from "../lib/io.ts";
import { loadState, saveState } from "../state.ts";

export interface RunSetDefaultPersonaInput {
  name: string;
  config?: Config;
  out?: WriteSink;
  err?: WriteSink;
}

export async function runSetDefaultPersona(
  input: RunSetDefaultPersonaInput,
): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;

  const config = input.config ?? (await loadConfig());
  const dir = personaDir(config, input.name);

  if (!existsSync(dir)) {
    err.write(`persona '${input.name}' not found at ${dir}\n`);
    err.write("import it first with `phantombot import-persona <openclaw-agent-dir>`\n");
    return 1;
  }

  const state = await loadState();
  state.default_persona = input.name;
  const path = await saveState(state);
  out.write(`default persona set to '${input.name}' (saved to ${path})\n`);
  return 0;
}

export default defineCommand({
  meta: {
    name: "set-default-persona",
    description:
      "Set the persona used by ask and chat when --persona is omitted.",
  },
  args: {
    name: {
      type: "positional",
      description: "Persona name to set as the default.",
      required: true,
    },
  },
  async run({ args }) {
    const code = await runSetDefaultPersona({ name: String(args.name) });
    process.exitCode = code;
  },
});
