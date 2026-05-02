/**
 * Tests for the TTS / STT dispatcher and provider implementations.
 * Uses mocked fetch — no network calls.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  sttSupported,
  synthesize,
  transcribe,
  ttsSupported,
} from "../src/lib/audio.ts";
import type { Config } from "../src/config.ts";

const SAVED_ENV = {
  PHANTOMBOT_OPENAI_API_KEY: process.env.PHANTOMBOT_OPENAI_API_KEY,
  PHANTOMBOT_ELEVENLABS_API_KEY: process.env.PHANTOMBOT_ELEVENLABS_API_KEY,
};

beforeEach(() => {
  delete process.env.PHANTOMBOT_OPENAI_API_KEY;
  delete process.env.PHANTOMBOT_ELEVENLABS_API_KEY;
});

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function makeConfig(provider: Config["voice"]["provider"]): Config {
  const base: Omit<Config, "voice"> = {
    defaultPersona: "x",
    turnTimeoutMs: 1,
    personasDir: "/tmp",
    memoryDbPath: "/tmp/m.sqlite",
    configPath: "/tmp/c.toml",
    harnesses: {
      chain: [],
      claude: { bin: "x", model: "y", fallbackModel: "" },
      pi: { bin: "x", maxPayloadBytes: 1 },
    },
    channels: {},
    embeddings: { provider: "none" },
  };
  if (provider === "elevenlabs") {
    return {
      ...base,
      voice: {
        provider: "elevenlabs",
        elevenlabs: {
          voiceId: "v",
          modelId: "m",
          stability: 1,
          similarityBoost: 0.7,
          style: 0.8,
        },
      },
    };
  }
  if (provider === "openai") {
    return {
      ...base,
      voice: {
        provider: "openai",
        openai: { model: "tts-1", voice: "nova", speed: 1 },
      },
    };
  }
  if (provider === "azure_edge") {
    return {
      ...base,
      voice: {
        provider: "azure_edge",
        azure_edge: { voice: "en-US-JennyNeural", rate: "+0%", pitch: "+0Hz" },
      },
    };
  }
  return { ...base, voice: { provider: "none" } };
}

function fakeBytesFetch(bytes: Buffer, status = 200): typeof fetch {
  return (async () =>
    new Response(bytes, {
      status,
      headers: { "content-type": "audio/ogg" },
    })) as unknown as typeof fetch;
}

function fakeJsonFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("ttsSupported / sttSupported", () => {
  test("none → both false", () => {
    expect(ttsSupported(makeConfig("none"))).toBe(false);
    expect(sttSupported(makeConfig("none"))).toBe(false);
  });
  test("azure_edge → tts true, stt false", () => {
    expect(ttsSupported(makeConfig("azure_edge"))).toBe(true);
    expect(sttSupported(makeConfig("azure_edge"))).toBe(false);
  });
  test("openai with key → both true", () => {
    process.env.PHANTOMBOT_OPENAI_API_KEY = "k";
    expect(ttsSupported(makeConfig("openai"))).toBe(true);
    expect(sttSupported(makeConfig("openai"))).toBe(true);
  });
  test("openai without key → both false", () => {
    expect(ttsSupported(makeConfig("openai"))).toBe(false);
    expect(sttSupported(makeConfig("openai"))).toBe(false);
  });
  test("elevenlabs with key → both true", () => {
    process.env.PHANTOMBOT_ELEVENLABS_API_KEY = "k";
    expect(ttsSupported(makeConfig("elevenlabs"))).toBe(true);
    expect(sttSupported(makeConfig("elevenlabs"))).toBe(true);
  });
});

describe("synthesize", () => {
  test("elevenlabs returns ogg buffer on success", async () => {
    process.env.PHANTOMBOT_ELEVENLABS_API_KEY = "k";
    const fakeAudio = Buffer.from([1, 2, 3, 4, 5]);
    const r = await synthesize(
      makeConfig("elevenlabs"),
      "hello",
      fakeBytesFetch(fakeAudio),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.audio.mime).toBe("audio/ogg");
      expect(r.audio.data).toEqual(fakeAudio);
    }
  });

  test("openai returns ogg buffer on success", async () => {
    process.env.PHANTOMBOT_OPENAI_API_KEY = "k";
    const fakeAudio = Buffer.from([7, 8, 9]);
    const r = await synthesize(
      makeConfig("openai"),
      "hello",
      fakeBytesFetch(fakeAudio),
    );
    expect(r.ok).toBe(true);
  });

  test("azure_edge → not implemented error (clear message)", async () => {
    const r = await synthesize(makeConfig("azure_edge"), "hello");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not implemented");
  });

  test("none → error", async () => {
    const r = await synthesize(makeConfig("none"), "hello");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("none");
  });

  test("missing key → clear error", async () => {
    const r = await synthesize(makeConfig("elevenlabs"), "hello");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("ElevenLabs API key");
  });

  test("HTTP 401 → error with status", async () => {
    process.env.PHANTOMBOT_OPENAI_API_KEY = "bad";
    const r = await synthesize(
      makeConfig("openai"),
      "hello",
      fakeBytesFetch(Buffer.from(""), 401),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("HTTP 401");
  });
});

describe("transcribe", () => {
  test("openai whisper returns text", async () => {
    process.env.PHANTOMBOT_OPENAI_API_KEY = "k";
    const r = await transcribe(
      makeConfig("openai"),
      Buffer.from("audio bytes"),
      "audio/ogg",
      fakeJsonFetch({ text: "hello world" }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("hello world");
  });

  test("elevenlabs scribe returns text", async () => {
    process.env.PHANTOMBOT_ELEVENLABS_API_KEY = "k";
    const r = await transcribe(
      makeConfig("elevenlabs"),
      Buffer.from("audio"),
      "audio/ogg",
      fakeJsonFetch({ text: "transcript here" }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("transcript here");
  });

  test("azure_edge → STT not supported", async () => {
    const r = await transcribe(
      makeConfig("azure_edge"),
      Buffer.from(""),
      "audio/ogg",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not supported");
  });

  test("HTTP error returns clear message", async () => {
    process.env.PHANTOMBOT_OPENAI_API_KEY = "bad";
    const r = await transcribe(
      makeConfig("openai"),
      Buffer.from(""),
      "audio/ogg",
      fakeJsonFetch({ error: { message: "bad" } }, 401),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("401");
  });

  test("response without text → error", async () => {
    process.env.PHANTOMBOT_OPENAI_API_KEY = "k";
    const r = await transcribe(
      makeConfig("openai"),
      Buffer.from(""),
      "audio/ogg",
      fakeJsonFetch({}),
    );
    expect(r.ok).toBe(false);
  });
});
