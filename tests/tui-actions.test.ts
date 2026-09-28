/**
 * "Changing a setting is an ACTION, not a write" (issue #471).
 *
 * The space-change predicate is the load-bearing one: get it wrong in the
 * permissive direction and the TUI burns a full index rebuild for nothing; get
 * it wrong in the strict direction and the user's recall silently degrades to
 * lexical with nothing on screen looking broken.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../src/config.ts";
import type { ServiceControl } from "../src/lib/platform.ts";
import {
  applyVoice,
  describeEmbeddingChange,
  describeVoiceChange,
  embeddingSpaceChanges,
} from "../src/tui/actions.ts";

const noopService: ServiceControl = {
  isActive: async () => true,
  start: async () => ({ ok: true }),
  stop: async () => ({ ok: true }),
  restart: async () => ({ ok: true }),
} as unknown as ServiceControl;

function configWith(embeddings: unknown): Config {
  return { embeddings } as unknown as Config;
}

const geminiNow = configWith({
  provider: "gemini",
  gemini: { model: "gemini-embedding-001", dims: 1536 },
});

const openaiNow = configWith({
  provider: "openai-compatible",
  openaiCompatible: {
    baseUrl: "https://api.openai.com/v1",
    model: "text-embedding-3-small",
    dims: 1536,
    documentPrefix: "",
  },
});

describe("embeddingSpaceChanges", () => {
  test("same provider, model and dimensions is NOT a space change", () => {
    expect(
      embeddingSpaceChanges(geminiNow, {
        provider: "gemini",
        model: "gemini-embedding-001",
        dims: 1536,
      }),
    ).toBe(false);
  });

  test("a different model changes the space", () => {
    expect(
      embeddingSpaceChanges(geminiNow, {
        provider: "gemini",
        model: "gemini-embedding-002",
        dims: 1536,
      }),
    ).toBe(true);
  });

  test("different dimensions change the space", () => {
    expect(
      embeddingSpaceChanges(geminiNow, {
        provider: "gemini",
        model: "gemini-embedding-001",
        dims: 768,
      }),
    ).toBe(true);
  });

  test("a different provider changes the space", () => {
    expect(
      embeddingSpaceChanges(geminiNow, {
        provider: "openai-compatible",
        openaiCompatible: {
          baseUrl: "https://api.openai.com/v1",
          model: "text-embedding-3-small",
          dims: 1536,
        },
      }),
    ).toBe(true);
  });

  test("the DOCUMENT prefix is part of the space", () => {
    expect(
      embeddingSpaceChanges(openaiNow, {
        provider: "openai-compatible",
        openaiCompatible: {
          baseUrl: "https://api.openai.com/v1",
          model: "text-embedding-3-small",
          dims: 1536,
          documentPrefix: "passage: ",
        },
      }),
    ).toBe(true);
  });

  test("the QUERY prefix is NOT — it must not trigger a re-embed", () => {
    // The one asymmetry the UI has to respect. Re-embedding here would burn a
    // full index rebuild for no reason at all.
    expect(
      embeddingSpaceChanges(openaiNow, {
        provider: "openai-compatible",
        openaiCompatible: {
          baseUrl: "https://api.openai.com/v1",
          model: "text-embedding-3-small",
          dims: 1536,
          documentPrefix: "",
          queryPrefix: "query: ",
        },
      }),
    ).toBe(false);
  });

  test("turning embeddings off from on is a space change; off to off is not", () => {
    expect(embeddingSpaceChanges(geminiNow, { provider: "none" })).toBe(true);
    expect(
      embeddingSpaceChanges(configWith({ provider: "none" }), {
        provider: "none",
      }),
    ).toBe(false);
  });

  test("turning embeddings ON from off is a space change", () => {
    expect(
      embeddingSpaceChanges(configWith({ provider: "none" }), {
        provider: "gemini",
        model: "gemini-embedding-001",
        dims: 1536,
      }),
    ).toBe(true);
  });
});

describe("describeEmbeddingChange", () => {
  test("a space change is long-running and names the chunk count", () => {
    const c = describeEmbeddingChange(geminiNow, {
      next: { provider: "gemini", model: "other", dims: 1536 },
      indexedChunks: 12904,
    });
    expect(c.longRunning).toBe(true);
    expect(c.summary).toContain("12,904");
  });

  test("a non-space change says plainly that no re-embed is needed", () => {
    const c = describeEmbeddingChange(geminiNow, {
      next: { provider: "gemini", model: "gemini-embedding-001", dims: 1536 },
    });
    expect(c.longRunning).toBe(false);
    expect(c.summary).toContain("no re-embed");
  });

  test("turning embeddings off states that vectors are KEPT", () => {
    const c = describeEmbeddingChange(geminiNow, {
      next: { provider: "none" },
    });
    expect(c.detail).toContain("Nothing is erased");
    expect(c.longRunning).toBe(false);
  });
});

describe("describeVoiceChange", () => {
  test("a provider that can transcribe does not carry the warning", () => {
    expect(describeVoiceChange({ provider: "openai-compatible" }).summary).not.toContain(
      "cannot hear",
    );
  });

  test("a voice change restarts the service", () => {
    expect(describeVoiceChange({ provider: "openai-compatible" }).restarts).toBe(true);
  });
});

describe("applyVoice", () => {
  test("writes the selected persona layer and leaves the host config untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "phantombot-tui-voice-"));
    try {
      const hostPath = join(root, "config.toml");
      const personasDir = join(root, "personas");
      const kaiPath = join(personasDir, "kai", "config.toml");
      await mkdir(join(personasDir, "kai"), { recursive: true });
      await writeFile(hostPath, 'default_persona = "lena"\n');

      const config = {
        configPath: hostPath,
        personasDir,
        defaultPersona: "lena",
      } as unknown as Config;
      const result = await applyVoice({
        config,
        persona: "kai",
        voice: {
          provider: "openai-compatible",
          openaiCompatible: {
            baseUrl: "https://openrouter.ai/api/v1",
            keyEnv: "PHANTOMBOT_OPENAI_COMPATIBLE_API_KEY",
            sttModel: "x-ai/grok-stt-1.0",
            ttsModel: "x-ai/grok-voice-tts-1.0",
            voice: "leo",
            speed: 1,
          },
        },
        serviceControl: noopService,
      });

      expect(result).toEqual({ ok: true });
      expect(await readFile(hostPath, "utf8")).toBe('default_persona = "lena"\n');
      const personaToml = await readFile(kaiPath, "utf8");
      expect(personaToml).toContain('provider = "openai-compatible"');
      expect(personaToml).toContain('tts_model = "x-ai/grok-voice-tts-1.0"');
      expect(personaToml).toContain('voice = "leo"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
