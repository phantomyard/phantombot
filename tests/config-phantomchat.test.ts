/**
 * Tests for parsing the [channels.phantomchat] config block.
 *
 * Covers: defaults when the block is absent, TOML overlay (relays +
 * allowed_npubs), and env-var override precedence.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_PHANTOMCHAT_RELAYS, loadConfig } from "../src/config.ts";

let workdir: string;
let configPath: string;

const ENV_KEYS = [
  "PHANTOMBOT_CONFIG",
  "PHANTOMBOT_PHANTOMCHAT_RELAYS",
  "PHANTOMBOT_PHANTOMCHAT_ALLOWED_NPUBS",
];
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  workdir = await mkdtemp(join(tmpdir(), "phantombot-pc-cfg-"));
  configPath = join(workdir, "config.toml");
  process.env.PHANTOMBOT_CONFIG = configPath;
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(workdir, { recursive: true, force: true });
});

describe("[channels.phantomchat] parsing", () => {
  test("defaults to the 5 PWA relays and empty allowlist when absent", async () => {
    await writeFile(configPath, "", "utf8");
    const config = await loadConfig();
    expect(config.channels.phantomchat).toBeDefined();
    expect(config.channels.phantomchat!.relays).toEqual([
      ...DEFAULT_PHANTOMCHAT_RELAYS,
    ]);
    expect(config.channels.phantomchat!.allowedNpubs).toEqual([]);
  });

  test("reads relays + allowed_npubs from the TOML block", async () => {
    await writeFile(
      configPath,
      [
        "[channels.phantomchat]",
        'relays = ["wss://a.example", "wss://b.example"]',
        'allowed_npubs = ["npub1aaa", "npub1bbb"]',
      ].join("\n"),
      "utf8",
    );
    const config = await loadConfig();
    expect(config.channels.phantomchat!.relays).toEqual([
      "wss://a.example",
      "wss://b.example",
    ]);
    expect(config.channels.phantomchat!.allowedNpubs).toEqual([
      "npub1aaa",
      "npub1bbb",
    ]);
  });

  test("env vars override TOML for relays and allowlist", async () => {
    await writeFile(
      configPath,
      [
        "[channels.phantomchat]",
        'relays = ["wss://toml.example"]',
        'allowed_npubs = ["npub1fromtoml"]',
      ].join("\n"),
      "utf8",
    );
    process.env.PHANTOMBOT_PHANTOMCHAT_RELAYS =
      "wss://env1.example, wss://env2.example";
    process.env.PHANTOMBOT_PHANTOMCHAT_ALLOWED_NPUBS = "npub1env";

    const config = await loadConfig();
    expect(config.channels.phantomchat!.relays).toEqual([
      "wss://env1.example",
      "wss://env2.example",
    ]);
    expect(config.channels.phantomchat!.allowedNpubs).toEqual(["npub1env"]);
  });

  test("empty relays in TOML falls back to defaults", async () => {
    await writeFile(
      configPath,
      ["[channels.phantomchat]", "relays = []"].join("\n"),
      "utf8",
    );
    const config = await loadConfig();
    expect(config.channels.phantomchat!.relays).toEqual([
      ...DEFAULT_PHANTOMCHAT_RELAYS,
    ]);
  });
});
