/**
 * JetBrains installer data-loss-guard regression tests.
 *
 * Exercises the REAL `installJetbrains` against a temp config file:
 *   - JSON with a sibling key + comment → all keys preserved + block added
 *   - unparseable file → ABORT, file byte-for-byte unchanged, non-zero code
 *   - no file → creates a valid one
 *   - backup created when the file existed
 *
 * Mirrors connectors-acp-installZed.test.ts — JetBrains registration is the
 * same `agent_servers.Phantombot` merge, just into ~/.jetbrains/acp.json.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";

import {
  defaultJetbrainsConfigPath,
  installJetbrains,
} from "../src/connectors/acp/installJetbrains.ts";

class Sink {
  buf = "";
  write(s: string): boolean {
    this.buf += s;
    return true;
  }
}

let workdir: string;
let configPath: string;
const BIN = "/home/dev/.local/bin/phantombot";

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-jetbrains-"));
  configPath = join(workdir, "acp.json");
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("defaultJetbrainsConfigPath", () => {
  test("resolves to ~/.jetbrains/acp.json (not under XDG_CONFIG_HOME)", () => {
    const p = defaultJetbrainsConfigPath();
    expect(p).toBe(join(homedir(), ".jetbrains", "acp.json"));
  });

  test("ignores XDG_CONFIG_HOME (JetBrains hardcodes ~/.jetbrains)", () => {
    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = "/tmp/xdg-test";
    try {
      expect(defaultJetbrainsConfigPath()).toBe(
        join(homedir(), ".jetbrains", "acp.json"),
      );
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved;
    }
  });
});

describe("installJetbrains — JSON preservation", () => {
  test("preserves sibling keys + comment, adds the block", async () => {
    // JetBrains carries `default_mcp_settings` alongside agent_servers; a
    // comment proves we route through the JSONC-tolerant path too.
    const original = `{
  // existing JetBrains ACP config — keep me
  "default_mcp_settings": {},
  "agent_servers": {
    "Gemini": { "command": "/usr/bin/gemini", "args": ["acp"] },
  },
}`;
    writeFileSync(configPath, original, "utf8");

    const out = new Sink();
    const err = new Sink();
    const result = installJetbrains({ configPath, binaryPath: BIN, out, err });

    expect(result.code).toBe(0);
    const updated = readFileSync(configPath, "utf8");

    // Comment + pre-existing keys + the other agent survive.
    expect(updated).toContain("// existing JetBrains ACP config — keep me");
    const parsed = parse(updated) as any;
    expect(parsed.default_mcp_settings).toEqual({});
    expect(parsed.agent_servers.Gemini.command).toBe("/usr/bin/gemini");

    // Our block is present + parses with the agent registration.
    expect(parsed.agent_servers.Phantombot.command).toBe(BIN);
    expect(parsed.agent_servers.Phantombot.args).toEqual(["acp"]);
    // Same absolute PHANTOMBOT_CONFIG insurance as Zed; never PERSONAS_DIR.
    expect(parsed.agent_servers.Phantombot.env.PHANTOMBOT_CONFIG).toMatch(
      /\/phantombot\/config\.toml$/,
    );
    expect(
      parsed.agent_servers.Phantombot.env.PHANTOMBOT_PERSONAS_DIR,
    ).toBeUndefined();
  });

  test("backup of the original is created", async () => {
    const original = `{ "default_mcp_settings": {} }`;
    writeFileSync(configPath, original, "utf8");

    const result = installJetbrains({
      configPath,
      binaryPath: BIN,
      out: new Sink(),
      err: new Sink(),
    });

    expect(result.backupPath).toBe(`${configPath}.phantombot-bak`);
    expect(existsSync(result.backupPath!)).toBe(true);
    expect(readFileSync(result.backupPath!, "utf8")).toBe(original);
  });
});

describe("installJetbrains — data-loss guard", () => {
  test("unparseable file → abort, file byte-for-byte unchanged, non-zero", async () => {
    const broken = `{ "agent_servers": `;
    writeFileSync(configPath, broken, "utf8");

    const err = new Sink();
    const result = installJetbrains({
      configPath,
      binaryPath: BIN,
      out: new Sink(),
      err,
    });

    expect(result.code).toBe(1);
    expect(readFileSync(configPath, "utf8")).toBe(broken);
    expect(existsSync(`${configPath}.phantombot-bak`)).toBe(false);
    expect(err.buf).toContain("agent_servers");
    expect(err.buf).toContain("Phantombot");
  });
});

describe("installJetbrains — no existing file", () => {
  test("creates a valid acp.json with the block, no backup", async () => {
    expect(existsSync(configPath)).toBe(false);

    const result = installJetbrains({
      configPath,
      binaryPath: BIN,
      out: new Sink(),
      err: new Sink(),
    });

    expect(result.code).toBe(0);
    expect(result.backupPath).toBeUndefined();
    expect(existsSync(configPath)).toBe(true);
    const parsed = parse(readFileSync(configPath, "utf8")) as any;
    expect(parsed.agent_servers.Phantombot.command).toBe(BIN);
  });
});
