/**
 * `phantombot acp` — register phantombot as a first-class ACP (Agent Client
 * Protocol) agent inside Zed.
 *
 *   phantombot acp                 run the ACP stdio server (Zed spawns this)
 *   phantombot acp --persona NAME  …bound to a specific persona
 *   phantombot acp install zed     write the Zed settings.json registration
 *   phantombot acp install vscode  install the first-party VS Code extension (.vsix)
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
import { installVscode } from "../connectors/acp/installVscode.ts";

const installZedCmd = defineCommand({
  meta: {
    name: "zed",
    description:
      "Register phantombot as an ACP agent in Zed's settings.json (JSONC-safe merge, backs up the original).",
  },
  async run() {
    const result = installZed({ binaryPath: process.execPath });
    // `installZed` is a one-shot synchronous file write with no pending async
    // work, but importing the ACP server pulls in modules that hold the event
    // loop open (env-reload + memory handles), so a natural exit hangs after
    // printing success. Force a clean exit once the write is done.
    process.exit(result.code);
  },
});

const installVscodeCmd = defineCommand({
  meta: {
    name: "vscode",
    description:
      "Install phantombot's first-party VS Code extension (bundled .vsix) via the `code` CLI — idempotent + version-aware. Skips cleanly if VS Code isn't installed.",
  },
  async run() {
    const result = installVscode();
    // Unlike Zed (a settings merge), VS Code installs OUR extension via the
    // `code` CLI; print the human-readable outcome line for both success and
    // the "code CLI not found" / failure cases.
    const sink = result.code === 0 ? process.stdout : process.stderr;
    sink.write(`phantombot acp install vscode: ${result.message}\n`);
    // Same event-loop caveat as installZed: importing the ACP server keeps the
    // loop open, so force a clean exit once the install is done.
    process.exit(result.code);
  },
});

const installCmd = defineCommand({
  meta: {
    name: "install",
    description:
      "Install the ACP registration into a detected editor (zed: settings merge; vscode: first-party extension).",
  },
  subCommands: {
    zed: installZedCmd,
    vscode: installVscodeCmd,
  },
});

export default defineCommand({
  meta: {
    name: "acp",
    description:
      "Run phantombot as an ACP agent server over stdio (Zed spawns this). Use `acp install zed` (settings merge) or `acp install vscode` (first-party extension) to register it with an editor.",
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
