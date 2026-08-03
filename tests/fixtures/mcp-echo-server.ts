/**
 * Minimal stdio MCP server fixture for the client integration test.
 *
 * A real MCP server (via the official SDK, low-level Server API) exposing one
 * `echo` tool and one `whoami` tool that reflects an env var. Lets the client
 * test prove the stdio + env-injection path works END TO END against a genuine
 * MCP peer — not a mock.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "echo-fixture", version: "0.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo back the provided message.",
      inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
    },
    {
      name: "whoami",
      description: "Return the value of the FIXTURE_SECRET env var the server was launched with.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === "echo") {
    return { content: [{ type: "text", text: String((args as { message?: unknown })?.message ?? "") }] };
  }
  if (name === "whoami") {
    return { content: [{ type: "text", text: process.env.FIXTURE_SECRET ?? "(unset)" }] };
  }
  return { isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] };
});

await server.connect(new StdioServerTransport());
