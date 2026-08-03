/**
 * Loopback proxy: the MCP-native projection for Claude/Codex.
 *
 * Drives the REAL proxy Server through an in-memory transport pair with a real
 * SDK Client, backed by a hub over the echo fixture. Pins the lazy-discovery
 * contract: the proxy advertises ONLY the three meta-tools (not a flat dump of
 * upstream tools), mcp_search finds upstream tools, and mcp_call proxies through.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { generateSecretKey } from "nostr-tools/pure";

import { openVaultWithSecret, type Vault } from "../src/lib/vault.ts";
import { McpHub } from "../src/mcp/hub.ts";
import { buildProxyServer } from "../src/mcp/proxy.ts";
import type { McpServerEntry } from "../src/mcp/registry.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "mcp-echo-server.ts");
const echoEntry: McpServerEntry = { transport: "stdio", command: process.execPath, args: [FIXTURE], auth: { type: "none" } };

let workdir: string;
let vault: Vault;
let hub: McpHub;
let client: Client;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-mcp-proxy-"));
  vault = openVaultWithSecret(join(workdir, "p"), generateSecretKey());
  hub = new McpHub({ mcpServers: { echo: echoEntry } }, vault);
  const server = buildProxyServer(hub);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
});

afterEach(async () => {
  await client.close();
  await hub.close();
  vault.close();
  const { rmrf } = await import("./fixtures/rmrf.ts");
  await rmrf(workdir);
});

describe("proxy meta-tools", () => {
  test("advertises ONLY the three discovery meta-tools (no flat upstream dump)", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["mcp_call", "mcp_describe", "mcp_search"]);
  });

  test("mcp_search finds upstream tools namespaced by server", async () => {
    const res = (await client.callTool({ name: "mcp_search", arguments: { query: "echo" } })) as {
      content: Array<{ text: string }>;
    };
    const payload = JSON.parse(res.content[0]!.text);
    expect(payload.tools.map((t: { name: string }) => t.name)).toContain("echo__echo");
  });

  test("mcp_call proxies through to the upstream tool", async () => {
    const res = (await client.callTool({
      name: "mcp_call",
      arguments: { server: "echo", tool: "echo", args: { message: "through proxy" } },
    })) as { content: Array<{ text: string }> };
    expect(res.content[0]!.text).toContain("through proxy");
  });

  test("mcp_call accepts a single namespaced tool id too", async () => {
    const res = (await client.callTool({
      name: "mcp_call",
      arguments: { tool: "echo__echo", args: { message: "namespaced" } },
    })) as { content: Array<{ text: string }> };
    expect(res.content[0]!.text).toContain("namespaced");
  });
});
