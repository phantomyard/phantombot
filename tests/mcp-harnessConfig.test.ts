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

import { runInEngineScope } from "../src/lib/engineScope.ts";
import {
  buildForegroundMcpConfig,
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
  test("no registered servers -> STILL the proxy: it carries the pbot_* tools (#820)", async () => {
    const cfg = JSON.parse(await buildForegroundMcpConfig("tester"));
    expect(Object.keys(cfg.mcpServers)).toEqual(["phantombot"]);
    expect(cfg.mcpServers.phantombot.args).toContain("proxy");
  });

  test("a registered server -> a single phantombot proxy stdio server", async () => {
    const dir = join(workdir, "tester");
    await saveRegistry(dir, upsertServer({ mcpServers: {} }, "gh", { transport: "stdio", command: "npx" }));
    const cfg = JSON.parse(await buildForegroundMcpConfig("tester"));
    expect(Object.keys(cfg.mcpServers)).toEqual(["phantombot"]);
    expect(cfg.mcpServers.phantombot.args).toContain("proxy");
    expect(cfg.mcpServers.phantombot.args).toContain("tester");
  });

  test("a broken mcp.json never breaks the turn — the proxy is still projected", async () => {
    const dir = join(workdir, "tester");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "mcp.json"), "{ this is not json", "utf8");
    const cfg = JSON.parse(await buildForegroundMcpConfig("tester"));
    expect(Object.keys(cfg.mcpServers)).toEqual(["phantombot"]);
  });

  test("the turn's conversation and tier reach the proxy child explicitly", async () => {
    const cfg = JSON.parse(await buildForegroundMcpConfig("tester", { conversation: "telegram:1", trusted: true, turnId: "t1" }));
    expect(cfg.mcpServers.phantombot.env).toMatchObject({
      PHANTOMBOT_PERSONA: "tester",
      PHANTOMBOT_CONVERSATION: "telegram:1",
      PHANTOMBOT_TRUSTED: "1",
      PHANTOMBOT_TURN_ID: "t1",
    });
  });

  test("an untrusted turn never states PHANTOMBOT_TRUSTED", async () => {
    const cfg = JSON.parse(await buildForegroundMcpConfig("tester", { conversation: "email:x", trusted: false }));
    expect(cfg.mcpServers.phantombot.env.PHANTOMBOT_TRUSTED).toBeUndefined();
  });

  test("no secret ever rides in the projected env", async () => {
    process.env.SOME_SECRET_TOKEN = "s3cret-value";
    const cfg = await buildForegroundMcpConfig("tester", { conversation: "c" });
    expect(cfg).not.toContain("s3cret-value");
  });
});

describe("proxy child location env (codex does not inherit the parent env)", () => {
  test("outside an engine scope the parent's XDG roots and location overrides ride explicitly", async () => {
    process.env.XDG_CONFIG_HOME = "/custom/cfg";
    process.env.XDG_DATA_HOME = "/custom/data";
    process.env.XDG_STATE_HOME = "/custom/state";
    process.env.PHANTOMBOT_CONFIG = "/custom/cfg/phantombot/config.toml";
    const cfg = JSON.parse(await buildForegroundMcpConfig("tester", { conversation: "c" }));
    expect(cfg.mcpServers.phantombot.env).toMatchObject({
      XDG_CONFIG_HOME: "/custom/cfg",
      XDG_DATA_HOME: "/custom/data",
      XDG_STATE_HOME: "/custom/state",
      PHANTOMBOT_CONFIG: "/custom/cfg/phantombot/config.toml",
      PHANTOMBOT_PERSONAS_DIR: workdir,
      PHANTOMBOT_PERSONA: "tester",
    });
    expect(cfg.mcpServers.phantombot.env.PHANTOMBOT_ENGINE_SCOPE).toBeUndefined();
  });

  test("inside an engine scope only the scoped roots ride — never a host location override", async () => {
    process.env.XDG_CONFIG_HOME = "/host/cfg";
    process.env.PHANTOMBOT_CONFIG = "/host/cfg/phantombot/config.toml";
    const raw = await runInEngineScope(
      { configHome: "/app/cfg", dataHome: "/app/data", stateHome: "/app/state" },
      () => buildForegroundMcpConfig("tester", { conversation: "c" }),
    );
    const env = JSON.parse(raw).mcpServers.phantombot.env;
    expect(env).toMatchObject({
      XDG_CONFIG_HOME: "/app/cfg",
      XDG_DATA_HOME: "/app/data",
      XDG_STATE_HOME: "/app/state",
      PHANTOMBOT_ENGINE_SCOPE: "1",
    });
    expect(env.PHANTOMBOT_CONFIG).toBeUndefined();
    expect(env.PHANTOMBOT_PERSONAS_DIR).toBeUndefined();
    expect(raw).not.toContain("/host/");
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
