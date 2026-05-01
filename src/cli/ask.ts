import { defineCommand } from "citty";

export default defineCommand({
  meta: {
    name: "ask",
    description: "Send a one-shot message and print the response.",
  },
  args: {
    message: {
      type: "positional",
      description: "The message to send to the agent.",
      required: true,
    },
    persona: {
      type: "string",
      description: "Persona name (overrides the configured default).",
    },
    "no-history": {
      type: "boolean",
      description: "Ignore prior turns from memory for this invocation.",
      default: false,
    },
  },
  async run() {
    console.error("ask: not yet implemented (phase 6)");
    process.exitCode = 1;
  },
});
