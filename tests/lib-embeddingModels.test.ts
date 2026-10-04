/**
 * Embedding-model discovery for the memory wizard's picker: the modality tag
 * where the endpoint has one, the name filter where it does not, and `[]`
 * (the typed prompt) when the endpoint cannot be asked at all.
 */

import { describe, expect, test } from "bun:test";

import {
  embeddingModelPickerOptions,
  fetchEmbeddingModels,
  looksLikeEmbeddingModel,
  OTHER_EMBEDDING_MODEL,
  sameEmbeddingEndpoint,
} from "../src/lib/embeddingModels.ts";

interface Call {
  url: string;
  authorization: string | undefined;
}

function fakeFetch(
  respond: (url: URL) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({
      url: url.toString(),
      authorization: (init?.headers as Record<string, string> | undefined)
        ?.authorization,
    });
    return respond(url);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const tagged = (id: string) => ({
  id,
  architecture: { output_modalities: ["embeddings"] },
});

describe("fetchEmbeddingModels — modality tag", () => {
  test("asks the embeddings catalogue and returns the tagged ids, sorted", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json({
        data: [
          tagged("openai/text-embedding-3-small"),
          tagged("baai/bge-m3"),
          tagged("voyageai/voyage-4"),
        ],
      }),
    );
    const models = await fetchEmbeddingModels(
      "or-key",
      "https://openrouter.ai/api/v1/",
      fetchImpl,
    );
    expect(models).toEqual([
      "baai/bge-m3",
      "openai/text-embedding-3-small",
      "voyageai/voyage-4",
    ]);
    expect(calls).toEqual([
      {
        url: "https://openrouter.ai/api/v1/models?output_modalities=embeddings",
        authorization: "Bearer or-key",
      },
    ]);
  });

  test("a tagged row wins over the name filter — an untagged 'embed' id is not offered beside tagged ones", async () => {
    const { fetchImpl } = fakeFetch(() =>
      json({
        data: [
          tagged("voyageai/voyage-4"),
          { id: "acme/chat-with-embed-in-its-name" },
        ],
      }),
    );
    expect(
      await fetchEmbeddingModels("k", "https://example.test/v1", fetchImpl),
    ).toEqual(["voyageai/voyage-4"]);
  });
});

describe("fetchEmbeddingModels — name filter", () => {
  test("an endpoint that ignores the filter has its whole catalogue filtered by name, in one request", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json({
        data: [
          { id: "gpt-4o" },
          { id: "text-embedding-3-small" },
          { id: "text-embedding-3-large" },
          { id: "whisper-1" },
        ],
      }),
    );
    expect(
      await fetchEmbeddingModels("sk", "https://api.openai.com/v1", fetchImpl),
    ).toEqual(["text-embedding-3-large", "text-embedding-3-small"]);
    expect(calls.length).toBe(1);
  });

  test("a keyless local endpoint is asked without an authorization header", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json({
        data: [
          { id: "llama3.2:latest" },
          { id: "nomic-embed-text:latest" },
          { id: "bge-m3:latest" },
          { id: "all-minilm:latest" },
        ],
      }),
    );
    expect(
      await fetchEmbeddingModels("", "http://localhost:11434/v1", fetchImpl),
    ).toEqual(["all-minilm:latest", "bge-m3:latest", "nomic-embed-text:latest"]);
    expect(calls[0]!.authorization).toBeUndefined();
  });

  test("an endpoint that refuses the filtered request is asked again for the plain catalogue", async () => {
    const { fetchImpl, calls } = fakeFetch((url) =>
      url.searchParams.has("output_modalities")
        ? json({ error: { message: "unknown parameter" } }, 400)
        : json({ data: [{ id: "mxbai-embed-large" }, { id: "phi4" }] }),
    );
    expect(
      await fetchEmbeddingModels("k", "https://strict.test/v1", fetchImpl),
    ).toEqual(["mxbai-embed-large"]);
    expect(calls.map((c) => c.url)).toEqual([
      "https://strict.test/v1/models?output_modalities=embeddings",
      "https://strict.test/v1/models",
    ]);
  });

  test("the name heuristic matches embedding families as whole tokens only", () => {
    for (const id of [
      "text-embedding-3-small",
      "nomic-embed-text",
      "embeddinggemma:300m",
      "bge-m3",
      "baai/bge-large-en-v1.5",
      "intfloat/multilingual-e5-large",
      "thenlper/gte-base",
      "all-minilm:l6-v2",
    ]) {
      expect(looksLikeEmbeddingModel(id)).toBe(true);
    }
    for (const id of ["gpt-4o", "llama3.2", "whisper-1", "badger-1", "pe5t", "bigbge2"]) {
      expect(looksLikeEmbeddingModel(id)).toBe(false);
    }
  });
});

