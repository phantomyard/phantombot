/**
 * Voice — TTS/STT provider configuration.
 *
 * Three providers in v1:
 *   - elevenlabs:  premium, custom voices, paid (key required)
 *   - openai:      built-in voices (fetched live per model — 13 for
 *                  gpt-4o-mini-tts), cheap, paid (key required)
 *   - azure_edge:  Microsoft's free Edge TTS endpoint (no key)
 *   - none:        TTS/STT disabled
 *
 * API keys live in the PERSONA'S ENCRYPTED VAULT (#452), injected into
 * process.env at startup by loadVaultIntoEnv(); voice metadata (provider,
 * voice ID, model, modulation params) lives in that persona's config.toml
 * under [voice].
 */

export type VoiceProvider = "elevenlabs" | "openai" | "azure_edge" | "none";

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

export interface OpenAIVoice {
  /** "tts-1" | "tts-1-hd" | "gpt-4o-mini-tts" */
  model: string;
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
  openai?: OpenAIVoice;
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
 * supports exactly `elevenlabs` (scribe) and `openai` (whisper-1) and answers
 * "STT not supported" for everything else. `[voice] provider` is ONE key
 * driving TWO capabilities, so `azure_edge` — the only provider needing no
 * credential — yields a phantom that speaks but silently rejects every voice
 * note. If a new STT backend is added there, this list moves with it.
 */
export function providerHearsVoice(provider: VoiceProvider): boolean {
  return provider === "openai" || provider === "elevenlabs";
}

export const ENV_KEY_FOR_PROVIDER: Record<
  Exclude<VoiceProvider, "azure_edge" | "none">,
  string
> = {
  elevenlabs: "PHANTOMBOT_ELEVENLABS_API_KEY",
  openai: "PHANTOMBOT_OPENAI_API_KEY",
};

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

export const OPENAI_DEFAULTS: OpenAIVoice = {
  model: "gpt-4o-mini-tts",
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
export async function validateOpenAIKey(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<{ ok: true; modelCount: number } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl("https://api.openai.com/v1/models", {
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
    /"?expected"?\s*:\s*"(.+?)"/.exec(message)?.[1] ??
    /Input should be (.+?)"/.exec(message)?.[1] ??
    "";
  const voices: string[] = [];
  for (const m of scope.matchAll(/'([a-z][a-z0-9_-]*)'/g)) {
    const v = m[1];
    if (v && !voices.includes(v)) voices.push(v);
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
): Promise<string[]> {
  try {
    const res = await fetchImpl("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        voice: "__phantombot_probe__",
        input: ".",
      }),
      signal,
    });
    if (res.ok) return []; // probe voice accepted — can't enumerate; fall back
    const body = (await res.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    return parseOpenAIVoiceOptions(body?.error?.message ?? "");
  } catch {
    return [];
  }
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
