/**
 * Voice — TTS/STT provider configuration.
 *
 * Providers:
 *   - elevenlabs:  premium, custom voices, paid (key required)
 *   - openai-compatible: one endpoint/key with independent STT and TTS models
 *   - none:        TTS/STT disabled
 *
 * API keys live in the PERSONA'S ENCRYPTED VAULT (#452), injected into
 * process.env at startup by loadVaultIntoEnv(); voice metadata (provider,
 * voice ID, model, modulation params) lives in that persona's config.toml
 * under [voice].
 */

export type VoiceProvider =
  | "elevenlabs"
  | "openai-compatible"
  | "azure_edge" // read-only legacy value; never offered or written
  | "none";

export interface ElevenLabsVoice {
  voiceId: string;
  modelId: string;
  /** 0..1; higher = more consistent / less expressive */
  stability: number;
  /** 0..1; higher = closer match to the original voice */
  similarityBoost: number;
  /** 0..1; >0 leans into stylistic emphasis */
  style: number;
}

export interface OpenAICompatibleVoice {
  /** Includes the version prefix, e.g. https://api.openai.com/v1. */
  baseUrl: string;
  /** Persona-vault name used for this endpoint's credential. */
  keyEnv: string;
  /** Model sent to POST /audio/transcriptions. */
  sttModel: string;
  /** Model sent to POST /audio/speech. */
  ttsModel: string;
  /** any voice the chosen model accepts — see fetchOpenAIVoiceOptions() */
  voice: string;
  /** 0.25..4.0 */
  speed: number;
}

export interface AzureEdgeVoice {
  /** e.g. "en-US-JennyNeural", "en-US-AriaNeural" */
  voice: string;
  /** "+0%" | "+10%" | "-20%" etc. */
  rate: string;
  /** "+0Hz" | "+50Hz" etc. */
  pitch: string;
}

/**
 * Default bound on the voice download + transcribe step. A voice note is
 * short, so the round trip should complete well within this. The cap exists
 * so a hung STT request can't stall the per-chat queue forever (GitHub #135).
 */
export const DEFAULT_STT_TIMEOUT_MS = 60_000;

export interface VoiceConfig {
  provider: VoiceProvider;
  elevenlabs?: ElevenLabsVoice;
  openaiCompatible?: OpenAICompatibleVoice;
  azure_edge?: AzureEdgeVoice;
  /**
   * Upper bound (ms) on the combined download+transcribe step before it is
   * abandoned so the per-chat queue can advance. When unset, callers fall
   * back to DEFAULT_STT_TIMEOUT_MS; override via [voice] stt_timeout_ms in
   * config.toml.
   */
  sttTimeoutMs?: number;
}

/**
 * Can this provider TRANSCRIBE? Mirrors the dispatch in `lib/audio.ts`, which
 * supports exactly `elevenlabs` and `openai-compatible` and answers with an
 * actionable migration error for the retired Azure Edge value.
 */
export function providerHearsVoice(provider: VoiceProvider): boolean {
  return provider === "openai-compatible" || provider === "elevenlabs";
}

export const ENV_KEY_FOR_PROVIDER: Record<
  Exclude<VoiceProvider, "azure_edge" | "none">,
  string
> = {
  elevenlabs: "PHANTOMBOT_ELEVENLABS_API_KEY",
  "openai-compatible": "PHANTOMBOT_OPENAI_COMPATIBLE_API_KEY",
};

/** Voice-owned slot used when the operator declines a reusable shared key. */
export const OPENAI_COMPATIBLE_VOICE_KEY_ENV =
  "PHANTOMBOT_VOICE_OPENAI_COMPATIBLE_API_KEY";

export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OTHER_AUDIO_MODEL = "__other_audio_model__";

export type OpenAIAudioModality = "transcription" | "speech";

/** One audio model published by an OpenAI-compatible Models API. */
export interface OpenAIAudioModelOption {
  id: string;
  /** Model-scoped TTS voices, when the catalogue publishes them. */
  voices: string[];
}

/** Normalize for matching and safe endpoint construction. */
export function normalizeOpenAICompatibleBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/** True when a speech endpoint rejected the requested output encoding, not the voice. */
export function isUnsupportedSpeechFormatError(message: string): boolean {
  return /response[_ -]?format/i.test(message) && /\b(?:mp3|pcm)\b/i.test(message);
}

