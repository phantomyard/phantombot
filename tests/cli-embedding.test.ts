/**
 * Tests for the side-effect helpers behind `phantombot embedding`.
 * The TUI prompts are verified manually.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEmbeddingConfig } from "../src/cli/embedding.ts";
import { loadConfig } from "../src/config.ts";

let workdir: string;
let configPath: string;
const SAVED_CONFIG = process.env.PHANTOMBOT_CONFIG;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-emb-"));
  configPath = join(workdir, "config.toml");
  process.env.PHANTOMBOT_CONFIG = configPath;
  process.env.XDG_CONFIG_HOME = join(workdir, "xdg-config");
  process.env.XDG_DATA_HOME = join(workdir, "xdg-data");
});

afterEach(async () => {
  if (SAVED_CONFIG === undefined) delete process.env.PHANTOMBOT_CONFIG;
  else process.env.PHANTOMBOT_CONFIG = SAVED_CONFIG;
  await rm(workdir, { recursive: true, force: true });
});

describe("applyEmbeddingConfig — gemini", () => {
  test("writes [embeddings] + [embeddings.gemini]", async () => {
    await applyEmbeddingConfig(configPath, {
      provider: "gemini",
      apiKey: "AIzaTEST123",
      model: "gemini-embedding-001",
      dims: 1536,
    });
    const text = await readFile(configPath, "utf8");
    expect(text).toContain("[embeddings]");
    expect(text).toContain('provider = "gemini"');
    expect(text).toContain("[embeddings.gemini]");
    expect(text).toContain('api_key = "AIzaTEST123"');
    expect(text).toContain('model = "gemini-embedding-001"');
    expect(text).toContain("dims = 1536");
  });

  test("loadConfig() picks up the gemini config we just wrote", async () => {
    await applyEmbeddingConfig(configPath, {
      provider: "gemini",
      apiKey: "AIzaTEST123",
    });
    const c = await loadConfig();
    expect(c.embeddings.provider).toBe("gemini");
    expect(c.embeddings.gemini?.apiKey).toBe("AIzaTEST123");
    expect(c.embeddings.gemini?.model).toBe("gemini-embedding-001");
    expect(c.embeddings.gemini?.dims).toBe(1536);
  });
});

describe("applyEmbeddingConfig — none", () => {
  test("flips provider to none, leaves [embeddings.gemini] alone", async () => {
    await applyEmbeddingConfig(configPath, {
      provider: "gemini",
      apiKey: "AIzaTEST123",
    });
    await applyEmbeddingConfig(configPath, { provider: "none" });
    const text = await readFile(configPath, "utf8");
    expect(text).toContain('provider = "none"');
    // Old gemini block preserved so re-enabling doesn't require re-validating
    expect(text).toContain('api_key = "AIzaTEST123"');

    const c = await loadConfig();
    expect(c.embeddings.provider).toBe("none");
    // gemini sub-config not exposed when provider is none.
    expect(c.embeddings.gemini).toBeUndefined();
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
