#!/usr/bin/env node
/**
 * Phantombot MCP Server for Zed
 *
 * Implements the Model Context Protocol (MCP) so Zed can route assistant
 * requests through `phantombot editor`. Zed spawns this as a child process
 * and communicates via JSON-RPC over stdio.
 *
 * Each MCP tool call builds an EditorPayload and spawns
 * `phantombot editor --stream`, streaming the response back as MCP
 * content blocks.
 *
 * Requires: phantombot installed and on PATH.
 *
 * Usage:
 *   node server/index.ts          (direct)
 *   phantombot editor-context-server  (via CLI alias)
 */

import { spawn } from "child_process";
import { createInterface } from "readline";

// ── MCP Protocol Types ─────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ── Tool Definitions ───────────────────────────────────────────────────

const TOOLS = [
  {
    name: "phantombot_ask",
    description:
      "Send a message through your Phantombot agent with full persona, memory, tools, and model routing. " +
      "Use this for general coding questions, explanations, architectural discussions, and anything " +
      "that benefits from the agent's persistent memory and multi-model routing.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message: {
          type: "string",
          description: "The message to send to the agent.",
        },
        persona: {
          type: "string",
          description: "Persona override (default: configured default persona).",
        },
        modelHint: {
          type: "string",
          enum: ["vision", "code", "fast", "reasoning"],
          description: "Model routing hint. The backend decides, but you can suggest.",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "phantombot_explain",
    description:
      "Explain code, errors, or concepts using your Phantombot agent. " +
      "Automatically includes the selected code and file context.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message: {
          type: "string",
          description:
            "What to explain (optional — defaults to 'Explain this code').",
        },
        code: {
          type: "string",
          description: "The code to explain.",
        },
        language: {
          type: "string",
          description: "The programming language.",
        },
        filePath: {
          type: "string",
          description: "Path to the file containing the code.",
        },
      },
      required: ["code"],
    },
  },
  {
    name: "phantombot_fix",
    description:
      "Fix code issues using your Phantombot agent. " +
      "Include error diagnostics, the problematic code, and file context for best results.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message: {
          type: "string",
          description: "Description of the problem (optional).",
        },
        code: {
          type: "string",
          description: "The code with the issue.",
        },
        language: {
          type: "string",
          description: "The programming language.",
        },
        filePath: {
          type: "string",
          description: "Path to the file.",
        },
        diagnostics: {
          type: "array",
          items: {
            type: "object",
            properties: {
              line: { type: "number" },
              column: { type: "number" },
              message: { type: "string" },
              severity: { type: "string", enum: ["error", "warning", "info"] },
            },
          },
          description: "Diagnostics (errors/warnings) from the editor.",
        },
      },
      required: ["code"],
    },
  },
  {
    name: "phantombot_review",
    description:
      "Review code for quality, bugs, security, and improvement opportunities " +
      "using your Phantombot agent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message: {
          type: "string",
          description:
            "Review focus (optional — defaults to a general code review).",
        },
        code: {
          type: "string",
          description: "The code to review.",
        },
        language: {
          type: "string",
          description: "The programming language.",
        },
        filePath: {
          type: "string",
          description: "Path to the file.",
        },
      },
      required: ["code"],
    },
  },
] as const;

// ── Helpers ────────────────────────────────────────────────────────────

/** Build the stdin JSON payload for `phantombot editor`. */
function buildEditorPayload(
  message: string,
  opts: {
    code?: string;
    language?: string;
    filePath?: string;
    diagnostics?: Array<{
      line: number;
      column: number;
      message: string;
      severity: "error" | "warning" | "info";
    }>;
    modelHint?: "vision" | "code" | "fast" | "reasoning";
    persona?: string;
    workspaceRoot?: string;
  } = {},
) {
  const payload: Record<string, unknown> = { message };

  if (opts.code && opts.filePath) {
    payload.activeFile = {
      path: opts.filePath,
      language: opts.language ?? "text",
      content: opts.code,
    };
  }

  if (opts.diagnostics && opts.diagnostics.length > 0) {
    payload.diagnostics = opts.diagnostics.map((d) => ({
      path: opts.filePath ?? "unknown",
      ...d,
    }));
  }

  if (opts.modelHint) payload.modelHint = opts.modelHint;
  if (opts.persona) payload.persona = opts.persona;
  if (opts.workspaceRoot) {
    payload.workspace = { root: opts.workspaceRoot, openFiles: [] };
  }

  return payload;
}

