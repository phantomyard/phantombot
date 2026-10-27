/**
 * The LAST-RESORT model catalogue: ask the provider itself.
 *
 * WHY THIS EXISTS. The wizard's model pickers are fed by `pi --list-models`,
 * which only knows about providers Pi already holds a key for — and only after
 * Pi's own auth store or an injected env var has taken effect. When any link in
 * that chain is missing (no `pi` on PATH, a key Pi hasn't picked up yet, a
 * provider Pi doesn't enumerate) the picker collapsed to a single `(none)` row
 * and asked the operator to type a model id from memory. Nobody knows
 * `anthropic/claude-sonnet-4.6` by heart; a searchable list is the whole point.
 *
 * So when the catalogue for the chosen provider comes back empty, we ask the
 * provider's OWN models endpoint with the key the operator just typed. Those
 * are the models that account can actually use — always current, nothing to
 * keep in sync in this repo, which is exactly why this is a live fetch and not
 * a hardcoded list of model names that would rot within a release.
 *
 * Endpoints are shared with `providerKeyProbe.ts` (same hosts, same auth); this
 * module reads the response body the probe throws away.
 *
 * Failure is never fatal: any error, timeout or unexpected shape returns [] and
 * the picker falls back to free-text entry exactly as before.
 */

import type { PiModel } from "./piModels.ts";
import {
  customProviderSpec,
  resolveCustomProviderBaseUrl,
} from "./piCustomProvider.ts";
import { BROWSER_UA, OPENAI_COMPATIBLE_BASES } from "./providerKeyProbe.ts";

/**
 * Providers whose model list is NOT at an OpenAI-shaped `{base}/models`.
 *
 * Deliberately separate from `providerKeyProbe`'s table even where the host
 * matches: the probe asks for ONE row (`limit=1`) because it only wants the
 * status code, and OpenRouter's probe hits `/key`, which returns no models at
 * all. Here we want the whole catalogue.
 */
const CATALOG_ENDPOINTS: Record<
  string,
  (key: string) => { url: string; headers: Record<string, string> }
> = {
  anthropic: (key) => ({
    url: "https://api.anthropic.com/v1/models?limit=1000",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  }),
  google: (key) => ({
    url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
    headers: { "x-goog-api-key": key },
  }),
  // Public — no key needed, which is what lets the picker fill in before Pi
  // has been keyed at all.
  openrouter: () => ({ url: "https://openrouter.ai/api/v1/models", headers: {} }),
};

/**
 * Where to GET a full model list, and how to authenticate it.
 *
 * `baseUrl` is the operator's endpoint and only matters for the
 * bring-your-own-endpoint providers (issue #694): their `/models` lives wherever
 * they say it does. For PhantomOps it defaults to the gateway, so a personal
 * token alone is enough.
 */
function endpointFor(
  providerId: string,
  key: string,
  baseUrl?: string,
): { url: string; headers: Record<string, string>; authRequired: boolean } | undefined {
  const custom = customProviderSpec(providerId);
  if (custom) {
    const base = resolveCustomProviderBaseUrl(providerId, baseUrl);
    if (!base) return undefined;
    return {
      url: `${base}/models`,
      // A self-hosted OpenAI-compatible server may be unauthenticated (Ollama,
      // LM Studio, llama.cpp) — an empty Bearer is worse than no header at all,
      // and PhantomOps genuinely requires the token.
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      authRequired: providerId === "phantomops",
    };
  }
  const special = CATALOG_ENDPOINTS[providerId];
  if (special) return { ...special(key), authRequired: true };
  const base = OPENAI_COMPATIBLE_BASES[providerId];
  if (base) {
    return {
      url: `${base}/models`,
      headers: { Authorization: `Bearer ${key}` },
      authRequired: true,
    };
  }
  return undefined;
}

/**
 * Pull model ids out of a provider response.
 *
 * Three shapes cover every endpoint we call: OpenAI-compatible and Anthropic
 * both return `{ data: [{ id }] }`, Google returns `{ models: [{ name }] }`
 * with a `models/` prefix to strip, and OpenRouter returns the OpenAI shape
 * plus an `architecture.input_modalities` array we read image support from.
 */
function parseModels(providerId: string, body: unknown): PiModel[] {
  const rows: PiModel[] = [];
  const seen = new Set<string>();
  const push = (id: unknown, supportsImages: boolean) => {
    if (typeof id !== "string") return;
    const model = id.trim();
    // Google prefixes every name with "models/"; `pi --model` wants the bare id.
    const bare = model.startsWith("models/") ? model.slice("models/".length) : model;
    if (!bare || seen.has(bare)) return;
    seen.add(bare);
    rows.push({ provider: providerId, model: bare, supportsImages });
  };

  const obj = body as Record<string, unknown> | null;
  if (!obj || typeof obj !== "object") return rows;
  const list = Array.isArray(obj.data)
    ? obj.data
    : Array.isArray(obj.models)
      ? obj.models
      : [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const arch = e.architecture as Record<string, unknown> | undefined;
    const modalities = arch && Array.isArray(arch.input_modalities)
      ? (arch.input_modalities as unknown[])
      : undefined;
    // Vision is only claimed when the provider says so. An unknown capability
    // counts as text-only, so the wizard still ASKS for a vision delegate
    // rather than silently routing images at a model that cannot see them.
    const supportsImages = modalities
      ? modalities.includes("image")
      : Array.isArray(e.input_modalities)
        ? (e.input_modalities as unknown[]).includes("image")
        : false;
    push(e.id ?? e.name, supportsImages);
  }
  return rows;
}

/**
 * Put a provider's DEFAULT model first.
 *
 * The PhantomOps gateway already publishes `phantomops/auto` first
 * (`backend/openai_gateway.py`), but the pickers pre-select index 0, and the
 * default is a product decision rather than an incidental ordering: the whole
 * point of the provider is that the token runs the user's full phantom. Stated
 * here so it survives a server-side reordering.
 */
function orderDefaults(providerId: string, models: PiModel[]): PiModel[] {
  const preferred = customProviderSpec(providerId)?.defaultModel;
  if (!preferred) return models;
  const first = models.filter((m) => m.model === preferred);
  if (first.length === 0) return models;
  return [...first, ...models.filter((m) => m.model !== preferred)];
}

/**
 * Live model catalogue for one provider, or [] if it can't be fetched.
 *
 * `key` may be empty for providers whose catalogue is public (OpenRouter) —
 * everyone else needs one, and without it we return [] rather than firing an
 * unauthenticated request we know will 401.
 */
export async function fetchProviderModels(
  providerId: string,
  key = "",
  fetchImpl: typeof fetch = fetch,
  opts: { baseUrl?: string } = {},
): Promise<PiModel[]> {
  const trimmed = key.trim();
  const endpoint = endpointFor(providerId, trimmed, opts.baseUrl);
  if (!endpoint) return [];
  // OpenRouter's /models is public, and a self-hosted OpenAI-compatible server
  // may be too; everything else authenticates.
  if (!trimmed && providerId !== "openrouter" && endpoint.authRequired) return [];
  try {
    const res = await fetchImpl(endpoint.url, {
      headers: { "User-Agent": BROWSER_UA, ...endpoint.headers },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    return orderDefaults(providerId, parseModels(providerId, await res.json()));
  } catch {
    return [];
  }
}
