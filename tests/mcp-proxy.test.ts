/**
 * Loopback proxy: the MCP-native projection for Claude/Codex (#820).
 *
 * Drives the REAL proxy Server through an in-memory transport pair with a real
 * SDK Client, backed by the shared ToolCatalog over a hub on the echo fixture.
 * Pins the loading contract: the first tools/list is ONLY the eager core
 * (pbot_memory, pbot_vault, pbot_tools — no flat upstream dump, no lazy
 * pbot_* tools), pbot_tools search finds both lazy pbot tools and upstream
 * tools, describe loads one into the live list (announced with
 * tools/list_changed), and calls proxy through.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { generateSecretKey } from "nostr-tools/pure";

import { openVaultWithSecret, type Vault } from "../src/lib/vault.ts";
import { McpHub } from "../src/mcp/hub.ts";
import { buildProxyServer } from "../src/mcp/proxy.ts";
import type { McpServerEntry } from "../src/mcp/registry.ts";
import { ToolCatalog } from "../src/pbot/catalog.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "mcp-echo-server.ts");
const echoEntry: McpServerEntry = { transport: "stdio", command: process.execPath, args: [FIXTURE], auth: { type: "none" } };

let workdir: string;
let vault: Vault;
let hub: McpHub;
let catalog: ToolCatalog;
let client: Client;
let listChanged = 0;

type TextResult = { content: Array<{ text: string }>; isError?: boolean };

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-mcp-proxy-"));
  vault = openVaultWithSecret(join(workdir, "p"), generateSecretKey());
  hub = new McpHub({ mcpServers: { echo: echoEntry } }, vault);
  catalog = new ToolCatalog({ ctx: { persona: "tester", env: {} }, hub: async () => hub });
  const server = buildProxyServer(catalog);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  client = new Client({ name: "test", version: "0" });
  listChanged = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    listChanged++;
  });
  await client.connect(clientT);
});

afterEach(async () => {
  await client.close();
  await hub.close();
  vault.close();
  const { rmrf } = await import("./fixtures/rmrf.ts");
  await rmrf(workdir);
});

describe("proxy tool surface", () => {
  test("first tools/list = the eager core only (no upstream dump, no lazy pbot tools)", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["pbot_memory", "pbot_tools", "pbot_vault"]);
  });

  test("pbot_tools search finds lazy pbot tools AND upstream tools, namespaced", async () => {
    const res = (await client.callTool({ name: "pbot_tools", arguments: { action: "search", query: "echo task" } })) as TextResult;
    const names = JSON.parse(res.content[0]!.text).tools.map((t: { name: string }) => t.name);
    expect(names).toContain("echo__echo");
    expect(names).toContain("pbot_task");
  });

  test("describe loads an upstream tool into the live list and announces list_changed", async () => {
    await client.callTool({ name: "pbot_tools", arguments: { action: "describe", name: "echo__echo" } });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("echo__echo");
    await Bun.sleep(10);
    expect(listChanged).toBeGreaterThan(0);
  });

  test("a described upstream tool is callable by its own name", async () => {
    await client.callTool({ name: "pbot_tools", arguments: { action: "describe", name: "echo__echo" } });
    const res = (await client.callTool({ name: "echo__echo", arguments: { message: "through proxy" } })) as TextResult;
    expect(res.content[0]!.text).toContain("through proxy");
  });

  test("pbot_tools call reaches an upstream tool without describe", async () => {
    const res = (await client.callTool({
      name: "pbot_tools",
      arguments: { action: "call", name: "echo__echo", args: { message: "namespaced" } },
    })) as TextResult;
    expect(res.content[0]!.text).toContain("namespaced");
  });

  test("describe loads a lazy pbot tool into the live list", async () => {
    await client.callTool({ name: "pbot_tools", arguments: { action: "describe", name: "pbot_task" } });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("pbot_task");
  });

  test("an unknown tool is an error result, not a protocol failure", async () => {
    const res = (await client.callTool({ name: "nope__nothing", arguments: {} })) as TextResult;
    expect(res.isError).toBe(true);
  });
});
