/**
 * The memory wizard's OpenAI-compatible walkthrough: the model is PICKED from
 * the endpoint's embedding catalogue (asked after the key, which the list
 * needs), with the typed prompt as the fallback.
 */

import { describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import { OTHER_EMBEDDING_MODEL } from "../src/lib/embeddingModels.ts";
import {
  configureMemory,
  embeddingUpdateEquals,
  type MemoryFlowDeps,
  type MemoryQuestions,
} from "../src/tui/memoryFlow.ts";

type Options = readonly { value: string; label: string; hint?: string }[];

interface Script {
  /** Answers to `choose`/`search`, keyed by title; default = the `initial`. */
  picks?: Record<string, string | undefined>;
  /** Answers to `value`, keyed by title; default = the `initial`. */
  values?: Record<string, string | undefined>;
  search?: boolean;
}

function questions(script: Script = {}) {
  const asked: string[] = [];
  const lists: Record<string, { options: Options; initial?: string; via: string }> = {};
  const pick = (via: string) =>
    async (input: { title: string; options: Options; initial?: string }) => {
      asked.push(input.title);
      lists[input.title] = { options: input.options, initial: input.initial, via };
      return script.picks && input.title in script.picks
        ? script.picks[input.title]
        : (input.initial ?? input.options[0]?.value);
    };
  const q: MemoryQuestions = {
    choose: pick("choose"),
    ...(script.search === false ? {} : { search: pick("search") }),
    value: async (input) => {
      asked.push(input.title);
      return script.values && input.title in script.values
        ? script.values[input.title]
        : (input.initial ?? "");
    },
  };
  return { q, asked, lists };
}

const URL_TITLE = "OpenAI Compatible base URL (the /v1 part, without /embeddings)";
const PROVIDER_TITLE = "Embeddings for phantom";
const MODEL_TITLE = "Embedding model";
const KEY_TITLE = "API key (optional)";

function existing(
  openai?: Partial<NonNullable<Config["embeddings"]["openaiCompatible"]>>,
): Config["embeddings"] {
  return {
    provider: openai ? "openai-compatible" : "none",
    ...(openai
      ? {
          openaiCompatible: {
            baseUrl: "https://openrouter.ai/api/v1",
            model: "openai/text-embedding-3-small",
            apiKey: "stored-key",
            dims: 1536,
            queryPrefix: "",
            documentPrefix: "",
            ...openai,
          },
        }
      : {}),
  } as Config["embeddings"];
}

function deps(overrides: Partial<MemoryFlowDeps> = {}): MemoryFlowDeps {
  return {
    existing: existing(),
    validateGemini: async () => ({ ok: true, vector: [], dims: 1536 }) as never,
    validateOpenAI: async () => ({ ok: true, vector: [], dims: 1536 }) as never,
    fetchModels: async () => [],
    ...overrides,
  };
}

const LIVE = [
  "baai/bge-m3",
  "openai/text-embedding-3-large",
  "openai/text-embedding-3-small",
];

describe("configureMemory — embedding model picker", () => {
  test("offers the endpoint's models as a list, fetched with the key the user just gave", async () => {
    const { q, asked, lists } = questions({
      picks: {
        [PROVIDER_TITLE]: "openai-compatible",
        [MODEL_TITLE]: "baai/bge-m3",
      },
      values: { [URL_TITLE]: "https://openrouter.ai/api/v1/", [KEY_TITLE]: " or-key " },
    });
    const fetched: string[] = [];
    const result = await configureMemory(
      "phantom",
      q,
      deps({
        fetchModels: async (baseUrl, apiKey) => {
          fetched.push(`${baseUrl}|${apiKey}`);
          return LIVE;
        },
      }),
    );

    expect(fetched).toEqual(["https://openrouter.ai/api/v1/|or-key"]);
    // Key before model: the list needs the credential.
    expect(asked.indexOf(KEY_TITLE)).toBeLessThan(asked.indexOf(MODEL_TITLE));
    expect(lists[MODEL_TITLE]!.via).toBe("search");
    expect(lists[MODEL_TITLE]!.options.map((o) => o.value)).toEqual([
      ...LIVE,
      OTHER_EMBEDDING_MODEL,
    ]);
    expect(result && "update" in result && result.update.openaiCompatible?.model).toBe(
      "baai/bge-m3",
    );
    expect(result && "summary" in result && result.summary).toBe(
      "openai-compatible · baai/bge-m3",
    );
  });

  test("falls back to the plain Choose screen when the host has no search screen", async () => {
    const { q, lists } = questions({
      search: false,
      picks: { [PROVIDER_TITLE]: "openai-compatible" },
      values: { [URL_TITLE]: "https://openrouter.ai/api/v1" },
    });
    const result = await configureMemory("phantom", q, deps({ fetchModels: async () => LIVE }));
    expect(lists[MODEL_TITLE]!.via).toBe("choose");
    expect(result && "update" in result && result.update.openaiCompatible?.model).toBe(LIVE[0]);
  });

  test("'Other' opens the typed prompt, and the typed id is what gets validated and saved", async () => {
    const { q } = questions({
      picks: {
        [PROVIDER_TITLE]: "openai-compatible",
        [MODEL_TITLE]: OTHER_EMBEDDING_MODEL,
      },
      values: { [URL_TITLE]: "https://openrouter.ai/api/v1", [MODEL_TITLE]: "  acme/odd-v2 " },
    });
    const validated: string[] = [];
    const result = await configureMemory(
      "phantom",
      q,
      deps({
        fetchModels: async () => LIVE,
        validateOpenAI: async (s) => {
          validated.push(s.model);
          return { ok: true, vector: [], dims: 768 } as never;
        },
      }),
    );
    expect(validated).toEqual(["acme/odd-v2"]);
    expect(result && "update" in result && result.update.openaiCompatible?.model).toBe(
      "acme/odd-v2",
    );
  });

  test("no discoverable models keeps the typed prompt and never shows a list", async () => {
    const { q, lists } = questions({
      picks: { [PROVIDER_TITLE]: "openai-compatible" },
      values: { [URL_TITLE]: "http://127.0.0.1:8082/v1", [MODEL_TITLE]: "my-gguf" },
    });
    const result = await configureMemory("phantom", q, deps());
    expect(lists[MODEL_TITLE]).toBeUndefined();
    expect(result && "update" in result && result.update.openaiCompatible?.model).toBe("my-gguf");
  });

  test("an empty typed model is rejected, not saved", async () => {
    const { q } = questions({
      picks: { [PROVIDER_TITLE]: "openai-compatible" },
      values: { [URL_TITLE]: "http://127.0.0.1:8082/v1", [MODEL_TITLE]: "  " },
    });
    expect(await configureMemory("phantom", q, deps())).toEqual({
      rejected: "model is required",
    });
  });

  test("cancelling the picker writes nothing", async () => {
    const { q } = questions({
      picks: { [PROVIDER_TITLE]: "openai-compatible", [MODEL_TITLE]: undefined },
      values: { [URL_TITLE]: "https://openrouter.ai/api/v1" },
    });
    expect(
      await configureMemory("phantom", q, deps({ fetchModels: async () => LIVE })),
    ).toBeUndefined();
  });

  test("re-running and keeping every default is idempotent — the current model is preselected", async () => {
    const cfg = existing({});
    const { q, lists } = questions({ picks: { "Use stored key for this endpoint?": "keep" } });
    const result = await configureMemory(
      "phantom",
      q,
      deps({
        existing: cfg,
        findOpenAICredential: async () => ({ value: "stored-key" }),
        fetchModels: async () => LIVE,
      }),
    );
    expect(lists[MODEL_TITLE]!.initial).toBe("openai/text-embedding-3-small");
    expect(result && "update" in result && embeddingUpdateEquals(cfg, result.update)).toBe(true);
  });

  test("a configured model the endpoint does not list is still the default, so a re-run rewrites nothing", async () => {
    const cfg = existing({ model: "acme/odd-v2" });
    const { q, lists } = questions({ picks: { "Use stored key for this endpoint?": "keep" } });
    const result = await configureMemory(
      "phantom",
      q,
      deps({
        existing: cfg,
        findOpenAICredential: async () => ({ value: "stored-key" }),
        fetchModels: async () => LIVE,
      }),
    );
    expect(lists[MODEL_TITLE]!.options[0]!.value).toBe("acme/odd-v2");
    expect(result && "update" in result && embeddingUpdateEquals(cfg, result.update)).toBe(true);
  });

  test("switching endpoint does not carry the old endpoint's model into the new list", async () => {
    const { q, lists } = questions({
      values: { [URL_TITLE]: "https://api.openai.com/v1", [KEY_TITLE]: "sk" },
    });
    const result = await configureMemory(
      "phantom",
      q,
      deps({
        existing: existing({}),
        fetchModels: async () => ["text-embedding-3-large", "text-embedding-3-small"],
      }),
    );
    expect(lists[MODEL_TITLE]!.options.map((o) => o.value)).toEqual([
      "text-embedding-3-large",
      "text-embedding-3-small",
      OTHER_EMBEDDING_MODEL,
    ]);
    expect(result && "update" in result && result.update.openaiCompatible?.model).toBe(
      "text-embedding-3-large",
    );
  });
});
