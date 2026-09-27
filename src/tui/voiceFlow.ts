/**
 * The rest of `phantombot voice`, as SCREEN questions.
 *
 * The Voice screen picked a provider and saved it — and nothing else. For
 * `elevenlabs` and `openai-compatible` that wrote a provider with no key and no voice: a
 * phantom that looks configured and is mute on the first turn. This module asks
 * the questions the CLI asks (key, voice, model defaults) and hands back
 * exactly what `applyVoiceConfig` takes, so the two write the same block.
 *
 * Every question is injected, so cancelling is a real answer at any step:
 * `undefined` anywhere means nothing is written.
 */

import {
  ELEVENLABS_DEFAULTS,
  OPENAI_COMPATIBLE_DEFAULTS,
  OPENAI_BASE_URL,
  OPENROUTER_BASE_URL,
  normalizeOpenAICompatibleBaseUrl,
  openAICompatibleKeyEnv,
  openAICompatibleProviderLabel,
  type VoiceConfig,
  type VoiceProvider,
} from "../lib/voice.ts";
import type { ChannelsQuestions } from "./channelsFlow.ts";

export interface VoiceFlowDeps {
  /** The persona's current voice block, so nothing already answered is asked again. */
  existing?: VoiceConfig;
  /** Matching credential from this persona only. The value is never rendered. */
  findCredential(
    provider: VoiceProvider,
    baseUrl?: string,
  ): Promise<{ name: string; value: string; needsWrite: boolean } | undefined>;
  /** One live call before the key is stored. */
  validateKey(
    provider: VoiceProvider,
    key: string,
    baseUrl?: string,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface VoiceFlowResult {
  voice: VoiceConfig;
  /** Undefined leaves the stored key alone — it is NOT "clear the key". */
  apiKey?: string;
  /** Line for the notice bar, describing what was chosen. */
  summary: string;
}

/** A key the provider itself refused — stated, never written. */
export interface VoiceFlowRejected {
  rejected: string;
}

/**
 * Ask everything the provider needs. `undefined` means the user backed out;
 * `{ rejected }` means a key failed its live check and nothing was written.
 */
export async function configureVoice(
  persona: string,
  provider: VoiceProvider,
  q: ChannelsQuestions,
  deps: VoiceFlowDeps,
): Promise<VoiceFlowResult | VoiceFlowRejected | undefined> {
  if (provider === "none") {
    return { voice: { provider: "none" }, summary: "voice off" };
  }

  if (provider === "azure_edge") {
    return { rejected: "Azure Edge TTS was removed; choose another provider" };
  }

  if (provider === "openai-compatible") {
    return openAICompatibleFlow(persona, q, deps);
  }

  // elevenlabs and openai both need a key. An existing one is offered back
  // rather than re-asked: retyping a working key to change a voice is the
  // fastest way to end up with a typo where a working credential was.
  const key = await askKey(persona, provider, q, deps);
  if (key === undefined) return undefined;
  if (typeof key === "object") return key;
  const apiKey = key;

  const cur = deps.existing?.elevenlabs ?? ELEVENLABS_DEFAULTS;
  const voiceId = await q.value({
    title: `ElevenLabs voice ID for ${persona}`,
    hint: "from elevenlabs.io → Voices; empty keeps the current one",
    initial: cur.voiceId,
  });
  if (voiceId === undefined) return undefined;
  return {
    voice: {
      provider: "elevenlabs",
      elevenlabs: {
        voiceId: voiceId || cur.voiceId,
        modelId: cur.modelId,
        stability: cur.stability,
        similarityBoost: cur.similarityBoost,
        style: cur.style,
      },
    },
    apiKey: apiKey || undefined,
    summary: `elevenlabs · ${voiceId || cur.voiceId}`,
  };
}

/**
 * The key question. Returns "" to mean "keep the stored one", a string to store,
 * and undefined to cancel the whole flow.
 */
async function askKey(
  persona: string,
  provider: VoiceProvider,
  q: ChannelsQuestions,
  deps: VoiceFlowDeps,
): Promise<string | VoiceFlowRejected | undefined> {
  const label = "ElevenLabs";
  const stored = await deps.findCredential(provider);
  if (stored) {
    const action = await q.choose({
      title: `${label} key for ${persona}`,
      options: [
        { value: "keep", label: "Keep the stored key" },
        { value: "replace", label: "Replace it" },
      ],
    });
    if (!action) return undefined;
    if (action === "keep") return stored.needsWrite ? stored.value : "";
  }
  const typed = await q.value({
    title: `${label} API key for ${persona}`,
    hint: "elevenlabs.io/app/settings/api-keys — checked before it is stored",
    masked: true,
  });
  if (!typed) return undefined;
  // Validated FIRST: a key that fails the live call never reaches the vault,
  // so "voice configured" cannot mean "mute on the first turn".
  const r = await deps.validateKey(provider, typed);
  if (!r.ok) return { rejected: r.error };
  return typed;
}

async function openAICompatibleFlow(
  persona: string,
  q: ChannelsQuestions,
  deps: VoiceFlowDeps,
): Promise<VoiceFlowResult | VoiceFlowRejected | undefined> {
  const cur = deps.existing?.openaiCompatible ?? OPENAI_COMPATIBLE_DEFAULTS;
  const baseAnswer = await q.value({
    title: "OpenAI Compatible base URL (include /v1)",
    hint: `${OPENAI_BASE_URL} · ${OPENROUTER_BASE_URL}`,
    initial: cur.baseUrl,
  });
  if (baseAnswer === undefined) return undefined;
  if (!baseAnswer.trim()) return { rejected: "base URL is required" };
  const baseUrl = normalizeOpenAICompatibleBaseUrl(baseAnswer);
  const stored = await deps.findCredential("openai-compatible", baseUrl);
  let key = stored?.value;
  let keyEnv = stored?.name ?? openAICompatibleKeyEnv(baseUrl);
  let needsWrite = stored?.needsWrite ?? false;
  if (stored) {
    const use = await q.confirm({
      title: `Use stored key for ${openAICompatibleProviderLabel(baseUrl)}?`,
      consequence: {
        summary: "reuses this persona's stored credential",
        detail: "The secret value is not displayed or copied from another persona.",
        longRunning: false,
        restarts: false,
      },
    });
    if (use === undefined) return undefined;
    if (!use) key = undefined;
  }
  if (!key) {
    const typed = await q.value({
      title: `${openAICompatibleProviderLabel(baseUrl)} API key for ${persona}`,
      hint: "checked against the endpoint before it is stored",
      masked: true,
    });
    if (typed === undefined) return undefined;
    if (!typed.trim()) return { rejected: "key is required" };
    key = typed.trim();
    keyEnv = openAICompatibleKeyEnv(baseUrl);
    needsWrite = true;
  }
  const validated = await deps.validateKey("openai-compatible", key, baseUrl);
  if (!validated.ok) return { rejected: validated.error };

  const sttModel = await q.value({
    title: "Speech-to-text model",
    initial: cur.sttModel,
  });
  if (sttModel === undefined) return undefined;
  if (!sttModel.trim()) return { rejected: "STT model is required" };
  const ttsModel = await q.value({
    title: "Text-to-speech model",
    initial: cur.ttsModel,
  });
  if (ttsModel === undefined) return undefined;
  if (!ttsModel.trim()) return { rejected: "TTS model is required" };
  const voice = await q.value({
    title: "Voice",
    initial: cur.voice,
  });
  if (voice === undefined) return undefined;
  if (!voice.trim()) return { rejected: "voice is required" };

  return {
    voice: {
      provider: "openai-compatible",
      openaiCompatible: {
        baseUrl,
        keyEnv,
        sttModel: sttModel.trim(),
        ttsModel: ttsModel.trim(),
        voice: voice.trim(),
        speed: cur.speed,
      },
    },
    apiKey: needsWrite ? key : undefined,
    summary: `openai-compatible · ${voice.trim()}`,
  };
}
