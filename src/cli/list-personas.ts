import { defineCommand } from "citty";

export default defineCommand({
  meta: {
    name: "list-personas",
    description: "List all available personas and which is the default.",
  },
  async run() {
    console.error("list-personas: not yet implemented (phase 8)");
    process.exitCode = 1;
  },
});
