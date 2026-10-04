/**
 * Embedding-model discovery for the memory wizard's picker.
 *
 * The wizard used to ask for the model as free text, which is the one field a
 * user cannot guess: the id must match the endpoint's catalogue exactly, and a
 * typo only surfaces as a rejected validation embed. This asks the endpoint's
 * Models API instead, so the wizard can offer a list the same way the voice
 * and decision-model pickers do.
 *
 * Two discovery paths, tried in this order:
 *
 *   1. MODALITY TAG. OpenRouter splits its catalogue by output modality:
 *      `/models?output_modalities=embeddings` returns the embedding models and
 *      annotates every row with that modality (the unfiltered `/models` carries
 *      none of them — verified live 2026-10-04: 37 tagged rows vs. 466 chat
 *      rows with no embedding model among them). The annotation is REQUIRED,
 *      for the reason `fetchOpenAIAudioModels` gives: an endpoint that ignores
 *      the unknown query parameter must not turn its whole chat catalogue into
 *      a bogus embedding menu.
 *   2. NAME FILTER. OpenAI and Ollama tag nothing, so when no row carries the
 *      annotation the ids are filtered by name. This is a heuristic and can
 *      miss an oddly named model — which is why the picker always keeps an
 *      "Other — type a model ID" entry, and why an empty result is non-fatal.
 *
 * Never throws: a network error, a timeout, a non-JSON body or an endpoint
 * with no Models API all degrade to `[]`, and the caller falls back to the
 * typed prompt.
 */

import { timeoutSignal } from "./fetchTimeout.ts";

/** Picker sentinel for "Other — type a model ID". Never a real model id. */
export const OTHER_EMBEDDING_MODEL = "__other_embedding_model__";

/** The output modality OpenRouter tags embedding models with. */
export const EMBEDDING_MODALITY = "embeddings";

/**
 * Discovery must never stall the wizard on a dead endpoint. This bounds the
 * WHOLE discovery — the tagged request and the plain-catalogue retry share one
 * deadline, so a stalled endpoint costs 5 seconds, not 5 per request.
 */
export const EMBEDDING_MODELS_TIMEOUT_MS = 5000;

/**
 * Name heuristic for endpoints that do not tag models by modality.
 *
 * `embed` covers the common case (`text-embedding-3-small`, `nomic-embed-text`,
 * `mxbai-embed-large`, `embeddinggemma`). The second alternative covers the
 * well-known embedding families whose ids do not say so (`bge-m3`,
 * `all-minilm`, `multilingual-e5-large`, `gte-large`); each must stand as its
 * own token so that an unrelated id merely containing the letters does not
 * match.
 */
export const EMBEDDING_MODEL_NAME_PATTERN =
  /embed|(?:^|[^a-z0-9])(?:bge|gte|e5|minilm)(?:[^a-z0-9]|$)/i;

export function looksLikeEmbeddingModel(id: string): boolean {
  return EMBEDDING_MODEL_NAME_PATTERN.test(id);
}

interface ModelRow {
  id?: unknown;
  architecture?: { output_modalities?: unknown } | null;
}

function modelsUrl(baseUrl: string, tagged: boolean): URL {
  const url = new URL(`${baseUrl.trim().replace(/\/+$/, "")}/models`);
  if (tagged) url.searchParams.set("output_modalities", EMBEDDING_MODALITY);
  return url;
}

