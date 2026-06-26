/**
 * `phantombot acp` — register phantombot as a first-class ACP (Agent Client
 * Protocol) agent inside Zed.
 *
 *   phantombot acp                 run the ACP stdio server (Zed spawns this)
 *   phantombot acp --persona NAME  …bound to a specific persona
 *   phantombot acp install zed     write the Zed settings.json registration
 *
 * The connector sits BESIDE the channel layer: it calls runTurn directly with
 * `trusted: true`. The principal is the local OS user who launched Zed — they
 * already have full filesystem access to everything phantombot owns, so the
 * threat judge is skipped (see connectors/acp/turnBridge.ts).
 *
 * The bare `acp` command is the long-running stdio server: Zed launches it as
 * a subprocess and talks newline-delimited JSON-RPC 2.0 over stdin/stdout.
 * stdout is the protocol channel — NEVER write logs there.
 */

import { defineCommand } from "citty";

import { runAcpServer } from "../connectors/acp/server.ts";
import { installZed } from "../connectors/acp/installZed.ts";

const installZedCmd = defineCommand({
  meta: {
    name: "zed",
    description:
      "Register phantombot as an ACP agent in Zed's settings.json (JSONC-safe merge, backs up the original).",
  },
  async run() {
    const result = installZed({ binaryPath: process.execPath });
    process.exitCode = result.code;
  },
});

const installCmd = defineCommand({
  meta: {
    name: "install",
    description: "Install the ACP registration into an editor's settings.",
  },
  subCommands: {
    zed: installZedCmd,
  },
});

export default defineCommand({
  meta: {
    name: "acp",
    description:
      "Run phantombot as an ACP agent server over stdio (Zed spawns this). Use `acp install zed` to register it.",
  },
  args: {
    persona: {
      type: "string",
      description:
        "Persona name to bind this agent to (default: the configured default persona).",
    },
  },
  subCommands: {
    install: installCmd,
  },
  async run({ args }) {
    process.exitCode = await runAcpServer({
      persona: args.persona ? String(args.persona) : undefined,
    });
  },
});
