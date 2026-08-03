/**
 * End-to-end MCP client test against a REAL stdio MCP server (the echo
 * fixture). Proves the whole stdio path — transport wiring, connect, listTools,
 * callTool, AND env-secret injection from the vault — works against a genuine
 * MCP peer, not a mock. This is the most common auth shape (`env`), so it's the
 * one worth exercising for real.
 *
 * The http/header and oauth paths are structurally identical through the same
 * SDK transports but need a live remote server / provider to exercise, so they
 * are covered by unit tests (registry resolution, provider persistence) plus
 * manual verification noted in the PR.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateSecretKey } from "nostr-tools/pure";

import { openVaultWithSecret, type Vault } from "../src/lib/vault.ts";
import { callServerTool, connectServer, listServerTools } from "../src/mcp/client.ts";
import { McpHub } from "../src/mcp/hub.ts";
import type { McpServerEntry } from "../src/mcp/registry.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "mcp-echo-server.ts");

function stdioEntry(withSecret: boolean): McpServerEntry {
  return {
    transport: "stdio",
    command: process.execPath, // bun under `bun test`
    args: [FIXTURE],
    auth: withSecret ? { type: "env", env: { FIXTURE_SECRET: "MY_FIXTURE_KEY" } } : { type: "none" },
  };
}

let workdir: string;
let vault: Vault;
beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-mcp-int-"));
  vault = openVaultWithSecret(join(workdir, "p"), generateSecretKey());
});
afterEach(async () => {
  vault.close();
  const { rmrf } = await import("./fixtures/rmrf.ts");
  await rmrf(workdir);
});

describe("stdio client against a real MCP server", () => {
  test("connects, lists tools, and calls echo", async () => {
    const conn = await connectServer("echo", stdioEntry(false), { vault });
    try {
      const tools = await listServerTools(conn.client);
      expect(tools.map((t) => t.name).sort()).toEqual(["echo", "whoami"]);
      const result = (await callServerTool(conn.client, "echo", { message: "hello mcp" })) as {
        content: Array<{ type: string; text: string }>;
      };
      expect(result.content[0]?.text).toBe("hello mcp");
    } finally {
      await conn.close();
    }
  }, 20_000);

  test("env auth injects the vault secret into the server's process env", async () => {
    vault.set("MY_FIXTURE_KEY", "s3cr3t-from-vault");
    const conn = await connectServer("echo", stdioEntry(true), { vault });
    try {
      const result = (await callServerTool(conn.client, "whoami", {})) as {
        content: Array<{ type: string; text: string }>;
      };
      expect(result.content[0]?.text).toBe("s3cr3t-from-vault");
    } finally {
      await conn.close();
    }
  }, 20_000);

  test("a missing vault secret fails fast with the exact key to set", async () => {
    await expect(connectServer("echo", stdioEntry(true), { vault })).rejects.toThrow(/MY_FIXTURE_KEY/);
  });

  test("the hub searches tools across servers via the same connection", async () => {
    const hub = new McpHub({ mcpServers: { echo: stdioEntry(false) } }, vault);
    try {
      const { hits } = await hub.search("echo");
      expect(hits.map((h) => h.qualifiedName)).toContain("echo__echo");
      const called = (await hub.call("echo", "echo", { message: "via hub" })) as {
        content: Array<{ text: string }>;
      };
      expect(called.content[0]?.text).toBe("via hub");
    } finally {
      await hub.close();
    }
  }, 20_000);
});
