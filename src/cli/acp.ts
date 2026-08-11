/**
 * `phantombot acp` — register phantombot as a first-class ACP (Agent Client
 * Protocol) agent inside an ACP-capable editor (Zed, JetBrains IDEs, …).
 *
 *   phantombot acp                 run the ACP stdio server (the editor spawns this)
 *   phantombot acp --persona NAME  …bound to a specific persona
 *   phantombot acp install zed       write the Zed settings.json registration
 *   phantombot acp install jetbrains write the JetBrains ~/.jetbrains/acp.json registration
 *   phantombot acp install vscode    install the first-party VS Code extension (.vsix)
 *
 * The connector sits BESIDE the channel layer: it calls runTurn directly with
 * `trusted: true`. The principal is the local OS user who launched the editor —
 * they already have full filesystem access to everything phantombot owns, so the
 * threat judge is skipped (see connectors/acp/turnBridge.ts).
 *
 * The bare `acp` command is the long-running stdio server: the editor launches it
 * as a subprocess and talks newline-delimited JSON-RPC 2.0 over stdin/stdout.
 * stdout is the protocol channel — NEVER write logs there.
 */

import { defineCommand } from "citty";

import { runAcpServer } from "../connectors/acp/server.ts";
import { installZed } from "../connectors/acp/installZed.ts";
import { installJetbrains } from "../connectors/acp/installJetbrains.ts";
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

const installJetbrainsCmd = defineCommand({
  meta: {
    name: "jetbrains",
    description:
      "Register phantombot as an ACP agent for JetBrains IDEs (Rider, IntelliJ, WebStorm, …) in ~/.jetbrains/acp.json (JSON-safe merge, backs up the original).",
  },
  async run() {
    const result = installJetbrains({ binaryPath: process.execPath });
    // Same event-loop caveat as installZed: importing the ACP server keeps the
    // loop open, so force a clean exit once the write is done.
    process.exit(result.code);
  },
});

const installVscodeCmd = defineCommand({
  meta: {
    name: "vscode",
    description:
      "Install phantombot's first-party VS Code extension (bundled .vsix) via the `code` CLI — idempotent + version-aware. Forces a reinstall by default so an orphaned/ghosted install self-heals; pass --no-force to keep the version gate. Skips cleanly if VS Code isn't installed.",
  },
  args: {
    force: {
      type: "boolean",
      description:
        "Re-lay the bundled extension even when the reported version is already current. This heals an orphaned install where VS Code's registry still lists the extension but its on-disk folder was pruned (the version gate alone reads the registry and would no-op forever). Default: true; pass --no-force to only install when missing or older.",
      default: true,
    },
  },
  async run({ args }) {
    // Explicit `acp install vscode` forces by default — a user running it by
    // hand almost always wants a real reinstall (the ghost-install fix). The
    // automatic reconcile loop stays version-gated and never sets force.
    const result = installVscode({ force: args.force !== false });
    // Unlike Zed (a settings merge), VS Code installs OUR extension via the
    // `code` CLI; print the human-readable outcome line for both success and
    // the "code CLI not found" / failure cases.
    const sink = result.code === 0 ? process.stdout : process.stderr;
    sink.write(`phantombot acp install vscode: ${result.message}\n`);
    // VS Code loads extensions at startup, so a freshly installed/upgraded
    // build sits on disk doing nothing until the window reloads. Say so —
    // otherwise the user updates, sees the old broken behaviour, and
    // reasonably concludes the update did nothing. Only worth saying when we
    // actually changed something ("current" / "not-detected" need no action).
    if (
      result.action === "installed" ||
      result.action === "updated" ||
      result.action === "reinstalled"
    ) {
      sink.write(
        "  restart VS Code (or run “Developer: Reload Window”) to load it.\n",
      );
    }
    // Same event-loop caveat as installZed: importing the ACP server keeps the
    // loop open, so force a clean exit once the install is done.
    process.exit(result.code);
  },
});

const installCmd = defineCommand({
  meta: {
    name: "install",
    description:
      "Install the ACP registration into a detected editor (zed/jetbrains: settings merge; vscode: first-party extension).",
  },
  subCommands: {
    zed: installZedCmd,
    jetbrains: installJetbrainsCmd,
    vscode: installVscodeCmd,
  },
});

export default defineCommand({
  meta: {
    name: "acp",
    description:
      "Run phantombot as an ACP agent server over stdio (Zed/JetBrains spawn this). Use `acp install zed` / `acp install jetbrains` (settings merge) or `acp install vscode` (first-party extension) to register it with an editor.",
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