/** Spawn `phantombot editor` and collect the streaming response. */
async function runPhantombotEditor(
  payload: Record<string, unknown>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("phantombot", ["editor", "--stream"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    const textParts: string[] = [];
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === "text") {
            textParts.push(parsed.content);
          } else if (parsed.type === "error") {
            textParts.push(`[Error: ${parsed.message}]`);
          }
        } catch {
          // Non-JSON output — include as-is
          if (line.trim()) textParts.push(line);
        }
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0 && textParts.length === 0) {
        reject(
          new Error(`phantombot editor exited ${code}: ${stderr.trim()}`),
        );
      } else {
        resolve(textParts.join(""));
      }
    });

    proc.on("error", (err) => {
      reject(
        new Error(
          `Failed to spawn phantombot: ${err.message}. Is phantombot installed and on PATH?`,
        ),
      );
    });

    // Send the payload on stdin
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
}

/** Send a JSON-RPC response. */
function respond(
  id: number | string | null,
  result: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

/** Send a JSON-RPC error. */
function respondError(
  id: number | string | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

// ── Tool Handlers ──────────────────────────────────────────────────────

async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    let text: string;

    switch (name) {
      case "phantombot_ask": {
        const payload = buildEditorPayload(String(args.message), {
          modelHint: args.modelHint as any,
          persona: args.persona as string,
        });
        text = await runPhantombotEditor(payload);
        break;
      }

      case "phantombot_explain": {
        const msg =
          args.message
            ? String(args.message)
            : "Explain this code. What does it do, how does it work, and are there any issues?";
        const payload = buildEditorPayload(msg, {
          code: String(args.code),
          language: args.language as string,
          filePath: args.filePath as string,
        });
        text = await runPhantombotEditor(payload);
        break;
      }

      case "phantombot_fix": {
        const msg = args.message
          ? String(args.message)
          : "Fix the issues in this code.";
        const payload = buildEditorPayload(msg, {
          code: String(args.code),
          language: args.language as string,
          filePath: args.filePath as string,
          diagnostics: args.diagnostics as any,
        });
        text = await runPhantombotEditor(payload);
        break;
      }

      case "phantombot_review": {
        const msg = args.message
          ? String(args.message)
          : "Review this code for quality, bugs, security issues, and improvement opportunities.";
        const payload = buildEditorPayload(msg, {
          code: String(args.code),
          language: args.language as string,
          filePath: args.filePath as string,
        });
        text = await runPhantombotEditor(payload);
        break;
      }

      default:
        return {
          content: [
            { type: "text", text: `Unknown tool: ${name}` },
          ],
        };
    }

    return {
      content: [{ type: "text", text: text || "(no response)" }],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${(err as Error).message}`,
        },
      ],
    };
  }
}

// ── MCP Server ─────────────────────────────────────────────────────────

const SERVER_INFO = {
  name: "phantombot",
  version: "0.1.0",
};

const CAPABILITIES = {
  tools: {},
};

async function main() {
  const readline = createInterface({ input: process.stdin });

  for await (const line of readline) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      // Not valid JSON — skip
      continue;
    }

    const { id, method, params } = req;

    try {
      switch (method) {
        case "initialize": {
          const response = respond(id, {
            protocolVersion: "2024-11-05",
            capabilities: CAPABILITIES,
            serverInfo: SERVER_INFO,
          });
          process.stdout.write(JSON.stringify(response) + "\n");
          break;
        }

        case "notifications/initialized": {
          // No response needed for notifications
          break;
        }

        case "tools/list": {
          const response = respond(id, { tools: TOOLS });
          process.stdout.write(JSON.stringify(response) + "\n");
          break;
        }

        case "tools/call": {
          const toolName = (params as any)?.name;
          const toolArgs = (params as any)?.arguments ?? {};
          const result = await handleToolCall(toolName, toolArgs);
          const response = respond(id, result);
          process.stdout.write(JSON.stringify(response) + "\n");
          break;
        }

        case "ping": {
          const response = respond(id, {});
          process.stdout.write(JSON.stringify(response) + "\n");
          break;
        }

        default: {
          // Unknown method — respond with method not found
          const response = respondError(id, -32601, `Method not found: ${method}`);
          process.stdout.write(JSON.stringify(response) + "\n");
          break;
        }
      }
    } catch (err) {
      const response = respondError(
        id,
        -32603,
        `Internal error: ${(err as Error).message}`,
      );
      process.stdout.write(JSON.stringify(response) + "\n");
    }
  }
}

main();
