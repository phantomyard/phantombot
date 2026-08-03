/**
 * The foreground MCP-config projection (account-connector isolation, #338).
 *
 * Pins the safe-by-default behaviour: no registered servers -> the empty config
 * (byte-identical to the nightly path, no child process), and a registered
 * server -> a single `phantombot mcp proxy` stdio server. Also that a broken
 * registry can never break a turn (best-effort -> empty config).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildForegroundMcpConfig,
  EMPTY_MCP_CONFIG,
  proxyInvocation,
} from "../src/mcp/harnessConfig.ts";
import { saveRegistry, upsertServer } from "../src/mcp/registry.ts";
import { rmrf } from "./fixtures/rmrf.ts";

let workdir: string;
const savedEnv = { ...process.env };

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-mcp-hc-"));
  process.env.PHANTOMBOT_PERSONAS_DIR = workdir;
  process.env.PHANTOMBOT_DEFAULT_PERSONA = "tester";
  process.env.PHANTOMBOT_PERSONA = "tester";
});
afterEach(async () => {
  process.env = { ...savedEnv };
  await rmrf(workdir);
});

describe("buildForegroundMcpConfig", () => {
  test("no registered servers -> empty config (connectors still isolated, no child)", async () => {
    const cfg = await buildForegroundMcpConfig("tester");
    expect(cfg).toBe(EMPTY_MCP_CONFIG);
  });

  test("a registered server -> a single phantombot proxy stdio server", async () => {
    const dir = join(workdir, "tester");
    await saveRegistry(dir, upsertServer({ mcpServers: {} }, "gh", { transport: "stdio", command: "npx" }));
    const cfg = JSON.parse(await buildForegroundMcpConfig("tester"));
    expect(Object.keys(cfg.mcpServers)).toEqual(["phantombot"]);
    expect(cfg.mcpServers.phantombot.args).toContain("proxy");
    expect(cfg.mcpServers.phantombot.args).toContain("tester");
  });

  test("a broken mcp.json never breaks the turn — falls back to empty config", async () => {
    const dir = join(workdir, "tester");
    await writeFile(join(dir, "mcp.json"), "{ this is not json", "utf8").catch(async () => {
      // dir may not exist yet
      const { mkdir } = await import("node:fs/promises");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "mcp.json"), "{ this is not json", "utf8");
    });
    expect(await buildForegroundMcpConfig("tester")).toBe(EMPTY_MCP_CONFIG);
  });
});

describe("proxyInvocation", () => {
  test("includes the mcp proxy subcommand and the persona", () => {
    const { args } = proxyInvocation("lena");
    expect(args).toContain("mcp");
    expect(args).toContain("proxy");
    expect(args.slice(-2)).toEqual(["--persona", "lena"]);
  });
});
