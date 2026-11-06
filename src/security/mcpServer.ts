/**
 * GHSA-w7w8: the bounded turn's two tools (sandbox, broker), served to an
 * external harness (claude) as a stdio MCP server. The harness runs with its
 * built-in tools OFF, so these are the only tools it has — the same surface
 * the native harness gets from phantombotSecurityExtension. The server holds
 * no credential: it forwards to the runtime-owned session (session.ts), which
 * keeps the vault and grant authority outside the model's reach.
 */
import {
  BROKER_TOOL_DESCRIPTION,
  invokeSession,
  SANDBOX_TOOL_DESCRIPTION,
  sessionFromEnv,
  sessionToolBody,
} from "./extension.ts";
import type { SessionDescriptor } from "./types.ts";

export const SECURITY_MCP_SUBCOMMAND = "__security_mcp";
export const SECURITY_MCP_SERVER = "phantombot";

export const SECURITY_MCP_TOOLS = [
  {
    name: "sandbox",
    description: SANDBOX_TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "broker",
    description: BROKER_TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        manifest: { type: "boolean" },
        operation: { type: "object" },
      },
    },
  },
] as const;

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

/** One JSON-RPC message in, at most one out (notifications get none). */
export async function handleSecurityMcp(
  message: Rpc,
  session: SessionDescriptor | undefined,
  invoke: typeof invokeSession = invokeSession,
): Promise<unknown | undefined> {
  const id = message.id;
  if (id === undefined || id === null) return undefined;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  switch (message.method) {
    case "initialize":
      return reply({
        protocolVersion:
          typeof message.params?.protocolVersion === "string"
            ? message.params.protocolVersion
            : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: SECURITY_MCP_SERVER, version: "1" },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: session ? SECURITY_MCP_TOOLS : [] });
    case "tools/call": {
      const name = message.params?.name;
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      if (!session || (name !== "sandbox" && name !== "broker"))
        return reply({
          content: [{ type: "text", text: "This tool is outside the sandbox and grants." }],
          isError: true,
        });
      try {
        const r = await invoke(session, sessionToolBody(name, args));
        return reply({ content: [{ type: "text", text: r.text }], ...(r.ok ? {} : { isError: true }) });
      } catch {
        return reply({ content: [{ type: "text", text: "session unavailable" }], isError: true });
      }
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } };
  }
}

/** Newline-delimited stdio loop; ends when the harness closes stdin. */
export async function runSecurityMcpServer(env = process.env): Promise<void> {
  const session = sessionFromEnv(env);
  const decoder = new TextDecoder();
  let buffer = "";
  const pending: Promise<void>[] = [];
  const write = (v: unknown) => process.stdout.write(JSON.stringify(v) + "\n");
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg: Rpc;
      try {
        msg = JSON.parse(line) as Rpc;
      } catch {
        write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
        continue;
      }
      pending.push(handleSecurityMcp(msg, session).then((out) => { if (out) write(out); }));
    }
  }
  await Promise.allSettled(pending);
}
