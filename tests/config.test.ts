/**
 * Tests for config loading.
 *
 * Covers: default values when no config file exists, TOML overlay, env-var
 * overrides take priority, XDG path resolution.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, personaDir } from "../src/config.ts";

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "PHANTOMBOT_CONFIG",
  "PHANTOMBOT_DEFAULT_PERSONA",
  "PHANTOMBOT_PERSONAS_DIR",
  "PHANTOMBOT_MEMORY_DB",
  "PHANTOMBOT_TURN_TIMEOUT_MS",
  "PHANTOMBOT_HARNESS_CHAIN",
  "PHANTOMBOT_CLAUDE_BIN",
  "PHANTOMBOT_CLAUDE_MODEL",
  "PHANTOMBOT_CLAUDE_FALLBACK_MODEL",
  "PHANTOMBOT_PI_BIN",
  "PHANTOMBOT_PI_MAX_PAYLOAD",
  "PHANTOMBOT_CODEX_BIN",
  "PHANTOMBOT_CODEX_MODEL",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
];

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-config-"));
  // Snapshot and clear all relevant env vars so each test starts clean.
  for (const k of ENV_KEYS) {
    SAVED_ENV[k] = process.env[k];
    delete process.env[k];
  }
  // Point XDG dirs at the temp work dir so we don't collide with the user's real config.
  process.env.XDG_CONFIG_HOME = join(workdir, "config");
  process.env.XDG_DATA_HOME = join(workdir, "data");
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
  await rm(workdir, { recursive: true, force: true });
});

describe("loadConfig — defaults (no file)", () => {
  test("returns built-in defaults when no config file exists", async () => {
    const c = await loadConfig();
    expect(c.defaultPersona).toBe("phantom");
    expect(c.harnessIdleTimeoutMs).toBe(120_000);
    expect(c.harnessHardTimeoutMs).toBe(3_600_000);
    expect(c.harnesses.chain).toEqual(["claude"]);
    expect(c.harnesses.claude).toEqual({
      bin: "claude",
      model: "opus",
      fallbackModel: "sonnet",
    });
    expect(c.harnesses.pi).toEqual({
      bin: "pi",
      maxPayloadBytes: 1_500_000,
    });
    expect(c.harnesses.codex).toEqual({
      bin: "codex",
      model: "",
    });
  });

  test("XDG paths resolve to ~/.config and ~/.local/share by default", async () => {
    const c = await loadConfig();
    expect(c.personasDir).toBe(join(workdir, "data", "phantombot", "personas"));
    expect(c.memoryDbPath).toBe(join(workdir, "data", "phantombot", "memory.sqlite"));
    expect(c.configPath).toBe(join(workdir, "config", "phantombot", "config.toml"));
  });
});

describe("loadConfig — TOML overlay", () => {
  test("reads values from config.toml when present", async () => {
    const cfgDir = join(workdir, "config", "phantombot");
    await mkdir(cfgDir, { recursive: true });
    await writeFile(
      join(cfgDir, "config.toml"),
      `default_persona = "robbie"
turn_timeout_s = 120

[harnesses]
chain = ["pi", "claude"]

[harnesses.claude]
model = "sonnet"
fallback_model = ""

[harnesses.pi]
bin = "/opt/pi/pi"
max_payload_bytes = 500000

[harnesses.codex]
bin = "/opt/codex/codex"
model = "gpt-5.3-codex"
`,
      "utf8",
    );
    const c = await loadConfig();
    expect(c.defaultPersona).toBe("robbie");
    // Legacy turn_timeout_s preserves pre-PR-#56 semantics: a single
    // wall-clock cap with no separate idle ceiling. Aliases to BOTH
    // idle and hard so an unmodified legacy config doesn't get the
    // stricter 120s idle default applied silently.
    expect(c.harnessHardTimeoutMs).toBe(120_000);
    expect(c.harnessIdleTimeoutMs).toBe(120_000);
    expect(c.harnesses.chain).toEqual(["pi", "claude"]);
    expect(c.harnesses.claude.model).toBe("sonnet");
    expect(c.harnesses.claude.fallbackModel).toBe("");
    expect(c.harnesses.pi.bin).toBe("/opt/pi/pi");
    expect(c.harnesses.pi.maxPayloadBytes).toBe(500_000);
    expect(c.harnesses.codex).toBeDefined();
    expect(c.harnesses.codex!.bin).toBe("/opt/codex/codex");
    expect(c.harnesses.codex!.model).toBe("gpt-5.3-codex");
  });
});

describe("loadConfig — env overrides", () => {
  test("env vars take priority over TOML", async () => {
    const cfgDir = join(workdir, "config", "phantombot");
    await mkdir(cfgDir, { recursive: true });
    await writeFile(
      join(cfgDir, "config.toml"),
      `default_persona = "from-toml"
[harnesses.claude]
model = "from-toml"
`,
      "utf8",
    );
    process.env.PHANTOMBOT_DEFAULT_PERSONA = "from-env";
    process.env.PHANTOMBOT_CLAUDE_MODEL = "from-env";
    const c = await loadConfig();
    expect(c.defaultPersona).toBe("from-env");
    expect(c.harnesses.claude.model).toBe("from-env");
  });

  test("PHANTOMBOT_HARNESS_CHAIN parses comma-separated list", async () => {
    process.env.PHANTOMBOT_HARNESS_CHAIN = "claude, pi";
    const c = await loadConfig();
    expect(c.harnesses.chain).toEqual(["claude", "pi"]);
  });

  test("PHANTOMBOT_CONFIG overrides the config file path", async () => {
    const altPath = join(workdir, "alt-config.toml");
    await writeFile(altPath, `default_persona = "from-alt"`, "utf8");
    process.env.PHANTOMBOT_CONFIG = altPath;
    const c = await loadConfig();
    expect(c.defaultPersona).toBe("from-alt");
    expect(c.configPath).toBe(altPath);
  });
});

describe("personaDir", () => {
  test("joins personasDir + name", async () => {
    process.env.PHANTOMBOT_PERSONAS_DIR = "/tmp/personas";
    const c = await loadConfig();
    expect(personaDir(c, "robbie")).toBe("/tmp/personas/robbie");
  });
});

describe("loadConfig — telegramPersonas", () => {
  async function writeToml(toml: string): Promise<void> {
    const cfgDir = join(workdir, "config", "phantombot");
    await mkdir(cfgDir, { recursive: true });
    await writeFile(join(cfgDir, "config.toml"), toml, "utf8");
  }

  test("undefined when no personas block present", async () => {
    await writeToml(`
[channels.telegram]
token = "abc"
`);
    const c = await loadConfig();
    expect(c.channels.telegram?.token).toBe("abc");
    expect(c.channels.telegramPersonas).toBeUndefined();
  });

  test("parses persona-bound bots from [channels.telegram.personas.<name>]", async () => {
    await writeToml(`
[channels.telegram]
token = "default-token"
allowed_user_ids = [1]

[channels.telegram.personas.miles]
token = "miles-token"
allowed_user_ids = [2, 3]
poll_timeout_s = 25

[channels.telegram.personas.desiree]
token = "desiree-token"
`);
    const c = await loadConfig();
    expect(c.channels.telegram?.token).toBe("default-token");
    expect(c.channels.telegramPersonas).toBeDefined();
    expect(c.channels.telegramPersonas!.miles).toEqual({
      token: "miles-token",
      pollTimeoutS: 25,
      allowedUserIds: [2, 3],
    });
    expect(c.channels.telegramPersonas!.desiree).toEqual({
      token: "desiree-token",
      pollTimeoutS: 30,
      allowedUserIds: [],
    });
  });

  test("works without a default [channels.telegram] block", async () => {
    await writeToml(`
[channels.telegram.personas.miles]
token = "miles-token"
`);
    const c = await loadConfig();
    expect(c.channels.telegram).toBeUndefined();
    expect(c.channels.telegramPersonas!.miles!.token).toBe("miles-token");
  });

  test("skips persona entries without a token", async () => {
    await writeToml(`
[channels.telegram]
token = "default-token"

[channels.telegram.personas.miles]
token = "miles-token"

[channels.telegram.personas.broken]
allowed_user_ids = [9]
`);
    const c = await loadConfig();
    expect(c.channels.telegramPersonas!.miles).toBeDefined();
    expect(c.channels.telegramPersonas!.broken).toBeUndefined();
  });

  test("clamps poll_timeout_s into [1,50]", async () => {
    await writeToml(`
[channels.telegram.personas.tooBig]
token = "a"
poll_timeout_s = 9999

[channels.telegram.personas.tooSmall]
token = "b"
poll_timeout_s = 0
`);
    const c = await loadConfig();
    expect(c.channels.telegramPersonas!.tooBig!.pollTimeoutS).toBe(50);
    expect(c.channels.telegramPersonas!.tooSmall!.pollTimeoutS).toBe(1);
  });
});
