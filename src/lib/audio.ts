/**
 * Shared TTS / STT types + the dispatcher that picks the right
 * provider based on Config.voice.provider.
 *
 * Voice transports accept provider audio with its declared MIME type. The
 * OpenAI-compatible path requests MP3 because OpenAI and OpenRouter share it;
 * ElevenLabs continues to return OGG-Opus.
 */

import type { Config } from "../config.ts";
import {
  ENV_KEY_FOR_PROVIDER,
  isUnsupportedSpeechFormatError,
  normalizeOpenAICompatibleBaseUrl,
  type VoiceProvider,
} from "./voice.ts";
import { getPersonaSecret } from "./vaultSecrets.ts";
import { timeoutSignal } from "./fetchTimeout.ts";

/**
 * Hard ceiling for TTS/STT provider calls. Voice replies are short (the
 * channel caps them to a few sentences) and STT runs on brief voice
 * notes, so 60s is already pathological — but bounded, so a wedged
 * provider returns a clean "network" error instead of stalling the
 * chat's serial chain (the #135-class wedge). AbortSignal-backed, so the
 * socket is actually cancelled. Tests inject a fetchImpl that ignores the
 * signal, so this is transparent to them.
 */
const AUDIO_FETCH_TIMEOUT_MS = 60_000;

export interface SynthesizedAudio {
  data: Buffer;
  /** MIME returned by the provider (or implied by the requested format). */
  mime: string;
}

export type SynthesizeResult =
  | { ok: true; audio: SynthesizedAudio }
  | { ok: false; error: string };

export type TranscribeResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/**
 * Tri-state diagnostic for TTS/STT support. Each `{ ok: false }` variant
 * carries exactly the fields its reason needs — `envVar` is required on
 * `key_missing` and absent on the other two — so consumers can render an
 * honest, actionable message without `??` defenses against malformed
 * payloads.
 */
export type AudioSupport =
  | { ok: true }
  | { ok: false; reason: "provider_none"; provider: VoiceProvider }
  | { ok: false; reason: "provider_no_stt"; provider: VoiceProvider }
  | { ok: false; reason: "provider_removed"; provider: VoiceProvider }
  | { ok: false; reason: "key_missing"; provider: VoiceProvider; envVar: string };

/**
 * The API key for this config's voice provider, resolved from the CONFIG'S
 * PERSONA vault (falling back to process.env).
 *
 * Why not `process.env` directly: one daemon serves several personas, and
 * `loadVaultIntoEnv()` only ever injected the STARTUP persona's secrets into
 * the shared environment. Since #452 the TTS/STT key lives in each persona's
 * own vault rather than one central plaintext file, so reading the ambient env
 * here would hand a secondary persona either the default persona's key or
 * nothing at all — mute voice replies with no error anyone can see.
 *
 * `config.personaLayer` is the persona this Config was loaded for, so the key
 * follows whichever listener is asking. Returns undefined for providers that
 * need no key (`none`) and for the retired Azure value.
 */
export async function voiceApiKey(config: Config): Promise<string | undefined> {
  const provider = config.voice.provider;
  if (provider === "elevenlabs") {
    return await getPersonaSecret(config, ENV_KEY_FOR_PROVIDER.elevenlabs);
  }
  if (provider === "openai-compatible") {
    const keyEnv = config.voice.openaiCompatible?.keyEnv;
    return keyEnv ? await getPersonaSecret(config, keyEnv) : undefined;
  }
  return undefined;
}

/**
 * Diagnose whether the configured provider can perform STT.
 *
 * Async because the key comes from the persona's vault, not the ambient
 * environment — see `voiceApiKey`.
 */
export async function sttSupport(config: Config): Promise<AudioSupport> {
  const provider = config.voice.provider;
  if (provider === "none") {
    return { ok: false, reason: "provider_none", provider };
  }
  if (provider === "azure_edge") {
    return { ok: false, reason: "provider_removed", provider };
  }
  const envVar = provider === "openai-compatible"
    ? config.voice.openaiCompatible?.keyEnv ?? ENV_KEY_FOR_PROVIDER[provider]
    : ENV_KEY_FOR_PROVIDER[provider];
  return (await voiceApiKey(config))
    ? { ok: true }
    : { ok: false, reason: "key_missing", provider, envVar };
}

/** Diagnose whether the configured provider can synthesize TTS. Async: see sttSupport. */
export async function ttsSupport(config: Config): Promise<AudioSupport> {
  const provider = config.voice.provider;
  if (provider === "none") {
    return { ok: false, reason: "provider_none", provider };
  }
  if (provider === "azure_edge") {
    return { ok: false, reason: "provider_removed", provider };
  }
  const envVar = provider === "openai-compatible"
    ? config.voice.openaiCompatible?.keyEnv ?? ENV_KEY_FOR_PROVIDER[provider]
    : ENV_KEY_FOR_PROVIDER[provider];
  return (await voiceApiKey(config))
    ? { ok: true }
    : { ok: false, reason: "key_missing", provider, envVar };
}

