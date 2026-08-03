/**
 * Loopback MCP proxy — the single aggregated MCP server phantombot re-exposes
 * to MCP-native harnesses (Claude via --mcp-config, Codex via mcp_servers).
 *
 * It speaks MCP over stdio (so a harness spawns it as `phantombot mcp proxy`)
 * and, crucially, does NOT flat-dump every upstream tool. Instead it exposes a
 * small discovery meta-toolset — the SAME lazy-discovery model the CLI uses and
 * the same shape as phantombot's own deferred-tool / ToolSearch primitive:
 *
 *   mcp_search   { query }                  -> namespaced tool names + summaries
 *   mcp_describe { server }                 -> full input schemas for one server
 *   mcp_call     { server, tool, args }     -> invoke a tool, return its result
 *
 * So Claude/Codex see three cheap entrypoints instead of hundreds of schemas,
 * and the upstream connections + vault tokens are shared with the CLI via the
 * one McpHub. This is the "one proxy, one registry, one token store behind both
 * faces" design.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { VERSION } from "../version.ts";
import { McpHub, splitQualified } from "./hub.ts";

/** The three discovery meta-tools the proxy advertises. Hand-written JSON schemas (no zod in our code). */
const META_TOOLS = [
  {
    name: "mcp_search",
    description:
      "Search tools across all registered MCP servers by keyword. Returns namespaced tool names (server__tool) and one-line summaries. Use this FIRST — do not assume a tool exists.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords to match against tool names and descriptions. Empty lists everything." },
      },
    },
  },
  {
    name: "mcp_describe",
    description:
      "Load the full input schemas for every tool on ONE registered MCP server. Call after mcp_search narrows to a server.",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string", description: "The server id to describe." },
      },
      required: ["server"],
    },
  },
  {
    name: "mcp_call",
    description:
      "Invoke a tool on a registered MCP server. Provide the server id, the (unqualified) tool name, and its arguments object.",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string", description: "The server id." },
        tool: { type: "string", description: "The tool name (unqualified, e.g. 'search' not 'gmail__search')." },
        args: { type: "object", description: "The tool's arguments object." },
      },
      required: ["server", "tool"],
    },
  },
] as const;

function textResult(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text", text }] };
}

/**
 * Build (but don't connect) the proxy Server backed by a hub. Exported so tests
 * can drive its request handlers directly without spawning a transport.
 */
export function buildProxyServer(hub: McpHub): Server {
  const server = new Server(
    { name: "phantombot-mcp-proxy", version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: META_TOOLS.map((t) => ({ ...t })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    try {
      switch (name) {
        case "mcp_search": {
          const { hits, errors } = await hub.search(String(args.query ?? ""));
          return textResult({
            tools: hits.map((h) => ({ name: h.qualifiedName, description: h.tool.description })),
            ...(Object.keys(errors).length > 0 ? { unreachable: errors } : {}),
          });
        }
        case "mcp_describe": {
          const serverId = String(args.server ?? "");
          const tools = await hub.tools(serverId);
          return textResult({ server: serverId, tools });
        }
        case "mcp_call": {
          // Accept either { server, tool } or a single namespaced `tool`.
          let serverId = args.server ? String(args.server) : "";
          let toolName = String(args.tool ?? "");
          if (!serverId) {
            const split = splitQualified(toolName);
            if (split) {
              serverId = split.server;
              toolName = split.tool;
            }
          }
          if (!serverId || !toolName) throw new Error("mcp_call needs both 'server' and 'tool'");
          const result = await hub.call(serverId, toolName, (args.args ?? {}) as Record<string, unknown>);
          return textResult(result);
        }
        default:
          throw new Error(`unknown meta-tool: ${name}`);
      }
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: (err as Error).message }] };
    }
  });

  return server;
}

/** Run the proxy on stdio until the transport closes. Used by `phantombot mcp proxy`. */
export async function runProxyStdio(hub: McpHub): Promise<void> {
  const server = buildProxyServer(hub);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Resolve when the transport closes (the harness disconnects).
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
  await hub.close();
}
