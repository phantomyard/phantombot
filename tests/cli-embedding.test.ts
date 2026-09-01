/**
 * Tests for the side-effect helpers behind `phantombot embedding`.
 * The TUI prompts are verified manually.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyEmbeddingConfig,
  optionalPromptText,
} from "../src/cli/embedding.ts";
import { type Config, loadConfig } from "../src/config.ts";

let workdir: string;
let configPath: string;
let config: Config;
const persona = "phantom";
const SAVED_CONFIG = process.env.PHANTOMBOT_CONFIG;
// Isolate from the ambient environment: loadConfig() prefers a real
// PHANTOMBOT_GEMINI_API_KEY over the toml api_key, so a key present in the
// shell (e.g. on a live phantombot box) would otherwise leak into these
// config-roundtrip tests and fail them. Clear it per-test, restore after.
let savedGeminiKey: string | undefined;
let savedOpenAIKey: string | undefined;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-emb-"));
  configPath = join(workdir, "config.toml");
  process.env.PHANTOMBOT_CONFIG = configPath;
  process.env.XDG_CONFIG_HOME = join(workdir, "xdg-config");
  process.env.XDG_DATA_HOME = join(workdir, "xdg-data");
  savedGeminiKey = process.env.PHANTOMBOT_GEMINI_API_KEY;
  savedOpenAIKey = process.env.PHANTOMBOT_OPENAI_COMPATIBLE_API_KEY;
  delete process.env.PHANTOMBOT_GEMINI_API_KEY;
  delete process.env.PHANTOMBOT_OPENAI_COMPATIBLE_API_KEY;
  config = await loadConfig();
  configPath = join(config.personasDir, persona, "config.toml");
});

afterEach(async () => {
  if (SAVED_CONFIG === undefined) delete process.env.PHANTOMBOT_CONFIG;
  else process.env.PHANTOMBOT_CONFIG = SAVED_CONFIG;
  if (savedGeminiKey === undefined) delete process.env.PHANTOMBOT_GEMINI_API_KEY;
  else process.env.PHANTOMBOT_GEMINI_API_KEY = savedGeminiKey;
  if (savedOpenAIKey === undefined) {
    delete process.env.PHANTOMBOT_OPENAI_COMPATIBLE_API_KEY;
  } else {
    process.env.PHANTOMBOT_OPENAI_COMPATIBLE_API_KEY = savedOpenAIKey;
  }
  await rm(workdir, { recursive: true, force: true });
});

describe("applyEmbeddingConfig — gemini", () => {
  test("stores the key in the persona vault and writes only non-secret settings", async () => {
    const writes: unknown[][] = [];
    await applyEmbeddingConfig({
      config,
      persona,
      update: {
        provider: "gemini",
        apiKey: "AIzaTEST123",
        model: "gemini-embedding-001",
        dims: 1536,
      },
      writeSecret: async (...args) => {
        writes.push(args);
        return { ok: true, persona };
      },
    });
    const text = await readFile(configPath, "utf8");
    expect(writes[0]?.slice(1)).toEqual([
      "PHANTOMBOT_GEMINI_API_KEY",
      "AIzaTEST123",
      persona,
    ]);
    expect(text).toContain("[embeddings]");
    expect(text).toContain('provider = "gemini"');
    expect(text).toContain("[embeddings.gemini]");
    expect(text).not.toContain("api_key");
    expect(text).toContain('model = "gemini-embedding-001"');
    expect(text).toContain("dims = 1536");
  });

  test("clears a legacy plaintext key after the vault write succeeds", async () => {
    await mkdir(join(config.personasDir, persona), { recursive: true });
    await writeFile(
      configPath,
      '[embeddings]\nprovider = "gemini"\n\n[embeddings.gemini]\napi_key = "OLD"\n',
    );
    await applyEmbeddingConfig({
      config,
      persona,
      update: { provider: "gemini", apiKey: "NEW" },
      writeSecret: async () => ({ ok: true, persona }),
    });
    expect(await readFile(configPath, "utf8")).not.toContain("api_key");
  });

  test("keeps the pasted key in config.toml and reports a failed vault write", async () => {
    await expect(
      applyEmbeddingConfig({
        config,
        persona,
        update: { provider: "gemini", apiKey: "RECOVERABLE" },
        writeSecret: async () => ({ ok: false, persona, error: "disk full" }),
      }),
    ).rejects.toThrow("kept the key in config.toml: disk full");
    expect(await readFile(configPath, "utf8")).toContain(
      'api_key = "RECOVERABLE"',
    );
  });
});

describe("applyEmbeddingConfig — none", () => {
  test("flips provider to none, leaves [embeddings.gemini] alone", async () => {
    await applyEmbeddingConfig({
      config,
      persona,
      update: { provider: "gemini", apiKey: "AIzaTEST123" },
      writeSecret: async () => ({ ok: true, persona }),
    });
    await applyEmbeddingConfig({ config, persona, update: { provider: "none" } });
    const text = await readFile(configPath, "utf8");
    expect(text).toContain('provider = "none"');
    expect(text).not.toContain("api_key");

    const c = await loadConfig(persona);
    expect(c.embeddings.provider).toBe("none");
    // gemini sub-config not exposed when provider is none.
    expect(c.embeddings.gemini).toBeUndefined();
  });
});

describe("applyEmbeddingConfig — openai-compatible", () => {
  test("writes endpoint settings and detected dimensions", async () => {
    await applyEmbeddingConfig({
      config,
      persona,
      update: {
        provider: "openai-compatible",
        openaiCompatible: {
          baseUrl: "http://127.0.0.1:8082/v1",
          model: "example-embedding-model",
          apiKey: "",
          dims: 1024,
          queryPrefix: "query: ",
          documentPrefix: "passage: ",
        },
      },
      clearSecret: async () => ({ ok: true, persona }),
    });
    const text = await readFile(configPath, "utf8");
    expect(text).toContain('provider = "openai-compatible"');
    expect(text).toContain("[embeddings.openai_compatible]");
    expect(text).toContain("dims = 1024");
    const c = await loadConfig(persona);
    const { apiKey: _ambientKey, ...settings } = c.embeddings.openaiCompatible!;
    expect(settings).toEqual({
      baseUrl: "http://127.0.0.1:8082/v1",
      model: "example-embedding-model",
      dims: 1024,
      queryPrefix: "query: ",
      documentPrefix: "passage: ",
      maxChunkChars: 5000,
    });
    expect(text).not.toContain("api_key");
  });

  test("empty optional prompt values remain empty", () => {
    expect(optionalPromptText(undefined)).toBe("");
    expect(optionalPromptText("")).toBe("");
    expect(optionalPromptText("local-key")).toBe("local-key");
  });
});

describe("config inference", () => {
  test("if api_key is set via env but no provider in toml, infers gemini", async () => {
    const SAVED_KEY = process.env.PHANTOMBOT_GEMINI_API_KEY;
    process.env.PHANTOMBOT_GEMINI_API_KEY = "AIzaENV_KEY";
    try {
      const c = await loadConfig();
      expect(c.embeddings.provider).toBe("gemini");
      expect(c.embeddings.gemini?.apiKey).toBe("AIzaENV_KEY");
    } finally {
      if (SAVED_KEY === undefined) {
        delete process.env.PHANTOMBOT_GEMINI_API_KEY;
      } else {
        process.env.PHANTOMBOT_GEMINI_API_KEY = SAVED_KEY;
      }
    }
  });

  test("with no api_key anywhere, defaults to provider=none", async () => {
    const SAVED_KEY = process.env.PHANTOMBOT_GEMINI_API_KEY;
    delete process.env.PHANTOMBOT_GEMINI_API_KEY;
    try {
      const c = await loadConfig();
      expect(c.embeddings.provider).toBe("none");
    } finally {
      if (SAVED_KEY !== undefined) {
        process.env.PHANTOMBOT_GEMINI_API_KEY = SAVED_KEY;
      }
    }
  });
});
