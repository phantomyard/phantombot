import { defineCommand } from "citty";

export default defineCommand({
  meta: {
    name: "history",
    description: "Show recent turns from memory for the current persona.",
  },
  args: {
    persona: {
      type: "string",
      description: "Persona name (defaults to the configured default persona).",
    },
    n: {
      type: "string",
      description: "Number of turns to display.",
      default: "20",
    },
  },
  async run() {
    console.error("history: not yet implemented (phase 8)");
    process.exitCode = 1;
  },
});
