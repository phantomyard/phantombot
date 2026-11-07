/**
 * Which of Pi's providers can fill a specialized model slot (voice,
 * embeddings), and how.
 *
 * Every entry here is a provider from `PI_PROVIDER_CATALOG` that really
 * offers that model type on an OpenAI-shaped API, so it runs on the existing
 * `openai-compatible` transport with a FIXED base URL: the caller picks the
 * provider, never the host a key is sent to. A provider that offers no model
 * of a type is simply absent from that type's list (model type filtering).
 *
 * `models` is the fallback list shown when the provider's live `/models`
 * carries no type metadata (OpenAI, Mistral, Groq list ids only). Live lists
 * win whenever they are non-empty.
 *
 * Configs never store a preset id: `persona.configure` writes
 * `provider = "openai-compatible"` plus the preset's base URL, so the runtime,
 * the TUI and older engines read it unchanged.
 */

export type VoiceModalityId = "tts" | "stt";

export interface VoicePreset {
  id: string;
  label: string;
  baseUrl: string;
  /** Fallback model ids per modality; a modality absent here is not offered. */
  models: Partial<Record<VoiceModalityId, readonly string[]>>;
}

export interface EmbeddingsPreset {
  id: string;
  label: string;
  baseUrl: string;
  models: readonly string[];
}

export const VOICE_PRESETS: readonly VoicePreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: {
      tts: ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"],
      stt: ["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"],
    },
  },
  // OpenRouter tags its audio models (output_modalities=speech|transcription),
  // so the live list is the catalogue.
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", models: { tts: [], stt: [] } },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    models: { stt: ["whisper-large-v3-turbo", "whisper-large-v3"] },
  },
  {
    id: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    models: { stt: ["voxtral-mini-latest"] },
  },
];

export const EMBEDDINGS_PRESETS: readonly EmbeddingsPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: ["text-embedding-3-small", "text-embedding-3-large"],
  },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", models: [] },
  { id: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", models: ["mistral-embed"] },
  { id: "together", label: "Together AI", baseUrl: "https://api.together.xyz/v1", models: [] },
  { id: "fireworks", label: "Fireworks", baseUrl: "https://api.fireworks.ai/inference/v1", models: [] },
];

export function voicePreset(id: unknown): VoicePreset | undefined {
  return VOICE_PRESETS.find((p) => p.id === id);
}

export function embeddingsPreset(id: unknown): EmbeddingsPreset | undefined {
  return EMBEDDINGS_PRESETS.find((p) => p.id === id);
}

const trimUrl = (u: string) => u.trim().replace(/\/+$/, "");

/** The preset a stored openai-compatible base URL belongs to, if any. */
export function voicePresetForBaseUrl(baseUrl: string | undefined): VoicePreset | undefined {
  if (!baseUrl) return undefined;
  return VOICE_PRESETS.find((p) => p.baseUrl === trimUrl(baseUrl));
}
