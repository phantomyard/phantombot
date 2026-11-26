/**
 * Upstream MCP results that carry BOTH human-readable `content` and
 * `structuredContent` keep the structured data on every path (PR #821
 * review): the catalog normaliser, the MCP proxy (claude/codex) and the pi
 * adapter. The pre-#820 proxy returned the whole result; dropping
 * structuredContent whenever text was present broke that parity.
 */

import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { McpHub } from "../src/mcp/hub.ts";
import { buildProxyServer } from "../src/mcp/proxy.ts";
import { fromMcpResult, ToolCatalog } from "../src/pbot/catalog.ts";
import { registerCatalogOnPi, type PbotPiApi } from "../src/pbot/piExtension.ts";

const MIXED = { content: [{ type: "text", text: "summary" }], structuredContent: { answer: 42 } };

function mixedCatalog(): ToolCatalog {
  const hub = { call: async () => MIXED } as unknown as McpHub;
  return new ToolCatalog({ ctx: { env: {} }, hub: async () => hub, tools: [] });
}

describe("structuredContent survives the catalog", () => {
  test("fromMcpResult keeps text AND structuredContent", () => {
    const r = fromMcpResult(MIXED);
    expect(r.structuredContent).toEqual({ answer: 42 });
    expect(r.content).toEqual([
      { type: "text", text: "summary" },
      { type: "text", text: '{"answer":42}' },
    ]);
  });

  test("a text block that already IS the JSON is not duplicated", () => {
    const r = fromMcpResult({ content: [{ type: "text", text: '{"answer":42}' }], structuredContent: { answer: 42 } });
    expect(r.content).toEqual([{ type: "text", text: '{"answer":42}' }]);
  });

  test("structured-only results still render, error flag kept", () => {
    const r = fromMcpResult({ structuredContent: { a: 1 }, isError: true });
    expect(r).toEqual({ content: [{ type: "text", text: '{"a":1}' }], structuredContent: { a: 1 }, isError: true });
  });

  test("the MCP proxy hands clients the structuredContent", async () => {
    const server = buildProxyServer(mixedCatalog());
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientT);
    try {
      const r = (await client.callTool({ name: "echo__mixed", arguments: {} })) as {
        content: Array<{ type: string; text: string }>;
        structuredContent?: unknown;
      };
      expect(r.structuredContent).toEqual({ answer: 42 });
      expect(r.content.map((c) => c.text)).toContain("summary");
    } finally {
      await client.close();
    }
  });

  test("the pi adapter shows the data to the model and keeps it in details", async () => {
    const tools = new Map<string, Parameters<PbotPiApi["registerTool"]>[0]>();
    registerCatalogOnPi({ registerTool: (t) => void tools.set(t.name, t) }, mixedCatalog());
    const r = await tools.get("pbot_tools")!.execute("1", { action: "call", name: "echo__mixed", args: {} });
    expect(r.content.map((c) => (c as { text: string }).text)).toEqual(["summary", '{"answer":42}']);
    expect(r.details).toEqual({ structuredContent: { answer: 42 } });
  });
});
