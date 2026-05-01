import { defineCommand } from "citty";

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
  async run() {
    console.error("chat: not yet implemented (phase 11)");
    process.exitCode = 1;
  },
});