describe("fetchEmbeddingModels — nothing to offer", () => {
  test("a catalogue with no recognisable embedding model yields []", async () => {
    const { fetchImpl } = fakeFetch(() =>
      json({ data: [{ id: "gpt-4o" }, { id: "llama3.2" }] }),
    );
    expect(await fetchEmbeddingModels("k", "https://x.test/v1", fetchImpl)).toEqual([]);
  });

  test("HTTP errors, non-JSON bodies and network failures all degrade to []", async () => {
    const dead = fakeFetch(() => json({}, 500));
    expect(await fetchEmbeddingModels("k", "https://x.test/v1", dead.fetchImpl)).toEqual([]);

    const html = fakeFetch(() => new Response("<html>", { status: 200 }));
    expect(await fetchEmbeddingModels("k", "https://x.test/v1", html.fetchImpl)).toEqual([]);

    const down = fakeFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    expect(await fetchEmbeddingModels("k", "http://127.0.0.1:1/v1", down.fetchImpl)).toEqual([]);
  });

  test("an empty or malformed base URL never reaches the network", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({ data: [] }));
    expect(await fetchEmbeddingModels("k", "  ", fetchImpl)).toEqual([]);
    expect(await fetchEmbeddingModels("k", "not a url", fetchImpl)).toEqual([]);
    expect(calls.length).toBe(0);
  });

  test("the picker sentinel and junk rows are never offered as models", async () => {
    const { fetchImpl } = fakeFetch(() =>
      json({
        data: [
          tagged(OTHER_EMBEDDING_MODEL),
          tagged("  "),
          { id: 7, architecture: { output_modalities: ["embeddings"] } },
          null,
          tagged("a/embed"),
          tagged("a/embed"),
        ],
      }),
    );
    expect(await fetchEmbeddingModels("k", "https://x.test/v1", fetchImpl)).toEqual(["a/embed"]);
  });
});

describe("embeddingModelPickerOptions", () => {
  test("no live models means no picker (the typed prompt)", () => {
    expect(embeddingModelPickerOptions([], "anything")).toBeUndefined();
  });

  test("the current model is preselected and marked; Other is always last", () => {
    const picker = embeddingModelPickerOptions(["a", "b"], "b")!;
    expect(picker.initial).toBe("b");
    expect(picker.options.map((o) => o.value)).toEqual(["a", "b", OTHER_EMBEDDING_MODEL]);
    expect(picker.options[1]!.hint).toBe("current");
  });

  test("a current model discovery missed is still offered first and preselected", () => {
    const picker = embeddingModelPickerOptions(["a", "b"], "oddly-named-v2")!;
    expect(picker.initial).toBe("oddly-named-v2");
    expect(picker.options.map((o) => o.value)).toEqual([
      "oddly-named-v2",
      "a",
      "b",
      OTHER_EMBEDDING_MODEL,
    ]);
  });

  test("with no current model the first live model is preselected", () => {
    expect(embeddingModelPickerOptions(["a", "b"])!.initial).toBe("a");
  });
});

describe("sameEmbeddingEndpoint", () => {
  test("ignores trailing slashes, whitespace and case; undefined never matches", () => {
    expect(sameEmbeddingEndpoint("https://OpenRouter.ai/api/v1/", " https://openrouter.ai/api/v1")).toBe(true);
    expect(sameEmbeddingEndpoint("https://api.openai.com/v1", "https://openrouter.ai/api/v1")).toBe(false);
    expect(sameEmbeddingEndpoint(undefined, "https://openrouter.ai/api/v1")).toBe(false);
  });
});