async function fetchRows(
  url: URL,
  apiKey: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<ModelRow[] | undefined> {
  const key = apiKey.trim();
  const res = await fetchImpl(url, {
    // No key is a real configuration (a local llama-server or Ollama).
    headers: key ? { authorization: `Bearer ${key}` } : {},
    signal,
  });
  if (!res.ok) return undefined;
  const body = (await res.json().catch(() => null)) as
    | { data?: unknown }
    | null;
  return Array.isArray(body?.data) ? (body.data as ModelRow[]) : undefined;
}

function ids(rows: ModelRow[]): string[] {
  const out = new Set<string>();
  for (const row of rows) {
    if (typeof row?.id !== "string") continue;
    const id = row.id.trim();
    if (id && id !== OTHER_EMBEDDING_MODEL) out.add(id);
  }
  // Sorted for determinism — the wire order is not a contract.
  return [...out].sort((a, b) => a.localeCompare(b));
}

function isTagged(row: ModelRow): boolean {
  const modalities = row?.architecture?.output_modalities;
  return Array.isArray(modalities) && modalities.includes(EMBEDDING_MODALITY);
}

/**
 * The embedding-capable model ids an OpenAI-compatible endpoint offers, or
 * `[]` when it offers none that can be recognised (or cannot be asked).
 *
 * `(baseUrl, apiKey)` — the order of the wizards' `fetchModels` seam, which
 * this is the default for. Both are strings, so the compiler cannot catch a
 * swap: the default-wiring tests in the two flow suites are what pin it.
 */
export async function fetchEmbeddingModels(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  caller?: AbortSignal,
  timeoutMs: number = EMBEDDING_MODELS_TIMEOUT_MS,
): Promise<string[]> {
  if (!baseUrl.trim()) return [];
  // ONE deadline for both requests below.
  const signal = timeoutSignal(timeoutMs, caller);
  try {
    let rows: ModelRow[] | undefined;
    try {
      rows = await fetchRows(modelsUrl(baseUrl, true), apiKey, fetchImpl, signal);
    } catch {
      rows = undefined;
    }

    if (rows) {
      const tagged = ids(rows.filter(isTagged));
      if (tagged.length) return tagged;
    } else {
      // The filtered request itself failed (a strict endpoint may refuse an
      // unknown query parameter): ask again for the plain catalogue — unless
      // the deadline is what failed it, in which case there is no time left.
      if (signal.aborted) return [];
      rows = await fetchRows(modelsUrl(baseUrl, false), apiKey, fetchImpl, signal);
    }

    // Nothing tagged: either the endpoint ignored the filter and returned its
    // whole catalogue, or this is the plain catalogue. Filter by name.
    return ids(rows ?? []).filter(looksLikeEmbeddingModel);
  } catch {
    return [];
  }
}

/** The wizards' test seam for discovery — same order as the default. */
export type EmbeddingModelFetcher = (
  baseUrl: string,
  apiKey: string,
) => Promise<string[]>;

/**
 * The one place a wizard turns what the user typed into a discovery call.
 *
 * The endpoint is passed BY NAME because the screen flow and its clack twin
 * each hold two bare strings, and a positional call lets them be swapped
 * without a type error — which is exactly how the picker once sent the key as
 * the URL and silently fell back to the typed prompt. Both wizards call this,
 * so the positional hand-off exists once, here, under test.
 */
export function discoverEmbeddingModels(
  endpoint: { baseUrl: string; apiKey: string },
  fetchModels: EmbeddingModelFetcher = fetchEmbeddingModels,
): Promise<string[]> {
  return fetchModels(endpoint.baseUrl.trim(), endpoint.apiKey.trim());
}

export interface EmbeddingModelOption {
  value: string;
  label: string;
  hint?: string;
}

/**
 * Trailing slashes and case in the scheme/host do not make a different
 * endpoint; case in the PATH can, so it is compared as written.
 */
export function sameEmbeddingEndpoint(a: string | undefined, b: string): boolean {
  const norm = (v: string) => {
    const bare = v.trim().replace(/\/+$/, "");
    try {
      const url = new URL(bare);
      // URL lowercases the scheme and host itself and leaves the path alone.
      return `${url.origin}${url.pathname.replace(/\/+$/, "")}${url.search}`;
    } catch {
      return bare;
    }
  };
  return a !== undefined && norm(a) === norm(b);
}

/**
 * The picker's rows, shared by the screen flow and its clack twin so the two
 * cannot offer different lists.
 *
 * `current` is the model already configured FOR THIS ENDPOINT (the caller
 * passes it only when the base URL is unchanged — another endpoint's model id
 * means nothing here). It is always offered and preselected, even when
 * discovery did not return it: the name filter can miss a model, and a re-run
 * that keeps every default must write nothing.
 */
export function embeddingModelPickerOptions(
  live: readonly string[],
  current?: string,
): { options: EmbeddingModelOption[]; initial: string } | undefined {
  if (!live.length) return undefined;
  const cur = current?.trim() || undefined;
  const listed = cur !== undefined && live.includes(cur);
  const options: EmbeddingModelOption[] = [
    ...(cur !== undefined && !listed
      ? [{ value: cur, label: cur, hint: "current · not in this endpoint's list" }]
      : []),
    ...live.map((model) => ({
      value: model,
      label: model,
      ...(model === cur ? { hint: "current" } : {}),
    })),
    {
      value: OTHER_EMBEDDING_MODEL,
      label: "Other — type a model ID",
      hint: "checked with a live embed before anything is saved",
    },
  ];
  return { options, initial: cur ?? live[0]! };
}
