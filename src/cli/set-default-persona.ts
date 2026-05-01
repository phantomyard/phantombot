import { defineCommand } from "citty";

export default defineCommand({
  meta: {
    name: "set-default-persona",
    description: "Set the persona used by `ask` and `chat` when --persona is omitted.",
  },
  args: {
    name: {
      type: "positional",
      description: "Persona name to set as the default.",
      required: true,
    },
  },
  async run() {
    console.error("set-default-persona: not yet implemented (phase 8)");
    process.exitCode = 1;
  },
});
