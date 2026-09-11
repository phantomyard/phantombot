/**
 * The MCP screen's data path (Configure → MCP Servers).
 *
 * Listing and probing are separate functions because they have different
 * failure modes, and the screen has to stay usable when probing is the thing
 * that is broken — the server you cannot reach is usually the one you opened
 * the screen to delete.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deleteMcpServer,
  listMcpServers,
  probeMcpServer,
} from "../src/tui/mcpFlow.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function personaDir(registry: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "phantombot-mcpflow-"));
  dirs.push(dir);
  writeFileSync(join(dir, "mcp.json"), JSON.stringify(registry));
  return dir;
}

describe("listMcpServers", () => {
  test("reads the registry without connecting to anything", async () => {
    // The command here does not exist. If listing probed, this would throw or
    // hang; it must return a row with status `unknown` instead.
    const dir = personaDir({
      mcpServers: {
        broken: { transport: "stdio", command: "definitely-not-installed" },
      },
    });
    const rows = await listMcpServers(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("broken");
    expect(rows[0]!.status).toBe("unknown");
    expect(rows[0]!.target).toBe("definitely-not-installed");
  });

  test("a persona with no registry file has no servers, and that is not an error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phantombot-mcpflow-"));
    dirs.push(dir);
    expect(await listMcpServers(dir)).toEqual([]);
  });

  test("carries the vault keys an entry references, for the delete confirm", async () => {
    const dir = personaDir({
      mcpServers: {
        remote: {
          transport: "http",
          url: "https://example.invalid/mcp",
          auth: {
            type: "header",
            header: "Authorization",
            valueRef: "MCP_REMOTE_TOKEN",
          },
        },
      },
    });
    const rows = await listMcpServers(dir);
    expect(rows[0]!.secrets).toEqual(["MCP_REMOTE_TOKEN"]);
    expect(rows[0]!.auth).toBe("header");
  });
});

describe("probeMcpServer", () => {
  test("reports the client's own error rather than a generic failure", async () => {
    // A spawn failure is the most common real one, and the message the client
    // produces ("command not found", ENOENT) is what the operator needs. A
    // wrapper sentence would bury it.
    const dir = personaDir({
      mcpServers: {
        broken: { transport: "stdio", command: "definitely-not-installed-xyz" },
      },
    });
    const result = await probeMcpServer(dir, "broken", 8_000);
    expect(result.ok).toBe(false);
    expect(result.detail.length).toBeGreaterThan(0);
    expect(result.detail).not.toBe("unreachable");
  });

  test("a server that is not registered says so, and does not throw", async () => {
    const dir = personaDir({ mcpServers: {} });
    expect(await probeMcpServer(dir, "ghost")).toEqual({
      ok: false,
      detail: "not registered",
    });
  });
});

describe("deleteMcpServer", () => {
  test("removes the entry and leaves the others alone", async () => {
    const dir = personaDir({
      mcpServers: {
        a: { transport: "stdio", command: "a" },
        b: { transport: "stdio", command: "b" },
      },
    });
    const result = await deleteMcpServer({ personaDir: dir, name: "a" });
    expect(result).toEqual({ ok: true, purged: [] });
    expect((await listMcpServers(dir)).map((r) => r.name)).toEqual(["b"]);
  });

  test("keeps the vault secrets unless purging is asked for", async () => {
    // Default-off is the point: the registry entry is re-addable from notes,
    // the vault is the only copy of the credential.
    const dir = personaDir({
      mcpServers: {
        remote: {
          transport: "http",
          url: "https://example.invalid/mcp",
          auth: {
            type: "header",
            header: "Authorization",
            valueRef: "MCP_REMOTE_TOKEN",
          },
        },
      },
    });
    const result = await deleteMcpServer({ personaDir: dir, name: "remote" });
    expect(result.purged).toEqual([]);
  });

  test("deleting something that is not there is an error, not a silent success", async () => {
    const dir = personaDir({ mcpServers: {} });
    const result = await deleteMcpServer({ personaDir: dir, name: "ghost" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ghost");
  });
});