/** Boolean wrapper around sttSupport — kept for callers that don't need the reason. */
export async function sttSupported(config: Config): Promise<boolean> {
  return (await sttSupport(config)).ok;
}

/** Boolean wrapper around ttsSupport — kept for callers that don't need the reason. */
export async function ttsSupported(config: Config): Promise<boolean> {
  return (await ttsSupport(config)).ok;
}

export async function synthesize(
  config: Config,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SynthesizeResult> {
  const p = config.voice.provider;
  const key = await voiceApiKey(config);
  if (p === "elevenlabs") {
    if (!key) return { ok: false, error: "no ElevenLabs API key in the persona vault" };
    return elevenlabsTts(key, text, config.voice.elevenlabs!, fetchImpl);
  }
  if (p === "openai-compatible") {
    if (!key) return { ok: false, error: "no OpenAI-compatible API key in the persona vault" };
    return openaiCompatibleTts(key, text, config.voice.openaiCompatible!, fetchImpl);
  }
  if (p === "azure_edge") {
    return {
      ok: false,
      error:
        "Azure Edge TTS was removed — run `phantombot voice` and choose ElevenLabs or OpenAI Compatible",
    };
  }
  return { ok: false, error: "TTS provider is 'none'" };
}

export async function transcribe(
  config: Config,
  audio: Buffer,
  mime: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TranscribeResult> {
  const p = config.voice.provider;
  const key = await voiceApiKey(config);
  if (p === "elevenlabs") {
    if (!key)
      return { ok: false, error: "no ElevenLabs API key in the persona vault" };
    return elevenlabsScribe(key, audio, mime, fetchImpl);
  }
  if (p === "openai-compatible") {
    if (!key) return { ok: false, error: "no OpenAI-compatible API key in the persona vault" };
    return openaiCompatibleTranscribe(
      key,
      audio,
      mime,
      config.voice.openaiCompatible!,
      fetchImpl,
    );
  }
  return {
    ok: false,
    error: p === "azure_edge"
      ? "Azure Edge TTS was removed — run `phantombot voice` and choose ElevenLabs or OpenAI Compatible"
      : `STT not supported for provider '${p}' — configure ElevenLabs or OpenAI Compatible to accept voice messages`,
  };
}

// ---------------------------------------------------------------------------
// Provider implementations (local — no SDK deps, raw HTTPS)
// ---------------------------------------------------------------------------

async function elevenlabsTts(
  apiKey: string,
  text: string,
  cfg: NonNullable<Config["voice"]["elevenlabs"]>,
  fetchImpl: typeof fetch,
): Promise<SynthesizeResult> {
  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(cfg.voiceId)}` +
    `?output_format=opus_48000_128`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: cfg.modelId,
        voice_settings: {
          stability: cfg.stability,
          similarity_boost: cfg.similarityBoost,
          style: cfg.style,
        },
      }),
      signal: timeoutSignal(AUDIO_FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, error: `network: ${(e as Error).message}` };
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    return {
      ok: false,
      error: `elevenlabs HTTP ${res.status}: ${errText.slice(0, 200)}`,
    };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { ok: true, audio: { data: buf, mime: "audio/ogg" } };
}

/** MIME types carrying raw PCM samples (not a container format). */
function isRawPcmMime(mime: string): boolean {
  return /^audio\/(?:pcm|l16|x-pcm)$/i.test(mime);
}

/**
 * Endpoints known to reject response_format="mp3", so synthesis never asks
 * them for it again. Keyed baseUrl + model, probed once per process.
 */
const pcmOnlyEndpoints = new Set<string>();

async function openaiCompatibleTts(
  apiKey: string,
  text: string,
  cfg: NonNullable<Config["voice"]["openaiCompatible"]>,
  fetchImpl: typeof fetch,
): Promise<SynthesizeResult> {
  let res: Response;
  let errText = "";
  try {
    const endpointKey = `${normalizeOpenAICompatibleBaseUrl(cfg.baseUrl)}::${cfg.ttsModel}`;
    const skipMp3 = pcmOnlyEndpoints.has(endpointKey);
    const url = `${normalizeOpenAICompatibleBaseUrl(cfg.baseUrl)}/audio/speech`;
    const signal = timeoutSignal(AUDIO_FETCH_TIMEOUT_MS);
    const request = (preferMp3: boolean) =>
      fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: cfg.ttsModel,
          voice: cfg.voice,
          input: text,
          speed: cfg.speed,
          ...(preferMp3 ? { response_format: "mp3" } : {}),
        }),
        signal,
      });
    res = await request(!skipMp3);
    if (!res.ok) {
      // Read the diagnostic body on EVERY failure — including a cached
      // pcm-only endpoint whose direct pcm request fails (quota, auth,
      // provider error) — so the returned error never drops it.
      errText = await res.text().catch(() => "");
      if (!skipMp3 && isUnsupportedSpeechFormatError(errText)) {
        // Remember this (baseUrl, model) as pcm-only for the whole process,
        // so the next synthesis skips the wasted mp3 probe entirely.
        pcmOnlyEndpoints.add(endpointKey);
        res = await request(false);
        errText = res.ok ? "" : await res.text().catch(() => "");
      }
    }
  } catch (e) {
    return { ok: false, error: `network: ${(e as Error).message}` };
  }
  if (!res.ok) {
    return {
      ok: false,
      error: `OpenAI-compatible TTS endpoint/model unavailable (HTTP ${res.status}): ${errText.slice(0, 200)}`,
    };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type")?.trim() || "audio/mpeg";
  const mime = contentType.split(";", 1)[0]?.trim().toLowerCase() || "audio/mpeg";
  if (isRawPcmMime(mime)) {
    if (buf.length % 2 !== 0) {
      return {
        ok: false,
        error: `${mime} payload has an odd byte count (${buf.length}): not whole 16-bit samples`,
      };
    }
    return {
      ok: true,
      audio: {
        data: pcm16leToWav(
          // audio/L16 is RFC 2586 big-endian; audio/pcm and audio/x-pcm are
          // already little-endian. Correct into LE before the WAV header.
          mime === "audio/l16" ? swap16InPlace(buf) : buf,
          parsePositiveContentTypeParam(contentType, "rate", 24_000, 768_000),
          parsePositiveContentTypeParam(contentType, "channels", 1, 32),
        ),
        mime: "audio/wav",
      },
    };
  }
  return { ok: true, audio: { data: buf, mime } };
}

function parsePositiveContentTypeParam(
  contentType: string,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const value = new RegExp(`(?:^|;)\\s*${name}=([0-9]+)`, "i").exec(contentType)?.[1];
  const parsed = value === undefined ? NaN : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum
    ? parsed
    : fallback;
}

/**
 * RFC 2586 `audio/L16` samples are network byte order, so each 16-bit sample
 * must be swapped before the little-endian WAV wrapper. Mutates and returns
 * `buf` (callers pass an owned buffer copied from the network response).
 */
function swap16InPlace(buf: Buffer): Buffer {
  return buf.swap16();
}

/** OpenRouter's PCM speech responses are signed 16-bit little-endian samples. */
function pcm16leToWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function elevenlabsScribe(
  apiKey: string,
  audio: Buffer,
  mime: string,
  fetchImpl: typeof fetch,
): Promise<TranscribeResult> {
  const form = new FormData();
  form.set(
    "file",
    new Blob([audio], { type: mime || "audio/ogg" }),
    "voice.ogg",
  );
  form.set("model_id", "scribe_v1");
  let res: Response;
  try {
    res = await fetchImpl("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: form,
      signal: timeoutSignal(AUDIO_FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, error: `network: ${(e as Error).message}` };
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    return {
      ok: false,
      error: `elevenlabs scribe HTTP ${res.status}: ${errText.slice(0, 200)}`,
    };
  }
  const body = (await res.json()) as { text?: string };
  if (typeof body.text !== "string") {
    return { ok: false, error: "no transcript text in scribe response" };
  }
  return { ok: true, text: body.text };
}

async function openaiCompatibleTranscribe(
  apiKey: string,
  audio: Buffer,
  mime: string,
  cfg: NonNullable<Config["voice"]["openaiCompatible"]>,
  fetchImpl: typeof fetch,
): Promise<TranscribeResult> {
  const form = new FormData();
  form.set(
    "file",
    new Blob([audio], { type: mime || "audio/ogg" }),
    "voice.ogg",
  );
  form.set("model", cfg.sttModel);
  let res: Response;
  try {
    res = await fetchImpl(
      `${normalizeOpenAICompatibleBaseUrl(cfg.baseUrl)}/audio/transcriptions`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
        signal: timeoutSignal(AUDIO_FETCH_TIMEOUT_MS),
      },
    );
  } catch (e) {
    return { ok: false, error: `network: ${(e as Error).message}` };
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    return {
      ok: false,
      error: `OpenAI-compatible STT endpoint/model unavailable (HTTP ${res.status}): ${errText.slice(0, 200)}`,
    };
  }
  const body = (await res.json()) as { text?: string };
  if (typeof body.text !== "string") {
    return { ok: false, error: "no transcript text in whisper response" };
  }
  return { ok: true, text: body.text };
}
