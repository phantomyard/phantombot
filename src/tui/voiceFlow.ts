/**
 * The rest of `phantombot voice`, as SCREEN questions.
 *
 * The Voice screen picked a provider and saved it — and nothing else. For
 * `elevenlabs` and `openai` that wrote a provider with no key and no voice: a
 * phantom that looks configured and is mute on the first turn. This module asks
 * the questions the CLI asks (key, voice, model defaults) and hands back
 * exactly what `applyVoiceConfig` takes, so the two write the same block.
 *
 * Every question is injected, so cancelling is a real answer at any step:
 * `undefined` anywhere means nothing is written.
 */

import {
  AZURE_EDGE_DEFAULTS,
  AZURE_EDGE_VOICE_OPTIONS,
  ELEVENLABS_DEFAULTS,
  OPENAI_DEFAULTS,
  OPENAI_VOICE_OPTIONS,
  type VoiceConfig,
  type VoiceProvider,
} from "../lib/voice.ts";
import type { ChannelsQuestions } from "./channelsFlow.ts";

export interface VoiceFlowDeps {
  /** The persona's current voice block, so nothing already answered is asked again. */
  existing?: VoiceConfig;
  /** True when the provider's key is ALREADY in this persona's vault/env. */
  hasKey(provider: VoiceProvider): boolean;
  /** One live call before the key is stored. */
  validateKey(
    provider: VoiceProvider,
    key: string,
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
    const cur = deps.existing?.azure_edge ?? AZURE_EDGE_DEFAULTS;
    const voice = await q.choose({
      title: `Voice for ${persona} (Azure Edge — free, no key)`,
      options: AZURE_EDGE_VOICE_OPTIONS.map((v) => ({
        value: v,
        label: v,
        hint: v === cur.voice ? "current" : undefined,
      })),
    });
    if (!voice) return undefined;
    return {
      voice: {
        provider: "azure_edge",
        azure_edge: { voice, rate: cur.rate, pitch: cur.pitch },
      },
      summary: `azure_edge · ${voice}`,
    };
  }

  // elevenlabs and openai both need a key. An existing one is offered back
  // rather than re-asked: retyping a working key to change a voice is the
  // fastest way to end up with a typo where a working credential was.
  const key = await askKey(persona, provider, q, deps);
  if (key === undefined) return undefined;
  if (typeof key === "object") return key;
  const apiKey = key;

  if (provider === "openai") {
    const cur = deps.existing?.openai ?? OPENAI_DEFAULTS;
    const voice = await q.choose({
      title: `Voice for ${persona}`,
      options: OPENAI_VOICE_OPTIONS.map((v) => ({
        value: v,
        label: v,
        hint: v === cur.voice ? "current" : undefined,
      })),
    });
    if (!voice) return undefined;
    return {
      voice: {
        provider: "openai",
        openai: { model: cur.model, voice, speed: cur.speed },
      },
      apiKey: apiKey || undefined,
      summary: `openai · ${voice}`,
    };
  }

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
  const label = provider === "openai" ? "OpenAI" : "ElevenLabs";
  if (deps.hasKey(provider)) {
    const action = await q.choose({
      title: `${label} key for ${persona}`,
      options: [
        { value: "keep", label: "Keep the stored key" },
        { value: "replace", label: "Replace it" },
      ],
    });
    if (!action) return undefined;
    if (action === "keep") return "";
  }
  const typed = await q.value({
    title: `${label} API key for ${persona}`,
    hint:
      provider === "openai"
        ? "platform.openai.com/api-keys — checked before it is stored"
        : "elevenlabs.io/app/settings/api-keys — checked before it is stored",
    masked: true,
  });
  if (!typed) return undefined;
  // Validated FIRST: a key that fails the live call never reaches the vault,
  // so "voice configured" cannot mean "mute on the first turn".
  const r = await deps.validateKey(provider, typed);
  if (!r.ok) return { rejected: r.error };
  return typed;
}