export function openAICompatibleProviderLabel(baseUrl: string): string {
  const host = (() => {
    try {
      return new URL(normalizeOpenAICompatibleBaseUrl(baseUrl)).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();
  if (host === "api.openai.com") return "OpenAI";
  if (host === "openrouter.ai") return "OpenRouter";
  return "OpenAI-compatible endpoint";
}

/** Preferred vault name for a newly entered endpoint credential. */
export function openAICompatibleKeyEnv(baseUrl: string): string {
  const label = openAICompatibleProviderLabel(baseUrl);
  if (label === "OpenAI") return "PHANTOMBOT_OPENAI_API_KEY";
  if (label === "OpenRouter") return "OPENROUTER_API_KEY";
  return ENV_KEY_FOR_PROVIDER["openai-compatible"];
}

/** Candidate vault names, ordered from the endpoint-native name to generic. */
export function openAICompatibleCredentialCandidates(baseUrl: string): string[] {
  return [...new Set([
    openAICompatibleKeyEnv(baseUrl),
    ENV_KEY_FOR_PROVIDER["openai-compatible"],
  ])];
}

/** A small curated default voice list per provider for the TUI. */
export const ELEVENLABS_DEFAULTS = {
  voiceId: "onwK4e9ZLuTAKqWW03F9", // "Daniel" — common OpenClaw default
  modelId: "eleven_turbo_v2_5",
  stability: 1,
  similarityBoost: 0.7,
  style: 0.8,
};

/**
 * Offline fallback for the voice pickers. The authoritative list is fetched
 * live (fetchOpenAIVoiceOptions) because OpenAI's voice set is model-scoped
 * and drifts without any release on our side: gpt-4o-mini-tts speaks 13
 * voices, tts-1/-hd only 9 (no ballad/verse/marin/cedar). Kept in
 * alphabetical order for a stable menu.
 */
export const OPENAI_FALLBACK_VOICE_OPTIONS = [
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "fable",
  "marin",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
] as const;

/**
 * Voices the legacy tts-1/-hd models REJECT — they arrived with
 * gpt-4o-mini-tts (13 - 4 = the 9 voices tts-1 offers). A menu that offers
 * `ballad` on a tts-1 persona persists an invalid pair that fails with
 * HTTP 400 on the next TTS call.
 */
const GPT_4O_MINI_TTS_ONLY = ["ballad", "cedar", "marin", "verse"];

/**
 * The offline fallback for ONE model: the full set for gpt-4o-mini-tts and
 * unknown models, minus the gpt-4o-mini-tts-only voices for the legacy
 * tts-1/-hd pair. Only ever used when the live probe returned nothing.
 */
export function fallbackVoiceOptions(model: string): string[] {
  const legacy = model === "tts-1" || model === "tts-1-hd";
  return OPENAI_FALLBACK_VOICE_OPTIONS.filter(
    (v) => !legacy || !GPT_4O_MINI_TTS_ONLY.includes(v),
  );
}

/**
 * The voice menu for ONE model: the live list when the probe returned one,
 * otherwise the model-scoped fallback — sorted for a stable menu. Both the
 * TUI flow and the CLI picker build their options with this, so an offline
 * legacy-model persona can never be offered a voice its model rejects.
 */
export function openAIVoiceMenuOptions(model: string, live: string[]): string[] {
  return (live.length ? live : fallbackVoiceOptions(model))
    .slice()
    .sort((a, b) => a.localeCompare(b));
}

export const OPENAI_COMPATIBLE_DEFAULTS: OpenAICompatibleVoice = {
  baseUrl: OPENAI_BASE_URL,
  keyEnv: "PHANTOMBOT_OPENAI_API_KEY",
  sttModel: "whisper-1",
  ttsModel: "gpt-4o-mini-tts",
  voice: "nova",
  speed: 1.0,
};

export const AZURE_EDGE_VOICE_OPTIONS = [
  "en-US-JennyNeural",
  "en-US-AriaNeural",
  "en-US-GuyNeural",
  "en-US-ChristopherNeural",
  "en-GB-LibbyNeural",
  "en-GB-RyanNeural",
] as const;

export const AZURE_EDGE_DEFAULTS: AzureEdgeVoice = {
  voice: "en-US-JennyNeural",
  rate: "+0%",
  pitch: "+0Hz",
};

/**
 * Validate an ElevenLabs key by hitting GET /v1/voices.
 */
export async function validateElevenLabsKey(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<{ ok: true; voiceCount: number } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl(
      "https://api.elevenlabs.io/v1/voices?show_legacy=false",
      { headers: { "xi-api-key": apiKey }, signal },
    );
    if (res.status === 401) return { ok: false, error: "401 Unauthorized — wrong key" };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = (await res.json()) as { voices?: unknown[] };
    return { ok: true, voiceCount: body.voices?.length ?? 0 };
  } catch (e) {
    return { ok: false, error: `network: ${(e as Error).message}` };
  }
}

/**
 * Validate an OpenAI key by hitting GET /v1/models (cheap, no quota cost).
 */
export async function validateOpenAICompatibleKey(
  apiKey: string,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<{ ok: true; modelCount: number } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl(`${normalizeOpenAICompatibleBaseUrl(baseUrl)}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal,
    });
    if (res.status === 401) return { ok: false, error: "401 Unauthorized — wrong key" };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = (await res.json()) as { data?: unknown[] };
    return { ok: true, modelCount: body.data?.length ?? 0 };
  } catch (e) {
    return { ok: false, error: `network: ${(e as Error).message}` };
  }
}

/** Backward-compatible helper for callers that specifically probe OpenAI. */
export async function validateOpenAIKey(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<{ ok: true; modelCount: number } | { ok: false; error: string }> {
  return validateOpenAICompatibleKey(apiKey, OPENAI_BASE_URL, fetchImpl, signal);
}

/**
 * Ask an OpenAI-compatible Models API for one audio capability. OpenRouter
 * documents this filter and annotates every returned row with the requested
 * output modality. Requiring that annotation matters: an endpoint that
 * ignores the unknown query parameter must not turn its entire text-model
 * catalogue into a bogus STT/TTS menu.
 *
 * An empty result is deliberately non-fatal. Generic compatible endpoints
 * are still configurable through the picker's "Other" / typed fallback.
 */
export async function fetchOpenAIAudioModels(
  apiKey: string,
  baseUrl: string,
  modality: OpenAIAudioModality,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<OpenAIAudioModelOption[]> {
  try {
    const url = new URL(`${normalizeOpenAICompatibleBaseUrl(baseUrl)}/models`);
    url.searchParams.set("output_modalities", modality);
    const res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal,
    });
    if (!res.ok) return [];
    const body = (await res.json().catch(() => null)) as
      | {
          data?: Array<{
            id?: unknown;
            supported_voices?: unknown;
            architecture?: { output_modalities?: unknown };
          }>;
        }
      | null;
    const models = (body?.data ?? [])
      .filter((row) =>
        Array.isArray(row.architecture?.output_modalities) &&
        row.architecture.output_modalities.includes(modality)
      )
      .flatMap((row) => {
        if (typeof row.id !== "string" || row.id.length === 0) return [];
        const voices = Array.isArray(row.supported_voices)
          ? [...new Set(row.supported_voices.filter(
            (voice): voice is string => typeof voice === "string" && voice.length > 0,
          ))]
          : [];
        return [{ id: row.id, voices }];
      });
    const unique = new Map<string, OpenAIAudioModelOption>();
    for (const model of models) {
      const previous = unique.get(model.id);
      unique.set(model.id, {
        id: model.id,
        voices: [...new Set([...(previous?.voices ?? []), ...model.voices])],
      });
    }
    return [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

/** Backward-compatible IDs-only view of the audio model catalogue. */
export async function fetchOpenAIAudioModelOptions(
  apiKey: string,
  baseUrl: string,
  modality: OpenAIAudioModality,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<string[]> {
  return (await fetchOpenAIAudioModels(apiKey, baseUrl, modality, fetchImpl, signal))
    .map((model) => model.id);
}

/**
 * Parse the voice list out of a speech-endpoint validation error. Two error
 * shapes exist in the wild:
 *   gpt-4o-mini-tts: "Invalid value: 'x'. Supported values are: 'alloy', … and 'cedar'."
 *   tts-1/-hd:       a pydantic dump whose 'expected' field quotes the list
 * Anything else (401, rate limit, unparsed wording) yields [], and the
 * caller falls back to OPENAI_FALLBACK_VOICE_OPTIONS.
 */
export function parseOpenAIVoiceOptions(message: string): string[] {
  const scope =
    /Supported values are: (.+)$/i.exec(message)?.[1] ??
    /Supported voices:\s*(.+)$/i.exec(message)?.[1] ??
    /"?expected"?\s*:\s*"(.+?)"/.exec(message)?.[1] ??
    /Input should be (.+?)"/.exec(message)?.[1] ??
    "";
  const voices: string[] = [];
  for (const m of scope.matchAll(/['"]([a-z][a-z0-9_-]*)['"]/gi)) {
    const v = m[1];
    if (v && !voices.includes(v)) voices.push(v);
  }
  if (voices.length === 0 && /Supported voices:/i.test(message)) {
    for (const token of scope.replace(/[.\s]+$/, "").split(/,|\s+(?:and|or)\s+/i)) {
      const v = token.trim();
      if (/^[a-z][a-z0-9_-]*$/i.test(v) && !voices.includes(v)) voices.push(v);
    }
  }
  return voices;
}

/**
 * The live OpenAI voice list for one model. There is no /v1/voices
 * endpoint, but the speech endpoint's own validation error enumerates every
 * voice the requested model accepts — so one deliberately-invalid probe
 * returns the authoritative, model-scoped set. The request is rejected
 * before any synthesis, so it costs no TTS quota. Returns [] whenever the
 * list can't be read (offline, bad key, unparsed error shape); callers fall
 * back to OPENAI_FALLBACK_VOICE_OPTIONS.
 */
export async function fetchOpenAIVoiceOptions(
  apiKey: string,
  model: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
  baseUrl: string = OPENAI_BASE_URL,
): Promise<string[]> {
  try {
    const url = `${normalizeOpenAICompatibleBaseUrl(baseUrl)}/audio/speech`;
    const request = (preferMp3: boolean) =>
      fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          voice: "__phantombot_probe__",
          input: ".",
          ...(preferMp3 ? { response_format: "mp3" } : {}),
        }),
        signal,
      });
    let res = await request(true);
    if (res.ok) return []; // probe voice accepted — can't enumerate; fall back
    let body = (await res.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    if (isUnsupportedSpeechFormatError(body?.error?.message ?? "")) {
      res = await request(false);
      if (res.ok) return [];
      body = (await res.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
    }
    return parseOpenAIVoiceOptions(body?.error?.message ?? "");
  } catch {
    return [];
  }
}

/**
 * Menu sentinel for "none of the above — let me type one". Shared by the CLI
 * picker and the TUI flow so a provider-specific voice name is never locked
 * out by our own list; it cannot collide with a real voice because every
 * published provider voice name is this reserved sentinel.
 */
export const OTHER_VOICE = "__other__";

/**
 * The outcome of proving one (model, voice) pair against a live endpoint.
 * `supported` carries whatever the rejection enumerated, so the caller can
 * show the real choices instead of just the failure.
 */
export type OpenAIVoiceCheck =
  | { ok: true }
  | { ok: false; error: string; supported: string[] };

/**
 * Prove ONE voice works before it is persisted, for the case the free probe
 * cannot cover: an endpoint whose rejection does not enumerate its voices
 * (so `fetchOpenAIVoiceOptions` returned []) or a voice typed by hand. This
 * one synthesises for real — `input` is a single character, the smallest
 * billable request there is — because the only thing that proves a voice is
 * accepted is the endpoint accepting it.
 *
 * A network failure or account-scoped response is NOT reported as a bad
 * voice: reachability, authentication, permission and quota say nothing about
 * whether this model accepts the voice. Only an actual model/voice rejection
 * is `ok: false`.
 */
export async function validateOpenAIVoice(
  apiKey: string,
  model: string,
  voice: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
  baseUrl: string = OPENAI_BASE_URL,
): Promise<OpenAIVoiceCheck> {
  let res: Response;
  try {
    const url = `${normalizeOpenAICompatibleBaseUrl(baseUrl)}/audio/speech`;
    const request = (preferMp3: boolean) =>
      fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          voice,
          input: ".",
          ...(preferMp3 ? { response_format: "mp3" } : {}),
        }),
        signal,
      });
    res = await request(true);
    if (!res.ok) {
      const firstBody = (await res.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      if (isUnsupportedSpeechFormatError(firstBody?.error?.message ?? "")) {
        res = await request(false);
      } else {
        if (
          res.status === 401 || res.status === 403 || res.status === 429 ||
          res.status >= 500
        ) {
          return { ok: true };
        }
        const message = firstBody?.error?.message?.trim();
        return {
          ok: false,
          error: message ? `HTTP ${res.status}: ${message}` : `HTTP ${res.status}`,
          supported: parseOpenAIVoiceOptions(message ?? ""),
        };
      }
    }
  } catch {
    return { ok: true };
  }
  if (res.ok) return { ok: true };
  if (
    res.status === 401 || res.status === 403 || res.status === 429 ||
    res.status >= 500
  ) {
    return { ok: true };
  }
  const body = (await res.json().catch(() => null)) as
    | { error?: { message?: string } }
    | null;
  const message = body?.error?.message?.trim();
  return {
    ok: false,
    error: message ? `HTTP ${res.status}: ${message}` : `HTTP ${res.status}`,
    supported: parseOpenAIVoiceOptions(message ?? ""),
  };
}

/**
 * Extract voice config from an OpenClaw config object. Returns undefined
 * when no voice block is present. Looks at both `tts` (modern openclaw)
 * and `talk` (older variant some OpenClaw deployments had).
 */
export function parseOpenClawVoice(
  openclawJson: unknown,
): { config: VoiceConfig; importedKey?: { var: string; value: string } } | undefined {
  const json = openclawJson as Record<string, unknown> | undefined;
  if (!json) return undefined;

  const tts = json.tts as
    | { provider?: string; elevenlabs?: Record<string, unknown> }
    | undefined;
  const talk = json.talk as
    | { voiceId?: unknown; apiKey?: unknown; modelId?: unknown }
    | undefined;

  // Modern: `tts.elevenlabs.{voiceId, modelId, voiceSettings}`
  if (tts?.provider === "elevenlabs" && tts.elevenlabs) {
    const el = tts.elevenlabs;
    const settings = (el.voiceSettings ?? {}) as Record<string, unknown>;
    const voiceId =
      typeof el.voiceId === "string"
        ? el.voiceId
        : ELEVENLABS_DEFAULTS.voiceId;
    const modelId =
      typeof el.modelId === "string"
        ? el.modelId
        : ELEVENLABS_DEFAULTS.modelId;
    return {
      config: {
        provider: "elevenlabs",
        elevenlabs: {
          voiceId,
          modelId,
          stability:
            typeof settings.stability === "number"
              ? settings.stability
              : ELEVENLABS_DEFAULTS.stability,
          similarityBoost:
            typeof settings.similarityBoost === "number"
              ? settings.similarityBoost
              : ELEVENLABS_DEFAULTS.similarityBoost,
          style:
            typeof settings.style === "number"
              ? settings.style
              : ELEVENLABS_DEFAULTS.style,
        },
      },
    };
  }

  // Older `talk` block: {voiceId, apiKey, modelId?}
  if (talk && (typeof talk.voiceId === "string" || typeof talk.apiKey === "string")) {
    const voiceId =
      typeof talk.voiceId === "string"
        ? talk.voiceId
        : ELEVENLABS_DEFAULTS.voiceId;
    const modelId =
      typeof talk.modelId === "string"
        ? talk.modelId
        : ELEVENLABS_DEFAULTS.modelId;
    const out: ReturnType<typeof parseOpenClawVoice> = {
      config: {
        provider: "elevenlabs",
        elevenlabs: {
          voiceId,
          modelId,
          stability: ELEVENLABS_DEFAULTS.stability,
          similarityBoost: ELEVENLABS_DEFAULTS.similarityBoost,
          style: ELEVENLABS_DEFAULTS.style,
        },
      },
    };
    if (typeof talk.apiKey === "string" && talk.apiKey.length > 0) {
      out.importedKey = {
        var: ENV_KEY_FOR_PROVIDER.elevenlabs,
        value: talk.apiKey,
      };
    }
    return out;
  }

  return undefined;
}
