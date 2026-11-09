/**
 * PhantomOps platform models: a persona whose native brain is the PhantomOps
 * gateway (`pok_` token) inherits the embeddings, decision, text-to-speech and
 * speech-to-text models the PhantomOps admin configured centrally. The gateway
 * picks the model; the persona only names the slot.
 *
 * `persona.configure` takes `provider: "phantomops"` in `embeddings`,
 * `decisionModel` and `voice.tts` / `voice.stt`. Every slot reuses the brain's
 * own token and endpoint, so there is ONE credential to rotate:
 *
 *   - decision model and voice point their key name at the brain key
 *     (`PHANTOMBOT_PI_API_KEY`), so a new token reaches them at once;
 *   - embeddings has a fixed key name, so the token is copied there, and
 *     copied again whenever the brain key changes.
 *
 * Switching the brain away from PhantomOps turns every slot that borrowed its
 * token off: another provider's key must never reach the PhantomOps endpoint
 * (AGENTS invariant 63).
 *
 * `persona.platformModels()` asks the gateway which of those models exist
 * (`GET /models?output_modalities=…`) and which voices the TTS model offers,
 * with the stored token; the token never leaves the engine.
 */

import { timeoutSignal } from "../lib/fetchTimeout.ts";
import { PHANTOOPS_DEFAULT_BASE_URL, PHANTOOPS_PROVIDER } from "../lib/piCustomProvider.ts";
import type { PlatformModels } from "./types.ts";

/** The slot provider id that means "inherit from the PhantomOps server". */
export const PHANTOMOPS_PLATFORM = PHANTOOPS_PROVIDER;

/**
 * Placeholder model ids written into config. The gateway ignores the model a
 * caller names and uses the platform's, so these only satisfy the
 * transports' "model is required" rule and say where the model comes from.
 */
export const PHANTOMOPS_PLATFORM_MODELS = {
  embeddings: "phantomops/embeddings",
  decision: "phantomops/decision",
  tts: "phantomops/tts",
  stt: "phantomops/stt",
} as const;

/** The persona's PhantomOps endpoint: its stored base URL, else the default. */
export function phantomopsBaseUrl(routingBaseUrl: string | undefined): string {
  const stated = routingBaseUrl?.trim().replace(/\/+$/, "");
  return stated || PHANTOOPS_DEFAULT_BASE_URL;
}

/** Same endpoint, ignoring a trailing slash. */
export function sameEndpoint(a: unknown, b: string): boolean {
  return typeof a === "string" && a.trim().replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

type ModelRow = { id?: unknown; supported_voices?: unknown; architecture?: { output_modalities?: unknown } };

/** @internal Test seam. */
export type PlatformFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * One modality's platform model. `undefined` = the server has none
 * configured; a thrown error = the server could not be asked.
 */
async function platformModel(
  baseUrl: string,
  key: string,
  modality: "embeddings" | "decisions" | "speech" | "transcription",
  doFetch: PlatformFetch,
  signal: AbortSignal,
): Promise<{ id: string; voices: string[] } | undefined> {
  const url = new URL(`${baseUrl}/models`);
  url.searchParams.set("output_modalities", modality);
  const res = await doFetch(url.toString(), { headers: { authorization: `Bearer ${key}` }, signal });
  if (res.status === 401 || res.status === 403) throw new PlatformAuthError(`HTTP ${res.status}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json().catch(() => null)) as { data?: ModelRow[] } | null;
  // Same rule as fetchOpenAIAudioModels: only rows annotated with the asked
  // modality count, so a server that ignores the filter (an older gateway
  // returning its whole chat list) offers nothing rather than a bogus model.
  const row = (body?.data ?? []).find((r) =>
    typeof r?.id === "string" && r.id !== "" &&
    Array.isArray(r.architecture?.output_modalities) &&
    (r.architecture.output_modalities as unknown[]).includes(modality)
  );
  if (!row) return undefined;
  const voices = Array.isArray(row.supported_voices)
    ? [...new Set(row.supported_voices.filter((v): v is string => typeof v === "string" && v !== "" && v.length <= 512))]
    : [];
  return { id: row.id as string, voices };
}

class PlatformAuthError extends Error {}

/**
 * Ask the gateway for every platform model. Never throws: a server that
 * cannot be reached, or rejects the token, is `status: "unavailable"` with
 * the reason, and the caller configures nothing from it.
 */
export async function fetchPlatformModels(
  baseUrl: string,
  key: string,
  doFetch: PlatformFetch = fetch,
): Promise<PlatformModels> {
  const signal = timeoutSignal(20_000);
  try {
    const [embeddings, decision, tts, stt] = await Promise.all([
      platformModel(baseUrl, key, "embeddings", doFetch, signal),
      platformModel(baseUrl, key, "decisions", doFetch, signal),
      platformModel(baseUrl, key, "speech", doFetch, signal),
      platformModel(baseUrl, key, "transcription", doFetch, signal),
    ]);
    return {
      status: "available",
      detail: "",
      ...(embeddings ? { embeddings: embeddings.id } : {}),
      ...(decision ? { decision: decision.id } : {}),
      ...(tts ? { tts: { model: tts.id, voices: tts.voices } } : {}),
      ...(stt ? { stt: stt.id } : {}),
    };
  } catch (e) {
    const detail = e instanceof PlatformAuthError
      ? `PhantomOps rejected the token (${e.message})`
      : `PhantomOps unavailable: ${(e as Error).message}`;
    return { status: "unavailable", detail };
  }
}
