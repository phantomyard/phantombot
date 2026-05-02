/**
 * Shared TTS / STT types + the dispatcher that picks the right
 * provider based on Config.voice.provider.
 *
 * Telegram needs OGG-Opus for sendVoice, so every provider returns
 * audio in that container (or a buffer Telegram can accept as-is).
 */

import type { Config } from "../config.ts";

export interface SynthesizedAudio {
  data: Buffer;
  /** Telegram-compatible MIME for sendVoice. We aim for audio/ogg. */
  mime: string;
}

export type SynthesizeResult =
  | { ok: true; audio: SynthesizedAudio }
  | { ok: false; error: string };

export type TranscribeResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/**
 * True if the configured provider can do STT (i.e. transcribe Telegram
 * voice messages). Azure Edge has no STT counterpart.
 */
export function sttSupported(config: Config): boolean {
  const p = config.voice.provider;
  if (p === "openai" || p === "elevenlabs") {
    const envVar =
      p === "openai"
        ? "PHANTOMBOT_OPENAI_API_KEY"
        : "PHANTOMBOT_ELEVENLABS_API_KEY";
    return Boolean(process.env[envVar]);
  }
  return false;
}

/** True if the configured provider can synthesize TTS. */
export function ttsSupported(config: Config): boolean {
  const p = config.voice.provider;
  if (p === "none") return false;
  if (p === "azure_edge") return true; // free, no key
  const envVar =
    p === "openai"
      ? "PHANTOMBOT_OPENAI_API_KEY"
      : "PHANTOMBOT_ELEVENLABS_API_KEY";
  return Boolean(process.env[envVar]);
}

export async function synthesize(
  config: Config,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SynthesizeResult> {
  const p = config.voice.provider;
  if (p === "elevenlabs") {
    const key = process.env.PHANTOMBOT_ELEVENLABS_API_KEY;
    if (!key) return { ok: false, error: "no ElevenLabs API key in env" };
    return elevenlabsTts(key, text, config.voice.elevenlabs!, fetchImpl);
  }
  if (p === "openai") {
    const key = process.env.PHANTOMBOT_OPENAI_API_KEY;
    if (!key) return { ok: false, error: "no OpenAI API key in env" };
    return openaiTts(key, text, config.voice.openai!, fetchImpl);
  }
  if (p === "azure_edge") {
    return {
      ok: false,
      error:
        "Azure Edge TTS not implemented yet — configure ElevenLabs or OpenAI for voice replies",
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
  if (p === "elevenlabs") {
    const key = process.env.PHANTOMBOT_ELEVENLABS_API_KEY;
    if (!key)
      return { ok: false, error: "no ElevenLabs API key in env" };
    return elevenlabsScribe(key, audio, mime, fetchImpl);
  }
  if (p === "openai") {
    const key = process.env.PHANTOMBOT_OPENAI_API_KEY;
    if (!key) return { ok: false, error: "no OpenAI API key in env" };
    return openaiWhisper(key, audio, mime, fetchImpl);
  }
  return {
    ok: false,
    error: `STT not supported for provider '${p}' — configure ElevenLabs or OpenAI to accept voice messages`,
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

async function openaiTts(
  apiKey: string,
  text: string,
  cfg: NonNullable<Config["voice"]["openai"]>,
  fetchImpl: typeof fetch,
): Promise<SynthesizeResult> {
  let res: Response;
  try {
    res = await fetchImpl("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        voice: cfg.voice,
        input: text,
        speed: cfg.speed,
        response_format: "opus",
      }),
    });
  } catch (e) {
    return { ok: false, error: `network: ${(e as Error).message}` };
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    return {
      ok: false,
      error: `openai HTTP ${res.status}: ${errText.slice(0, 200)}`,
    };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { ok: true, audio: { data: buf, mime: "audio/ogg" } };
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

async function openaiWhisper(
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
  form.set("model", "whisper-1");
  let res: Response;
  try {
    res = await fetchImpl(
      "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
      },
    );
  } catch (e) {
    return { ok: false, error: `network: ${(e as Error).message}` };
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    return {
      ok: false,
      error: `whisper HTTP ${res.status}: ${errText.slice(0, 200)}`,
    };
  }
  const body = (await res.json()) as { text?: string };
  if (typeof body.text !== "string") {
    return { ok: false, error: "no transcript text in whisper response" };
  }
  return { ok: true, text: body.text };
}
