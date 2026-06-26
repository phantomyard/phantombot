/**
 * `phantombot editor-context-server` — MCP server for editor extensions.
 *
 * Spawns a Model Context Protocol (MCP) server on stdio that bridges
 * to `phantombot editor`. Zed (and eventually other editors) connect
 * to this server to route assistant requests through Phantombot's
 * persona + harness chain.
 *
 * This is a thin shim — the actual MCP protocol handling lives in
 * extensions/zed-phantombot/server/index.js. This command just
 * ensures phantombot is installed and delegates.
 *
 * Usage:
 *   phantombot editor-context-server
 *   # (Zed settings.json: "command": "phantombot", "args": ["editor-context-server"])
 */

import { defineCommand } from "citty";
import { spawn } from "node:child_process";

export default defineCommand({
  meta: {
    name: "editor-context-server",
    description:
      "MCP context server for editor extensions. Spawns the MCP bridge on stdio — designed to be started by Zed or other editors.",
  },
  async run() {
    // Resolve the MCP server script relative to this file
    const serverPath = [
      // Built from repo root: extensions/zed-phantombot/server/index.js
      // When running from source (bun src/index.ts), go up to repo root
      "../../extensions/zed-phantombot/server/index.js",
      // When compiled to a binary, the path is different — fallback to PATH lookup
    ];

    // Try to find the server script
    let resolvedPath: string | null = null;
    for (const rel of serverPath) {
      const candidate = new URL(rel, import.meta.url).pathname;
      try {
        const { statSync } = await import("node:fs");
        if (statSync(candidate).isFile()) {
          resolvedPath = candidate;
          break;
        }
      } catch {
        // not found, try next
      }
    }

    if (resolvedPath) {
      // Found the server script — spawn it directly
      const proc = spawn(process.execPath, [resolvedPath], {
        stdio: ["inherit", "inherit", "inherit"],
      });
      proc.on("exit", (code) => {
        process.exitCode = code ?? 1;
      });
    } else {
      // Fallback: try to run via node with the extensions path
      // This handles the case where phantombot is installed globally
      // but the extensions directory is at a known location
      const altPaths = [
        `${process.env.HOME}/.config/phantombot/extensions/zed-phantombot/server/index.js`,
        `${process.env.HOME}/phantombot/extensions/zed-phantombot/server/index.js`,
      ];

      for (const alt of altPaths) {
        try {
          const { statSync } = await import("node:fs");
          if (statSync(alt).isFile()) {
            const proc = spawn(process.execPath, [alt], {
              stdio: ["inherit", "inherit", "inherit"],
            });
            proc.on("exit", (code) => {
              process.exitCode = code ?? 1;
            });
            return;
          }
        } catch {
          // not found
        }
      }

      process.stderr.write(
        "phantombot editor-context-server: could not find MCP server script.\n" +
          "Expected at: extensions/zed-phantombot/server/index.js\n" +
          "Install phantombot from source or set the path in Zed settings.\n",
      );
      process.exitCode = 1;
    }
  },
});
