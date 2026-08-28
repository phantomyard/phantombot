/**
 * "Changing a setting is an ACTION, not a write" (issue #471).
 *
 * The space-change predicate is the load-bearing one: get it wrong in the
 * permissive direction and the TUI burns a full index rebuild for nothing; get
 * it wrong in the strict direction and the user's recall silently degrades to
 * lexical with nothing on screen looking broken.
 */

import { describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import {
  describeEmbeddingChange,
  describeVoiceChange,
  embeddingSpaceChanges,
} from "../src/tui/actions.ts";

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
  test("azure_edge states the STT consequence at the point of choice", () => {
    // One key drives two capabilities; picking azure_edge yields a phantom
    // that silently rejects every voice note.
    const c = describeVoiceChange({ provider: "azure_edge" });
    expect(c.summary).toContain("cannot hear");
    expect(c.detail).toContain("whisper-1");
  });

  test("a provider that can transcribe does not carry the warning", () => {
    expect(describeVoiceChange({ provider: "openai" }).summary).not.toContain(
      "cannot hear",
    );
  });

  test("a voice change restarts the service", () => {
    expect(describeVoiceChange({ provider: "openai" }).restarts).toBe(true);
  });
});
