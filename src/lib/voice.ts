/**
 * Voice — TTS/STT provider configuration.
 *
 * Three providers in v1:
 *   - elevenlabs:  premium, custom voices, paid (key required)
 *   - openai:      6 built-in voices, cheap, paid (key required)
 *   - azure_edge:  Microsoft's free Edge TTS endpoint (no key)
 *   - none:        TTS/STT disabled
 *
 * API keys live in $XDG_CONFIG_HOME/phantombot/.env; voice metadata
 * (provider, voice ID, model, modulation params) lives in config.toml
 * under [voice]. The systemd unit reads the .env file via
 * EnvironmentFile= so the keys are available at runtime.
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
  /** "tts-1" | "tts-1-hd" */
  model: string;
  /** "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer" */
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

export interface VoiceConfig {
  provider: VoiceProvider;
  elevenlabs?: ElevenLabsVoice;
  openai?: OpenAIVoice;
  azure_edge?: AzureEdgeVoice;
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

export const OPENAI_VOICE_OPTIONS = [
  "alloy",
  "echo",
  "fable",
  "onyx",
  "nova",
  "shimmer",
] as const;

export const OPENAI_DEFAULTS: OpenAIVoice = {
  model: "tts-1",
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
): Promise<{ ok: true; voiceCount: number } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl(
      "https://api.elevenlabs.io/v1/voices?show_legacy=false",
      { headers: { "xi-api-key": apiKey } },
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
): Promise<{ ok: true; modelCount: number } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl("https://api.openai.com/v1/models", {
      headers: { authorization: `Bearer ${apiKey}` },
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
