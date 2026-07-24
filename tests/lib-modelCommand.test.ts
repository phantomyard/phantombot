/**
 * Unit tests for lib/modelCommand.ts (issue #313) — /model parsing,
 * show formatting, and the two-store (config.toml + env file) write path.
 *
 * Write tests run against real temp files (config.toml + .env in a tmpdir)
 * because the contract under test IS the file content; mocking the writer
 * would test nothing. process.env keys touched by the in-memory sync are
 * saved and restored around each test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import {
  applyModelRequest,
  CLAUDE_MODEL_ALIASES,
  formatModelShow,
  parseModelRequest,
} from "../src/lib/modelCommand.ts";
import { getIn, readConfigToml } from "../src/lib/configWriter.ts";
import { loadEnvFile } from "../src/lib/envFile.ts";

const TOUCHED_ENV = [
  "PHANTOMBOT_PRIMARY_MODEL",
  "PHANTOMBOT_CODING_MODEL",
  "PHANTOMBOT_IMAGE_MODEL",
  "PHANTOMBOT_CLAUDE_MODEL",
  "PHANTOMBOT_CODEX_MODEL",
] as const;

let dir: string;
let configPath: string;
let envPath: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "phantombot-modelcmd-"));
  configPath = join(dir, "config.toml");
  envPath = join(dir, ".env");
  savedEnv = {};
  for (const k of TOUCHED_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(async () => {
  for (const k of TOUCHED_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await rm(dir, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<Config["harnesses"]> = {}): Config {
  return {
    defaultPersona: "phantom",
    harnessIdleTimeoutMs: 1000,
    harnessHardTimeoutMs: 1000,
    personasDir: dir,
    memoryDbPath: ":memory:",
    configPath,
    harnesses: {
      chain: ["pi"],
      claude: { bin: "claude", model: "opus", fallbackModel: "sonnet" },
      pi: { bin: "pi" },
      ...overrides,
    },
    channels: {},
    embeddings: { provider: "none" },
    voice: { provider: "none" },
  } as Config;
}

// ---------------------------------------------------------------------------
// parseModelRequest
// ---------------------------------------------------------------------------

describe("parseModelRequest", () => {
  test("bare → show", () => {
    expect(parseModelRequest("")).toEqual({ kind: "show" });
  });

  test("list with and without filter", () => {
    expect(parseModelRequest("list")).toEqual({ kind: "list", filter: undefined });
    expect(parseModelRequest("list deepseek")).toEqual({
      kind: "list",
      filter: "deepseek",
    });
    expect(parseModelRequest("LIST Claude Opus")).toEqual({
      kind: "list",
      filter: "Claude Opus",
    });
  });

  test("clear", () => {
    expect(parseModelRequest("clear")).toEqual({ kind: "clear" });
    expect(parseModelRequest("CLEAR")).toEqual({ kind: "clear" });
    expect(parseModelRequest("clear now")).toEqual({ kind: "usage" });
  });

  test("explicit roles", () => {
    expect(parseModelRequest("primary openrouter/x")).toEqual({
      kind: "set",
      role: "primary",
      slug: "openrouter/x",
    });
    expect(parseModelRequest("coding deepseek-v3")).toEqual({
      kind: "set",
      role: "coding",
      slug: "deepseek-v3",
    });
    expect(parseModelRequest("IMAGE qwen-vl")).toEqual({
      kind: "set",
      role: "image",
      slug: "qwen-vl",
    });
  });

  test("bare slug → set primary, case preserved", () => {
    expect(parseModelRequest("Opus-4.1")).toEqual({
      kind: "set",
      role: "primary",
      slug: "Opus-4.1",
    });
  });

  test("role without slug, or extra tokens → usage", () => {
    expect(parseModelRequest("coding")).toEqual({ kind: "usage" });
    expect(parseModelRequest("coding a b")).toEqual({ kind: "usage" });
    expect(parseModelRequest("two tokens")).toEqual({ kind: "usage" });
  });
});

// ---------------------------------------------------------------------------
// formatModelShow
// ---------------------------------------------------------------------------

describe("formatModelShow", () => {
  test("pi with full routing", () => {
    const out = formatModelShow("pi", {
      model: "deepseek-v3",
      provider: "openrouter",
      codingModel: "qwen-coder",
      imageModel: "qwen-vl",
    });
    expect(out).toContain("pi primary: deepseek-v3");
    expect(out).toContain("provider:   openrouter");
    expect(out).toContain("coding:     qwen-coder");
    expect(out).toContain("image:      qwen-vl");
  });

  test("pi without delegates says so", () => {
    const out = formatModelShow("pi", { model: "(pi default)" });
    expect(out).toContain("(same as primary)");
    expect(out).toContain("(none)");
  });

  test("claude includes fallback when set", () => {
    const out = formatModelShow("claude", {
      model: "opus",
      fallbackModel: "sonnet",
    });
    expect(out).toContain("claude model: opus");
    expect(out).toContain("fallback:     sonnet");
  });

  test("missing info degrades", () => {
    expect(formatModelShow("pi", undefined)).toContain("unavailable");
  });
});

// ---------------------------------------------------------------------------
// applyModelRequest — pi
// ---------------------------------------------------------------------------

describe("applyModelRequest pi", () => {
  test("set primary writes toml + env + in-memory", async () => {
    const config = makeConfig();
    const r = await applyModelRequest(
      { kind: "set", role: "primary", slug: "deepseek-v3" },
      "pi",
      config,
      envPath,
    );
    expect(r).toEqual({ ok: true, summary: "pi primary model → deepseek-v3" });

    const toml = await readConfigToml(configPath);
    expect(getIn(toml, ["harnesses", "pi", "routing", "primary_model"])).toBe(
      "deepseek-v3",
    );
    const env = await loadEnvFile(envPath);
    expect(env.PHANTOMBOT_PRIMARY_MODEL).toBe("deepseek-v3");
    expect(config.harnesses.pi.routing?.primaryModel).toBe("deepseek-v3");
    expect(process.env.PHANTOMBOT_PRIMARY_MODEL).toBe("deepseek-v3");
  });

  test("set coding + image roles hit their own keys", async () => {
    const config = makeConfig();
    await applyModelRequest(
      { kind: "set", role: "coding", slug: "qwen-coder" },
      "pi",
      config,
      envPath,
    );
    await applyModelRequest(
      { kind: "set", role: "image", slug: "qwen-vl" },
      "pi",
      config,
      envPath,
    );
    const toml = await readConfigToml(configPath);
    expect(getIn(toml, ["harnesses", "pi", "routing", "coding_model"])).toBe(
      "qwen-coder",
    );
    expect(getIn(toml, ["harnesses", "pi", "routing", "image_model"])).toBe(
      "qwen-vl",
    );
    const env = await loadEnvFile(envPath);
    expect(env.PHANTOMBOT_CODING_MODEL).toBe("qwen-coder");
    expect(env.PHANTOMBOT_IMAGE_MODEL).toBe("qwen-vl");
  });

  test("clear is refused — pi has no default to fall back to", async () => {
    const r = await applyModelRequest(
      { kind: "clear" },
      "pi",
      makeConfig(),
      envPath,
    );
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyModelRequest — claude
// ---------------------------------------------------------------------------

describe("applyModelRequest claude", () => {
  test("accepts allowlisted aliases, writes both stores", async () => {
    const config = makeConfig();
    const r = await applyModelRequest(
      { kind: "set", role: "primary", slug: "Sonnet" },
      "claude",
      config,
      envPath,
    );
    expect(r.ok).toBe(true);
    const toml = await readConfigToml(configPath);
    expect(getIn(toml, ["harnesses", "claude", "model"])).toBe("sonnet");
    const env = await loadEnvFile(envPath);
    expect(env.PHANTOMBOT_CLAUDE_MODEL).toBe("sonnet");
    expect(config.harnesses.claude.model).toBe("sonnet");
  });

  test("rejects aliases outside the allowlist", async () => {
    const r = await applyModelRequest(
      { kind: "set", role: "primary", slug: "opys" },
      "claude",
      makeConfig(),
      envPath,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(CLAUDE_MODEL_ALIASES[0]);
  });

  test("rejects clear and non-primary roles", async () => {
    const config = makeConfig();
    expect(
      (await applyModelRequest({ kind: "clear" }, "claude", config, envPath)).ok,
    ).toBe(false);
    expect(
      (
        await applyModelRequest(
          { kind: "set", role: "coding", slug: "opus" },
          "claude",
          config,
          envPath,
        )
      ).ok,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyModelRequest — codex
// ---------------------------------------------------------------------------

describe("applyModelRequest codex", () => {
  test("codex set/clear works", async () => {
    const config = makeConfig({ codex: { bin: "codex", model: "" } });
    const set = await applyModelRequest(
      { kind: "set", role: "primary", slug: "gpt-5.2-codex" },
      "codex",
      config,
      envPath,
    );
    expect(set.ok).toBe(true);
    expect(config.harnesses.codex?.model).toBe("gpt-5.2-codex");
    const clear = await applyModelRequest({ kind: "clear" }, "codex", config, envPath);
    expect(clear.ok).toBe(true);
    expect(config.harnesses.codex?.model).toBe("");
  });

  test("codex tolerates an absent codex config block", async () => {
    const config = makeConfig(); // no codex key
    const r = await applyModelRequest(
      { kind: "set", role: "primary", slug: "gpt-5.2-codex" },
      "codex",
      config,
      envPath,
    );
    expect(r.ok).toBe(true);
    const toml = await readConfigToml(configPath);
    expect(getIn(toml, ["harnesses", "codex", "model"])).toBe("gpt-5.2-codex");
  });

  test("rejects coding/image roles — single-model harness", async () => {
    const r = await applyModelRequest(
      { kind: "set", role: "image", slug: "x" },
      "codex",
      makeConfig(),
      envPath,
    );
    expect(r.ok).toBe(false);
  });
});

test("unknown harness id is refused", async () => {
  const r = await applyModelRequest(
    { kind: "set", role: "primary", slug: "x" },
    "mystery",
    makeConfig(),
    envPath,
  );
  expect(r.ok).toBe(false);
});
