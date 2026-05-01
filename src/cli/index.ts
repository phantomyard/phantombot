/**
 * Citty dispatcher. Wires every subcommand into the top-level `phantombot`
 * command and exposes it for testing without invoking it.
 */

import { defineCommand } from "citty";
import askCmd from "./ask.ts";
import chatCmd from "./chat.ts";
import importPersonaCmd from "./import-persona.ts";
import listPersonasCmd from "./list-personas.ts";
import setDefaultPersonaCmd from "./set-default-persona.ts";
import historyCmd from "./history.ts";
import configCmd from "./config.ts";
import doctorCmd from "./doctor.ts";
import serveCmd from "./serve.ts";

export const mainCommand = defineCommand({
  meta: {
    name: "phantombot",
    version: "0.0.2",
    description:
      "Personality-first chat agent CLI. Wraps Claude Code and Pi CLIs with persona, memory, and OpenClaw persona import.",
  },
  subCommands: {
    ask: askCmd,
    chat: chatCmd,
    "import-persona": importPersonaCmd,
    "list-personas": listPersonasCmd,
    "set-default-persona": setDefaultPersonaCmd,
    history: historyCmd,
    config: configCmd,
    doctor: doctorCmd,
    serve: serveCmd,
  },
});
