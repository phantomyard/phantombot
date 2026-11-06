/** Modality-specific voice setup, using the same discovery as the TUI. */
import { EngineError } from "./errors.ts";
import {
  ELEVENLABS_DEFAULTS, fetchOpenAIAudioModels, fetchOpenAIVoiceOptions,
  openAIVoiceMenuOptions, validateOpenAIVoice, validateElevenLabsKey, validateOpenAICompatibleKey,
  type VoiceDirectionConfig,
} from "../lib/voice.ts";
import { timeoutSignal } from "../lib/fetchTimeout.ts";

export type VoiceModality = "tts" | "stt";
export interface VoiceCheckInput {
  modality: VoiceModality;
  provider: "openai-compatible" | "elevenlabs";
  apiKey: string;
  baseUrl?: string;
  model?: string;
  voice?: string;
}
export interface VoiceCheck {
  ok: boolean;
  error?: string;
  models: Array<{ id: string; voices: string[] }>;
  voices: string[];
}

export function voiceProviders() {
  return [
    { id: "openai-compatible", label: "OpenAI Compatible", modalities: ["tts", "stt"], needsBaseUrl: true },
    { id: "elevenlabs", label: "ElevenLabs", modalities: ["tts", "stt"], needsBaseUrl: false },
  ];
}

/** @internal */
export function validateVoiceDirection(value: unknown): asserts value is VoiceDirectionConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EngineError("invalid_argument", "voice direction must be an object");
  const v = value as Record<string, unknown>;
  if (typeof v.enabled !== "boolean") throw new EngineError("invalid_argument", "voice.enabled must be boolean");
  // An off-only patch retains the previous provider, model and credential.
  if (!v.enabled && Object.keys(v).length === 1) return;
  if (v.provider !== "openai-compatible" && v.provider !== "elevenlabs") throw new EngineError("invalid_argument", "unsupported voice provider");
  for (const field of ["model", "keyEnv"] as const) {
    if (typeof v[field] !== "string" || !v[field] || (v[field] as string).length > 512) throw new EngineError("invalid_argument", `voice.${field} is required`);
  }
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(v.keyEnv as string)) throw new EngineError("invalid_argument", "invalid voice keyEnv");
  if (v.provider === "openai-compatible") validateVoiceEndpoint(v.baseUrl);
  if (v.voice !== undefined && (typeof v.voice !== "string" || !v.voice || v.voice.length > 512)) throw new EngineError("invalid_argument", "invalid voice name");
  if (v.speed !== undefined && (typeof v.speed !== "number" || v.speed < 0.25 || v.speed > 4)) throw new EngineError("invalid_argument", "voice.speed must be 0.25..4");
}

/** @internal */
export function validateVoiceEndpoint(baseUrl: unknown): asserts baseUrl is string {
  try {
    if (typeof baseUrl !== "string" || baseUrl.length > 2048) throw 0;
    const u = new URL(baseUrl);
    if (!["https:", "http:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw 0;
  } catch { throw new EngineError("invalid_argument", "voice.baseUrl must be an http(s) endpoint without credentials, query or fragment"); }
}

export async function checkVoice(input: VoiceCheckInput): Promise<VoiceCheck> {
  if (input?.modality !== "tts" && input?.modality !== "stt") throw new EngineError("invalid_argument", "modality must be tts or stt");
  if (input.provider !== "openai-compatible" && input.provider !== "elevenlabs") throw new EngineError("invalid_argument", "unsupported voice provider");
  if (typeof input.apiKey !== "string" || input.apiKey.length > 65536) throw new EngineError("invalid_argument", "invalid voice apiKey");
  if (!input.apiKey.trim()) return { ok: false, error: "Enter an API key", models: [], voices: [] };
  const signal = timeoutSignal(20_000);
  const key = input.apiKey.trim();
  if (input.provider === "elevenlabs") {
    const result = await validateElevenLabsKey(key, fetch, signal);
    if (!result.ok) return { ...result, models: [], voices: [] };
    // Scribe and ElevenLabs' default synthesis model are the TUI defaults;
    // custom model ids remain possible, just as in the compatible TUI flow.
    if (input.modality === "stt") return { ok: true, models: [{ id: "scribe_v1", voices: [] }], voices: [] };
    const r = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key }, signal });
    if (!r.ok) return { ok: false, error: `Voice catalogue HTTP ${r.status}`, models: [], voices: [] };
    const body = await r.json() as { voices?: Array<{ voice_id: string }> };
    const voices = (body.voices ?? []).map(v => v.voice_id).filter(v => typeof v === "string");
    return { ok: true, models: [{ id: ELEVENLABS_DEFAULTS.modelId, voices }], voices };
  }
  validateVoiceEndpoint(input.baseUrl);
  const result = await validateOpenAICompatibleKey(key, input.baseUrl, fetch, signal);
  if (!result.ok) return { ...result, models: [], voices: [] };
  const models = await fetchOpenAIAudioModels(key, input.baseUrl, input.modality === "tts" ? "speech" : "transcription", fetch, signal);
  const live = input.modality === "tts" && input.model
    ? models.find(m => m.id === input.model)?.voices ?? await fetchOpenAIVoiceOptions(key, input.model, fetch, signal, input.baseUrl)
    : [];
  if (input.modality === "tts" && input.model && input.voice && !live.includes(input.voice)) {
    const proof = await validateOpenAIVoice(key, input.model, input.voice, fetch, signal, input.baseUrl);
    if (!proof.ok) return {ok: false, error: proof.error, models, voices: proof.supported};
  }
  return { ok: true, models, voices: input.modality === "tts" && input.model ? openAIVoiceMenuOptions(input.model, live) : [] };
}
