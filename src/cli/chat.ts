/**
 * `phantombot chat` — interactive REPL.
 *
 * Citty wrapper. The REPL itself is in src/repl/index.ts.
 */

import { defineCommand } from "citty";
import { runChat } from "../repl/index.ts";

export default defineCommand({
  meta: {
    name: "chat",
    description: "Open an interactive chat REPL.",
  },
  args: {
    persona: {
      type: "string",
      description: "Persona name (overrides the configured default).",
    },
  },
  async run({ args }) {
    const code = await runChat({
      persona: args.persona ? String(args.persona) : undefined,
    });
    process.exitCode = code;
  },
});
