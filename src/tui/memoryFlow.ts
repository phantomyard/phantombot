/**
 * The memory row, as a sequence of SCREEN questions.
 *
 * `phantombot embedding` asks these with @clack; this module keeps that
 * walkthrough — provider picker, key validation, endpoint checks — and asks
 * on screens instead. The WRITE path stays the CLI's (`applyEmbeddingConfig`
 * via `applyEmbedding` in `actions.ts`), so the two surfaces cannot write
 * different shapes of the same block.
 *
 * No test screen: recall is judged by using the phantom, not by typing into
 * a box here. Setup only, and idempotent — re-running the flow and keeping
 * every answer writes the same bytes (or none at all; see
 * `embeddingUpdateEquals`).
 *
 * Every question is injected, so cancelling is a real answer at any step:
 * `undefined` anywhere means nothing is written.
 */

import type { EmbeddingConfigUpdate } from "../cli/embedding.ts";
import type { OpenAICompatibleConfigUpdate } from "../cli/embedding.ts";
import type { Config } from "../config.ts";
import type { EmbedResult } from "../lib/geminiEmbed.ts";
import type { ChannelsQuestions } from "./channelsFlow.ts";

/**
 * The questions the flow needs. Same shape as the channels flow's, plus the
 * Choose screen's `initial` (cursor starts on the current value) and
 * `description` — App's `askChoice` supplies both.
 */
export interface MemoryQuestions {
  choose(input: {
    title: string;
    description?: string;
    initial?: string;
    options: readonly { value: string; label: string; hint?: string }[];
  }): Promise<string | undefined>;
  value: ChannelsQuestions["value"];
}

/** Kept in step with the clack wizard's Gemini defaults (lib/geminiEmbed.ts). */
export const GEMINI_MODEL = "gemini-embedding-001";
export const GEMINI_DIMS = 1536;

export interface MemoryFlowDeps {
  /** The host's current embeddings block, so defaults prefill from reality. */
  existing: Config["embeddings"];
  /** One live one-token embed — a key that fails never reaches the config. */
  validateGemini(key: string): Promise<EmbedResult>;
  /** Same check for an OpenAI-compatible endpoint. */
  validateOpenAI(
    settings: OpenAICompatibleConfigUpdate,
  ): Promise<EmbedResult>;
}

export type MemoryFlowResult =
  | { rejected: string }
  | { update: EmbeddingConfigUpdate; summary: string };

/**
 * Ask everything the clack wizard asks. `undefined` means the user backed out;
 * `{ rejected }` means a key or endpoint failed its live check and nothing was
 * written.
 */
export async function configureMemory(
  persona: string,
  q: MemoryQuestions,
  deps: MemoryFlowDeps,
): Promise<MemoryFlowResult | undefined> {
  const existing = deps.existing;
  const current =
    existing.provider === "none"
      ? "none"
      : existing.provider;

  const provider = await q.choose({
    title: `Embeddings for ${persona}`,
    description:
      "embeddings add semantic retrieval to long-term memory — lexical search stays on regardless, and threat screening is unaffected",
    options: [
      {
        value: "gemini",
        label: `Gemini (${GEMINI_MODEL}, ${GEMINI_DIMS} dims)`,
        hint:
          current === "gemini"
            ? "current · semantic search · free tier 1500 req/day"
            : "semantic search · free tier 1500 req/day",
      },
      {
        value: "openai-compatible",
        label: "OpenAI-compatible (local or remote /embeddings)",
        hint:
          current === "openai-compatible"
            ? "current · llama-server and other standard-compatible endpoints"
            : "llama-server and other standard-compatible endpoints",
      },
      {
        value: "none",
        label: "None — OKF field-weighted BM25 + link-graph expansion",
        hint:
          current === "none"
            ? "current · no API key · lexical only"
            : "no API key · lexical only",
      },
    ],
    initial: current,
  });
  if (!provider) return undefined;

  if (provider === "none") {
    return {
      update: { provider: "none" },
      summary: "lexical only (embeddings off)",
    };
  }

  if (provider === "gemini") return geminiFlow(persona, q, deps);

  const cur = existing.openaiCompatible;
  const baseUrl = await q.value({
    title: "OpenAI-compatible base URL (the /v1 part, without /embeddings)",
    hint: "e.g. http://127.0.0.1:8082/v1 for a local llama-server",
    initial: cur?.baseUrl ?? "",
  });
  if (baseUrl === undefined) return undefined;
  if (!baseUrl.trim()) return { rejected: "base URL is required" };

  const model = await q.value({
    title: "Embedding model",
    initial: cur?.model ?? "",
  });
  if (model === undefined) return undefined;
  if (!model.trim()) return { rejected: "model is required" };

  const apiKey = await q.value({
    title: "API key (optional)",
    hint: "leave empty for a local llama-server",
    masked: true,
    allowEmpty: true,
  });
  if (apiKey === undefined) return undefined;

  const queryPrefix = await q.value({
    title: "Query prefix (optional)",
    initial: cur?.queryPrefix ?? "",
    allowEmpty: true,
  });
  if (queryPrefix === undefined) return undefined;

  const documentPrefix = await q.value({
    title: "Document prefix (optional)",
    initial: cur?.documentPrefix ?? "",
    allowEmpty: true,
  });
  if (documentPrefix === undefined) return undefined;

  const settings: OpenAICompatibleConfigUpdate = {
    baseUrl: baseUrl.trim(),
    model: model.trim(),
    apiKey: apiKey.trim(),
    queryPrefix: queryPrefix.trim(),
    documentPrefix: documentPrefix.trim(),
    maxChunkChars: cur?.maxChunkChars,
  };
  const r = await deps.validateOpenAI(settings);
  if (!r.ok) return { rejected: r.error };

  return {
    update: { provider: "openai-compatible", openaiCompatible: { ...settings, dims: r.dims } },
    summary: `openai-compatible · ${settings.model}`,
  };
}

