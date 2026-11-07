/**
 * `engine.embeddings`: the embeddings setup building block for an embedding
 * app's own settings UI, so the app can offer what `phantombot embedding`
 * offers on the CLI.
 *
 * Same discovery and the same proof as the wizard: the OpenAI-compatible
 * model list comes from `fetchEmbeddingModels` (the endpoint's Models API),
 * and a choice is only `verified` after a live one-token embed with it, which
 * is also where `dims` comes from. Persist with
 * `persona.configure({ embeddings: { ..., dims } })`.
 *
 * Nothing here stores anything. The key is sent to the provider (Gemini, or
 * the endpoint the caller names, as `voiceModels.check` does) and dropped.
 */

import { EngineError } from "./errors.ts";
import { geminiEmbed, type EmbedResult } from "../lib/geminiEmbed.ts";
import { openaiCompatibleEmbed } from "../lib/openaiCompatibleEmbed.ts";
import { fetchEmbeddingModels } from "../lib/embeddingModels.ts";
import { timeoutSignal } from "../lib/fetchTimeout.ts";
import { EMBEDDINGS_PRESETS, embeddingsPreset } from "../lib/specializedProviders.ts";
import type { EmbeddingsCheck, EmbeddingsCheckInput, EmbeddingsConfig, EmbeddingsProviderInfo } from "./types.ts";

export const GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";
export const GEMINI_EMBEDDING_DIMS = 1536;
const MAX_KEY_CHARS = 4096;
const MAX_MODEL_CHARS = 512;
const PROBE_TEXT = "phantombot embedding validation test";

/** @internal Test seams; not exported from `index.ts`. */
export interface EmbeddingsBackends {
  gemini: (key: string, model: string, signal: AbortSignal) => Promise<EmbedResult>;
  openai: (
    o: { baseUrl: string; model: string; apiKey?: string },
    signal: AbortSignal,
  ) => Promise<EmbedResult>;
  models: (baseUrl: string, apiKey: string, signal: AbortSignal) => Promise<string[]>;
}

const realBackends: EmbeddingsBackends = {
  gemini: (key, model, signal) =>
    geminiEmbed(key, PROBE_TEXT, { model, dims: GEMINI_EMBEDDING_DIMS, signal }),
  openai: (o, signal) => openaiCompatibleEmbed(PROBE_TEXT, { ...o, signal }),
  models: (baseUrl, apiKey, signal) => fetchEmbeddingModels(baseUrl, apiKey, fetch, signal),
};

let backendsForTesting: EmbeddingsBackends | undefined;

/** @internal Tests only. Pass undefined to restore the real network calls. */
export function _setEmbeddingsBackendsForTesting(b: EmbeddingsBackends | undefined): void {
  backendsForTesting = b;
}

/** Gemini, Pi providers with an embeddings API, then bring-your-own endpoint. */
export function embeddingsProviders(): EmbeddingsProviderInfo[] {
  return [
    { id: "gemini", label: "Google Gemini", needsBaseUrl: false, keyOptional: false },
    ...EMBEDDINGS_PRESETS.map((p) => ({
      id: p.id,
      label: p.label,
      needsBaseUrl: false,
      keyOptional: false,
      transport: { provider: "openai-compatible" as const, baseUrl: p.baseUrl },
    })),
    { id: "openai-compatible", label: "OpenAI Compatible", needsBaseUrl: true, keyOptional: true },
  ];
}

/** A preset id becomes openai-compatible + the preset's own URL, for storage. */
export function resolveEmbeddingsProvider<T extends EmbeddingsConfig | undefined>(em: T): T {
  const preset = em ? embeddingsPreset(em.provider) : undefined;
  if (preset && (typeof (em as { apiKey?: unknown }).apiKey !== "string" || !(em as { apiKey: string }).apiKey.trim())) {
    throw new EngineError("invalid_argument", `embeddings.apiKey is required for ${preset.label}`);
  }
  return preset ? ({ ...em, provider: "openai-compatible", baseUrl: preset.baseUrl } as T) : em;
}

function validateEndpoint(baseUrl: unknown): string {
  try {
    if (typeof baseUrl !== "string" || baseUrl.length > 2048) throw 0;
    const trimmed = baseUrl.trim().replace(/\/+$/, "");
    const u = new URL(trimmed);
    if (!["https:", "http:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw 0;
    return trimmed;
  } catch {
    throw new EngineError(
      "invalid_argument",
      "embeddings.baseUrl must be an http(s) endpoint without credentials, query or fragment",
    );
  }
}

/** `detail` never carries the key, whatever the provider's error echoed. */
function redact(text: string, key: string): string {
  return key ? text.split(key).join("[key]") : text;
}

function optionalString(v: unknown, field: string, max: number): string {
  if (v === undefined) return "";
  if (typeof v !== "string" || v.length > max) {
    throw new EngineError("invalid_argument", `${field} must be a string`);
  }
  return v.trim();
}

/**
 * List the provider's embedding models and, when a model is given (Gemini
 * always has one), prove it with a live embed.
 *
 * - `"verified"`: the embed succeeded; `dims` is the vector size to save.
 * - `"failed"`: the embed was refused or errored; `detail` says why. Save
 *   nothing.
 * - `"unchecked"`: nothing to embed with yet (no Gemini key, or no
 *   OpenAI-compatible model chosen). `models` is still filled when the
 *   endpoint lists any.
 */
export async function checkEmbeddings(input: EmbeddingsCheckInput): Promise<EmbeddingsCheck> {
  if (!input || typeof input !== "object") {
    throw new EngineError("invalid_argument", "embeddings check input must be an object");
  }
  const requested = (input as { provider?: unknown }).provider;
  const preset = embeddingsPreset(requested);
  if (requested !== "gemini" && requested !== "openai-compatible" && !preset) {
    throw new EngineError(
      "invalid_argument",
      "embeddings provider must be 'gemini', 'openai-compatible' or a provider from embeddings.providers()",
      { provider: String(requested) },
    );
  }
  // A preset always uses its own endpoint, whatever baseUrl the caller sent.
  const provider = preset ? "openai-compatible" : requested;
  if (preset) input = { ...input, baseUrl: preset.baseUrl };
  const key = optionalString(input.apiKey, "apiKey", MAX_KEY_CHARS);
  const model = optionalString(input.model, "model", MAX_MODEL_CHARS);
  const b = backendsForTesting ?? realBackends;
  const signal = timeoutSignal(20_000);

  if (provider === "gemini") {
    const id = model || GEMINI_EMBEDDING_MODEL;
    if (!key) return { status: "unchecked", detail: "no key to check", models: [id] };
    const r = await b.gemini(key, id, signal);
    return r.ok
      ? { status: "verified", detail: `embedded (${r.dims} dims)`, models: [id], dims: r.dims }
      : { status: "failed", detail: redact(r.error, key), models: [id] };
  }

  if (preset && !key) return { status: "unchecked", detail: "no key to check", models: [...preset.models] };
  const baseUrl = validateEndpoint(input.baseUrl);
  const live = await b.models(baseUrl, key, signal).catch(() => [] as string[]);
  // No embedding models in the live list: the provider's known ones.
  const models = live.length || !preset ? live : [...preset.models];
  if (!model) return { status: "unchecked", detail: "choose a model", models };
  const r = await b.openai({ baseUrl, model, ...(key ? { apiKey: key } : {}) }, signal);
  return r.ok
    ? { status: "verified", detail: `embedded (${r.dims} dims)`, models, dims: r.dims }
    : { status: "failed", detail: redact(r.error, key), models };
}
