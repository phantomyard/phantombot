/**
 * Loopback MCP proxy — the single aggregated MCP server phantombot re-exposes
 * to MCP-native harnesses (Claude via --mcp-config, Codex via mcp_servers).
 *
 * It speaks MCP over stdio (a harness spawns it as `phantombot mcp proxy`) and
 * does NOT flat-dump every upstream tool. It serves the shared ToolCatalog
 * (src/pbot/catalog.ts, issue #820): the eager core `pbot_memory`,
 * `pbot_vault` and the discovery tool `pbot_tools`; everything else (the lazy
 * `pbot_*` tools and every `<server>__<tool>` on a registered server) is found
 * with `pbot_tools search` and loaded with `pbot_tools describe`. The embedded
 * pi engine drives the very same catalog in-process (src/pbot/piExtension.ts),
 * so all three harnesses see one tool surface.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { VERSION } from "../version.ts";
import type { ToolCatalog } from "../pbot/catalog.ts";

/**
 * Build (but don't connect) the proxy Server backed by a tool catalog.
 * Exported so tests can drive its request handlers directly without spawning a
 * transport.
 *
 * Since #820 the proxy serves the shared ToolCatalog (src/pbot/catalog.ts):
 * the eager `pbot_memory` / `pbot_vault` / `pbot_tools` from the first
 * tools/list, and every lazy tool (other `pbot_*`, every `<server>__<tool>`)
 * once `pbot_tools describe` loads it — announced with tools/list_changed so
 * the harness re-lists. The old mcp_search / mcp_describe / mcp_call
 * meta-tools are folded into `pbot_tools`.
 */
export function buildProxyServer(catalog: ToolCatalog): Server {
  const server = new Server(
    { name: "phantombot-mcp-proxy", version: VERSION },
    { capabilities: { tools: { listChanged: true } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: catalog.activeTools().map((t) => ({ ...t })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const before = catalog.activeTools().length;
    const result = await catalog.call(name, args);
    if (catalog.activeTools().length !== before) {
      // A describe loaded a lazy tool: tell the harness to re-list. Best
      // effort — a harness that ignores it still has pbot_tools call.
      server.sendToolListChanged().catch(() => {});
    }
    return { ...result, content: result.content.map((c) => ({ ...c })) };
  });

  return server;
}

/** Run the proxy on stdio until the transport closes. Used by `phantombot mcp proxy`. */
export async function runProxyStdio(catalog: ToolCatalog): Promise<void> {
  const server = buildProxyServer(catalog);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Resolve when the transport closes (the harness disconnects).
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
  await catalog.close();
}