async function geminiFlow(
  persona: string,
  q: MemoryQuestions,
  deps: MemoryFlowDeps,
): Promise<MemoryFlowResult | undefined> {
  // An existing key is offered back rather than re-asked: retyping a working
  // key to revisit the flow is the fastest way to end up with a typo where a
  // working credential was. Keeping it passes the stored key through, so the
  // write stays idempotent (applyEmbeddingConfig writes the key it is given).
  let apiKey: string | undefined;
  if (deps.existing.gemini?.apiKey) {
    const action = await q.choose({
      title: `Gemini API key for ${persona}`,
      options: [
        { value: "keep", label: "Keep the stored key" },
        { value: "replace", label: "Replace it" },
      ],
      initial: "keep",
    });
    if (!action) return undefined;
    apiKey = action === "keep" ? deps.existing.gemini!.apiKey : undefined;
  }
  if (apiKey === undefined) {
    const typed = await q.value({
      title: `Gemini API key for ${persona}`,
      hint: "aistudio.google.com/app/apikey — checked before it is stored",
      masked: true,
    });
    if (typed === undefined) return undefined;
    if (!typed.trim()) return { rejected: "key is required" };
    apiKey = typed.trim();
  }

  const r = await deps.validateGemini(apiKey);
  if (!r.ok) return { rejected: r.error };

  return {
    update: { provider: "gemini", apiKey, model: GEMINI_MODEL, dims: GEMINI_DIMS },
    summary: `gemini · ${GEMINI_MODEL} · ${GEMINI_DIMS} dims`,
  };
}

/**
 * True when the update would write what is already on disk — the flow's
 * idempotence check. The caller uses it to skip the confirm and the write
 * entirely ("memory unchanged — already set").
 */
export function embeddingUpdateEquals(
  existing: Config["embeddings"],
  update: EmbeddingConfigUpdate,
): boolean {
  if (update.provider === "none") return existing.provider === "none";
  if (update.provider === "gemini") {
    return (
      existing.provider === "gemini" &&
      existing.gemini !== undefined &&
      existing.gemini.apiKey === update.apiKey &&
      existing.gemini.model === (update.model ?? GEMINI_MODEL) &&
      existing.gemini.dims === (update.dims ?? GEMINI_DIMS)
    );
  }
  const o = update.openaiCompatible;
  const cur = existing.openaiCompatible;
  if (existing.provider !== "openai-compatible" || !o || !cur) return false;
  return (
    cur.baseUrl === o.baseUrl &&
    cur.model === o.model &&
    cur.apiKey === (o.apiKey ?? "") &&
    cur.queryPrefix === (o.queryPrefix ?? "") &&
    cur.documentPrefix === (o.documentPrefix ?? "")
  );
}
