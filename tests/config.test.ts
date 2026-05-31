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
import {
  DEFAULT_RETRIEVAL,
  DEFAULT_TELEGRAM_STREAMING,
  DEFAULT_TURN_INDEXING,
  loadConfig,
  memoryIndexPath,
  personaDir,
  personaEnvSuffix,
} from "../src/config.ts";

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
  "PHANTOMBOT_RETRIEVAL_ENABLED",
  "PHANTOMBOT_RETRIEVAL_LIMIT",
  "PHANTOMBOT_RETRIEVAL_MAX_TOKENS",
  "PHANTOMBOT_RETRIEVAL_MIN_SCORE",
  "PHANTOMBOT_RETRIEVAL_TURN_INDEXING_ENABLED",
  "PHANTOMBOT_RETRIEVAL_TURN_INDEXING_INTERVAL",
  "PHANTOMBOT_RETRIEVAL_TURN_INDEXING_BATCH_SIZE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  // Per-persona Telegram env vars touched by the persona-bound bots
  // tests below. Cleared per-test so a developer's real shell env
  // can't leak in.
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_BOT_TOKEN_MILES",
  "TELEGRAM_BOT_TOKEN_DESIREE",
  "TELEGRAM_BOT_TOKEN_BROKEN",
  "TELEGRAM_BOT_TOKEN_MY_BOT_TEST",
  "PHANTOMBOT_TELEGRAM_ALLOWED_USERS",
  "PHANTOMBOT_TELEGRAM_ALLOWED_USERS_MILES",
  "PHANTOMBOT_TELEGRAM_POLL_S",
  "PHANTOMBOT_TELEGRAM_POLL_S_MILES",
  "PHANTOMBOT_TELEGRAM_NARRATION_FLUSH_MS",
  "PHANTOMBOT_TELEGRAM_BUBBLE_MAX_SENTENCES",
  "PHANTOMBOT_TELEGRAM_BUBBLE_MAX_CHARS",
  "PHANTOMBOT_TELEGRAM_BUBBLE_DELAY_MS",
  "PHANTOMBOT_TELEGRAM_VOICE_MAX_SENTENCES",
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
    expect(c.telegramStreaming).toEqual(DEFAULT_TELEGRAM_STREAMING);
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

  test("reads Telegram streaming knobs from [channels.telegram.streaming]", async () => {
    const cfgDir = join(workdir, "config", "phantombot");
    await mkdir(cfgDir, { recursive: true });
    await writeFile(
      join(cfgDir, "config.toml"),
      `[channels.telegram.streaming]
narration_flush_ms = 3000
bubble_max_sentences = 3
bubble_max_chars = 500
bubble_delay_ms = 250
voice_max_sentences = 2
`,
      "utf8",
    );

    const c = await loadConfig();
    expect(c.telegramStreaming).toEqual({
      narrationFlushMs: 3000,
      bubbleMaxSentences: 3,
      bubbleMaxChars: 500,
      bubbleDelayMs: 250,
      voiceMaxSentences: 2,
    });
  });

  test("clamps Telegram streaming knobs to sane bounds", async () => {
    const cfgDir = join(workdir, "config", "phantombot");
    await mkdir(cfgDir, { recursive: true });
    await writeFile(
      join(cfgDir, "config.toml"),
      `[channels.telegram.streaming]
narration_flush_ms = 1
bubble_max_sentences = 0
bubble_max_chars = 50
bubble_delay_ms = 99999
voice_max_sentences = 99
`,
      "utf8",
    );

    const c = await loadConfig();
    expect(c.telegramStreaming).toEqual({
      narrationFlushMs: 500,
      bubbleMaxSentences: 1,
      bubbleMaxChars: 100,
      bubbleDelayMs: 10_000,
      voiceMaxSentences: 20,
    });
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

  test("Telegram streaming env vars override TOML", async () => {
    const cfgDir = join(workdir, "config", "phantombot");
    await mkdir(cfgDir, { recursive: true });
    await writeFile(
      join(cfgDir, "config.toml"),
      `[channels.telegram.streaming]
narration_flush_ms = 3000
bubble_max_sentences = 3
bubble_max_chars = 500
bubble_delay_ms = 250
voice_max_sentences = 2
`,
      "utf8",
    );

    process.env.PHANTOMBOT_TELEGRAM_NARRATION_FLUSH_MS = "6000";
    process.env.PHANTOMBOT_TELEGRAM_BUBBLE_MAX_SENTENCES = "5";
    process.env.PHANTOMBOT_TELEGRAM_BUBBLE_MAX_CHARS = "900";
    process.env.PHANTOMBOT_TELEGRAM_BUBBLE_DELAY_MS = "100";
    process.env.PHANTOMBOT_TELEGRAM_VOICE_MAX_SENTENCES = "4";

    const c = await loadConfig();
    expect(c.telegramStreaming).toEqual({
      narrationFlushMs: 6000,
      bubbleMaxSentences: 5,
      bubbleMaxChars: 900,
      bubbleDelayMs: 100,
      voiceMaxSentences: 4,
    });
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
      groupPersonaNames: [],
    });
    expect(c.channels.telegramPersonas!.desiree).toEqual({
      token: "desiree-token",
      pollTimeoutS: 30,
      allowedUserIds: [],
      groupPersonaNames: [],
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

  test("TELEGRAM_BOT_TOKEN_<PERSONA> env wins over toml token", async () => {
    await writeToml(`
[channels.telegram.personas.miles]
token = "from-toml"
`);
    process.env.TELEGRAM_BOT_TOKEN_MILES = "from-env";
    const c = await loadConfig();
    expect(c.channels.telegramPersonas!.miles!.token).toBe("from-env");
  });

  test("TELEGRAM_BOT_TOKEN_<PERSONA> env lets you omit token from toml entirely", async () => {
    await writeToml(`
[channels.telegram.personas.miles]
allowed_user_ids = [7]
`);
    process.env.TELEGRAM_BOT_TOKEN_MILES = "env-only";
    const c = await loadConfig();
    expect(c.channels.telegramPersonas!.miles).toEqual({
      token: "env-only",
      pollTimeoutS: 30,
      allowedUserIds: [7],
      groupPersonaNames: [],
    });
  });

  test("PHANTOMBOT_TELEGRAM_ALLOWED_USERS_<PERSONA> overrides toml allow-list", async () => {
    await writeToml(`
[channels.telegram.personas.miles]
token = "t"
allowed_user_ids = [1, 2]
`);
    process.env.PHANTOMBOT_TELEGRAM_ALLOWED_USERS_MILES = "10, 20 , 30";
    const c = await loadConfig();
    expect(c.channels.telegramPersonas!.miles!.allowedUserIds).toEqual([
      10, 20, 30,
    ]);
  });

  test("PHANTOMBOT_TELEGRAM_POLL_S_<PERSONA> overrides toml poll_timeout_s", async () => {
    await writeToml(`
[channels.telegram.personas.miles]
token = "t"
poll_timeout_s = 10
`);
    process.env.PHANTOMBOT_TELEGRAM_POLL_S_MILES = "45";
    const c = await loadConfig();
    expect(c.channels.telegramPersonas!.miles!.pollTimeoutS).toBe(45);
  });

  test("persona name with non-alphanumeric chars maps to underscore-safe env var", async () => {
    // "my-bot.test" → "MY_BOT_TEST" — matches what users would write in
    // a systemd unit or .env without surprise.
    expect(personaEnvSuffix("my-bot.test")).toBe("MY_BOT_TEST");
    await writeToml(`
[channels.telegram.personas."my-bot.test"]
`);
    process.env.TELEGRAM_BOT_TOKEN_MY_BOT_TEST = "env-token";
    const c = await loadConfig();
    expect(c.channels.telegramPersonas!["my-bot.test"]!.token).toBe(
      "env-token",
    );
  });
});

describe("loadConfig — retrieval", () => {
  async function writeToml(toml: string): Promise<void> {
    const cfgDir = join(workdir, "config", "phantombot");
    await mkdir(cfgDir, { recursive: true });
    await writeFile(join(cfgDir, "config.toml"), toml, "utf8");
  }

  test("defaults when no config file exists", async () => {
    const c = await loadConfig();
    expect(c.retrieval).toEqual(DEFAULT_RETRIEVAL);
  });

  test("TOML [retrieval] overrides defaults", async () => {
    await writeToml(`
[retrieval]
enabled = false
limit = 8
max_tokens = 3000
min_score = 0.25
`);
    const c = await loadConfig();
    expect(c.retrieval).toEqual({
      enabled: false,
      limit: 8,
      maxTokens: 3000,
      minScore: 0.25,
      turnIndexing: DEFAULT_TURN_INDEXING,
    });
  });

  test("env vars override TOML", async () => {
    await writeToml(`
[retrieval]
enabled = true
limit = 5
`);
    process.env.PHANTOMBOT_RETRIEVAL_ENABLED = "false";
    process.env.PHANTOMBOT_RETRIEVAL_LIMIT = "12";
    process.env.PHANTOMBOT_RETRIEVAL_MAX_TOKENS = "2200";
    process.env.PHANTOMBOT_RETRIEVAL_MIN_SCORE = "0.4";
    const c = await loadConfig();
    expect(c.retrieval).toEqual({
      enabled: false,
      limit: 12,
      maxTokens: 2200,
      minScore: 0.4,
      turnIndexing: DEFAULT_TURN_INDEXING,
    });
  });

  test("TOML [retrieval.turn_indexing] overrides defaults", async () => {
    await writeToml(`
[retrieval.turn_indexing]
enabled = false
interval = 30
batch_size = 400
`);
    const c = await loadConfig();
    expect(c.retrieval!.turnIndexing).toEqual({
      enabled: false,
      interval: 30,
      batchSize: 400,
    });
  });

  test("turn-index env vars override TOML", async () => {
    await writeToml(`
[retrieval.turn_indexing]
enabled = false
interval = 30
batch_size = 400
`);
    process.env.PHANTOMBOT_RETRIEVAL_TURN_INDEXING_ENABLED = "true";
    process.env.PHANTOMBOT_RETRIEVAL_TURN_INDEXING_INTERVAL = "20";
    process.env.PHANTOMBOT_RETRIEVAL_TURN_INDEXING_BATCH_SIZE = "50";
    const c = await loadConfig();
    expect(c.retrieval!.turnIndexing).toEqual({
      enabled: true,
      interval: 20,
      batchSize: 50,
    });
  });

  test("limit is clamped to 1..50", async () => {
    process.env.PHANTOMBOT_RETRIEVAL_LIMIT = "999";
    expect((await loadConfig()).retrieval!.limit).toBe(50);
    process.env.PHANTOMBOT_RETRIEVAL_LIMIT = "0";
    expect((await loadConfig()).retrieval!.limit).toBe(1);
  });

  test("maxTokens floors at 0 (negative disables injection)", async () => {
    process.env.PHANTOMBOT_RETRIEVAL_MAX_TOKENS = "-100";
    expect((await loadConfig()).retrieval!.maxTokens).toBe(0);
  });

  test("accepts 1/0/yes/no style booleans for enabled", async () => {
    process.env.PHANTOMBOT_RETRIEVAL_ENABLED = "0";
    expect((await loadConfig()).retrieval!.enabled).toBe(false);
    process.env.PHANTOMBOT_RETRIEVAL_ENABLED = "yes";
    expect((await loadConfig()).retrieval!.enabled).toBe(true);
  });

  test("memoryIndexPath resolves under XDG_DATA_HOME", () => {
    // beforeEach sets XDG_DATA_HOME to <workdir>/data.
    expect(memoryIndexPath("phantom")).toBe(
      join(workdir, "data", "phantombot", "memory-index", "phantom.sqlite"),
    );
  });
});
