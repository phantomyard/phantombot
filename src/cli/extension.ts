/**
 * `phantombot extension` — install editor extensions for VS Code or Zed.
 *
 *   phantombot extension vscode   — install the VS Code chat participant
 *   phantombot extension zed      — configure Zed's context server
 *
 * VS Code: downloads the pre-compiled extension from GitHub at the current
 * version and installs to ~/.vscode/extensions/phantombot/. Requires the
 * `code` CLI on PATH (or a known install location).
 *
 * Zed: writes/updates the context server config in Zed's settings.json.
 * No download needed — the MCP server is built into the phantombot binary.
 *
 * Both commands detect the editor installation and fail with a clear message
 * if the editor is not found.
 */

import { defineCommand } from "citty";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { VERSION } from "../version.ts";

// ── GitHub download ────────────────────────────────────────────────────

const REPO = "phantomyard/phantombot";

/**
 * The version tag to fetch extension files from. Development builds use
 * `0.1.0-dev` — fall back to `main` in that case.
 */
function versionTag(): string {
  if (VERSION.includes("dev")) return "main";
  return `v${VERSION}`;
}

async function downloadFile(relPath: string): Promise<string> {
  const tag = versionTag();
  const url = `https://raw.githubusercontent.com/${REPO}/${tag}/extensions/vscode-phantombot/${relPath}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`failed to download ${relPath} (HTTP ${res.status})`);
  }
  return res.text();
}

// ── Editor detection ───────────────────────────────────────────────────

/** Try to find a CLI tool on PATH or at known install locations. */
function findCommand(
  name: string,
  macAppBundle?: string,
): string | null {
  // Try PATH first
  try {
    const result = execFileSync("which", [name], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (result) return result;
  } catch {
    // not on PATH
  }

  // macOS app bundle
  if (macAppBundle && process.platform === "darwin") {
    const appPath = macAppBundle.replace("~", homedir());
    if (existsSync(appPath)) return appPath;
  }

  return null;
}

function findVSCode(): string | null {
  return findCommand(
    "code",
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
  );
}

function findZed(): string | null {
  return findCommand(
    "zed",
    "/Applications/Zed.app/Contents/Resources/bin/zed",
  );
}

// ── VS Code installation ───────────────────────────────────────────────

const VSCODE_FILES = ["package.json", "out/extension.js", "README.md"];

function vscodeExtensionsDir(): string {
  return join(homedir(), ".vscode", "extensions");
}

function vscodeExtensionDir(): string {
  return join(vscodeExtensionsDir(), "phantombot");
}

async function installVSCode(out: NodeJS.WriteStream, err: NodeJS.WriteStream): Promise<number> {
  const codePath = findVSCode();
  if (!codePath) {
    err.write(
      "VS Code not found. Install VS Code and ensure the `code` CLI is on PATH.\n" +
        "On macOS: Cmd+Shift+P → 'Shell Command: Install code'\n" +
        "On Linux: install the 'code' package from your package manager.\n",
    );
    return 1;
  }

  const extDir = vscodeExtensionDir();
  const isUpdate = existsSync(extDir);

  out.write(`${isUpdate ? "Updating" : "Installing"} Phantombot for VS Code...\n`);

  // Download and write each file
  mkdirSync(join(extDir, "out"), { recursive: true });
  for (const file of VSCODE_FILES) {
    const content = await downloadFile(file);
    const target = join(extDir, file);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content, "utf8");
    out.write(`  ${file}\n`);
  }

  out.write(`\nInstalled to: ${extDir}\n`);
  out.write("\nNext steps:\n");
  out.write("  1. Restart VS Code\n");
  out.write('  2. Open the Chat panel (Cmd+Shift+I or Ctrl+Shift+I)\n');
  out.write("  3. Type @phantombot to talk to your agent\n");
  out.write("\nMake sure phantombot is on PATH: phantombot --version\n");
  return 0;
}

// ── Zed installation ───────────────────────────────────────────────────

function zedSettingsPath(): string | null {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Zed", "settings.json");
  }
  if (process.platform === "linux") {
    return join(homedir(), ".config", "zed", "settings.json");
  }
  return null;
}

function installZed(out: NodeJS.WriteStream, err: NodeJS.WriteStream): number {
  const zedPath = findZed();
  if (!zedPath) {
    err.write(
      "Zed not found. Install Zed from https://zed.dev or ensure `zed` is on PATH.\n",
    );
    return 1;
  }

  const settingsPath = zedSettingsPath();
  if (!settingsPath) {
    err.write(`Unsupported platform for Zed settings (${process.platform}).\n`);
    return 1;
  }

  // Read existing settings or start with empty object
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch {
      err.write(`Warning: could not parse ${settingsPath}, starting fresh.\n`);
    }
  }

  // Add/update context_servers.phantombot
  const contextServers = (settings.context_servers as Record<string, unknown>) ?? {};
  const existing = contextServers.phantombot as Record<string, unknown> | undefined;

  const desired = {
    command: "phantombot",
    args: ["editor-context-server"],
    settings: {},
  };

  if (existing?.command === desired.command &&
      JSON.stringify(existing?.args) === JSON.stringify(desired.args)) {
    out.write("Phantombot context server already configured in Zed settings.\n");
    out.write(`Settings: ${settingsPath}\n`);
    return 0;
  }

  contextServers.phantombot = desired;
  settings.context_servers = contextServers;

  // Ensure the directory exists
  mkdirSync(join(settingsPath, ".."), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");

  out.write("Phantombot context server configured for Zed.\n");
  out.write(`Settings: ${settingsPath}\n`);
  out.write("\nNext steps:\n");
  out.write("  1. Restart Zed\n");
  out.write("  2. Open the Assistant Panel (Cmd+? or Ctrl+?)\n");
  out.write("  3. Phantombot tools will appear automatically\n");
  out.write("\nMake sure phantombot is on PATH: phantombot --version\n");
  return 0;
}

// ── CLI definition ─────────────────────────────────────────────────────

export default defineCommand({
  meta: {
    name: "extension",
    description:
      "Install editor extensions. Connect VS Code or Zed to your Phantombot agent.",
  },
  args: {
    editor: {
      type: "positional",
      description: "Editor to install for: vscode or zed",
      required: true,
    },
  },
  async run({ args }) {
    const editor = String(args.editor).toLowerCase();

    switch (editor) {
      case "vscode":
        process.exitCode = await installVSCode(process.stdout, process.stderr);
        break;
      case "zed":
        process.exitCode = installZed(process.stdout, process.stderr);
        break;
      default:
        process.stderr.write(
          `Unknown editor: ${editor}\nSupported editors: vscode, zed\n`,
        );
        process.exitCode = 1;
        break;
    }
  },
});
