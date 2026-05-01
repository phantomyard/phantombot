import { defineCommand } from "citty";

const editCmd = defineCommand({
  meta: {
    name: "edit",
    description: "Open the phantombot config file in $EDITOR.",
  },
  async run() {
    console.error("config edit: not yet implemented (phase 8)");
    process.exitCode = 1;
  },
});

export default defineCommand({
  meta: {
    name: "config",
    description:
      "Print resolved phantombot configuration and the paths it reads from.",
  },
  subCommands: {
    edit: editCmd,
  },
  async run() {
    console.error("config: not yet implemented (phase 8)");
    process.exitCode = 1;
  },
});
