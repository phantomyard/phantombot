/**
 * Tests for the TTS / STT dispatcher and provider implementations.
 * Uses mocked fetch — no network calls.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  sttSupport,
  sttSupported,
  synthesize,
  transcribe,
  ttsSupport,
  ttsSupported,
  voiceApiKey,
} from "../src/lib/audio.ts";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import {
  _resetVaultTrackingForTesting,
  loadVaultIntoEnv,
  openPersonaVault,
  vaultPath,
} from "../src/lib/vault.ts";

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
    harnessIdleTimeoutMs: 1, harnessHardTimeoutMs: 1, harnessStartupTimeoutMs: 1,
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
  if (provider === "openai-compatible") {
    return {
      ...base,
      voice: {
        provider: "openai-compatible",
        openaiCompatible: { baseUrl: "https://api.openai.com/v1", keyEnv: "PHANTOMBOT_OPENAI_API_KEY", sttModel: "whisper-1", ttsModel: "tts-1", voice: "nova", speed: 1 },
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
  test("none → both false", async () => {
    expect(await ttsSupported(makeConfig("none"))).toBe(false);
    expect(await sttSupported(makeConfig("none"))).toBe(false);
  });
  test("azure_edge → both false after removal", async () => {
    expect(await ttsSupported(makeConfig("azure_edge"))).toBe(false);
    expect(await sttSupported(makeConfig("azure_edge"))).toBe(false);
  });
  test("openai with key → both true", async () => {
    process.env.PHANTOMBOT_OPENAI_API_KEY = "k";
    expect(await ttsSupported(makeConfig("openai-compatible"))).toBe(true);
    expect(await sttSupported(makeConfig("openai-compatible"))).toBe(true);
  });
  test("openai without key → both false", async () => {
    expect(await ttsSupported(makeConfig("openai-compatible"))).toBe(false);
    expect(await sttSupported(makeConfig("openai-compatible"))).toBe(false);
  });
  test("elevenlabs with key → both true", async () => {
    process.env.PHANTOMBOT_ELEVENLABS_API_KEY = "k";
    expect(await ttsSupported(makeConfig("elevenlabs"))).toBe(true);
    expect(await sttSupported(makeConfig("elevenlabs"))).toBe(true);
  });
});

describe("ttsSupport / sttSupport (diagnostic variants)", () => {
  test("none → provider_none for both", async () => {
    expect(await ttsSupport(makeConfig("none"))).toEqual({
      ok: false,
      reason: "provider_none",
      provider: "none",
    });
    expect(await sttSupport(makeConfig("none"))).toEqual({
      ok: false,
      reason: "provider_none",
      provider: "none",
    });
  });

  test("azure_edge → provider_removed for both directions", async () => {
    expect(await ttsSupport(makeConfig("azure_edge"))).toEqual({
      ok: false,
      reason: "provider_removed",
      provider: "azure_edge",
    });
    expect(await sttSupport(makeConfig("azure_edge"))).toEqual({
      ok: false,
      reason: "provider_removed",
      provider: "azure_edge",
    });
  });

  test("openai without key → key_missing names env var for both", async () => {
    expect(await ttsSupport(makeConfig("openai-compatible"))).toEqual({
      ok: false,
      reason: "key_missing",
      provider: "openai-compatible",
      envVar: "PHANTOMBOT_OPENAI_API_KEY",
    });
    expect(await sttSupport(makeConfig("openai-compatible"))).toEqual({
      ok: false,
      reason: "key_missing",
      provider: "openai-compatible",
      envVar: "PHANTOMBOT_OPENAI_API_KEY",
    });
  });

  test("openai with key → ok for both", async () => {
    process.env.PHANTOMBOT_OPENAI_API_KEY = "k";
    expect(await ttsSupport(makeConfig("openai-compatible"))).toEqual({ ok: true });
    expect(await sttSupport(makeConfig("openai-compatible"))).toEqual({ ok: true });
  });

  test("elevenlabs without key → key_missing names env var for both", async () => {
    expect(await ttsSupport(makeConfig("elevenlabs"))).toEqual({
      ok: false,
      reason: "key_missing",
      provider: "elevenlabs",
      envVar: "PHANTOMBOT_ELEVENLABS_API_KEY",
    });
    expect(await sttSupport(makeConfig("elevenlabs"))).toEqual({
      ok: false,
      reason: "key_missing",
      provider: "elevenlabs",
      envVar: "PHANTOMBOT_ELEVENLABS_API_KEY",
    });
  });

  test("elevenlabs with key → ok for both", async () => {
    process.env.PHANTOMBOT_ELEVENLABS_API_KEY = "k";
    expect(await ttsSupport(makeConfig("elevenlabs"))).toEqual({ ok: true });
    expect(await sttSupport(makeConfig("elevenlabs"))).toEqual({ ok: true });
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

  test("OpenAI-compatible TTS uses the configured endpoint and TTS model", async () => {
    process.env.PHANTOMBOT_OPENAI_API_KEY = "k";
    const fakeAudio = Buffer.from([7, 8, 9]);
    const config = makeConfig("openai-compatible");
    config.voice.openaiCompatible!.baseUrl = "https://openrouter.ai/api/v1/";
    config.voice.openaiCompatible!.ttsModel = "openai/gpt-4o-mini-tts";
    let seenUrl = "";
    let seenBody: Record<string, unknown> = {};
    const r = await synthesize(
      config,
      "hello",
      (async (url, init) => {
        seenUrl = String(url);
        seenBody = JSON.parse(String(init?.body));
        return new Response(fakeAudio, {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      }) as typeof fetch,
    );
    expect(r.ok).toBe(true);
    expect(seenUrl).toBe("https://openrouter.ai/api/v1/audio/speech");
    expect(seenBody.model).toBe("openai/gpt-4o-mini-tts");
    expect(seenBody.response_format).toBe("mp3");
    if (r.ok) expect(r.audio.mime).toBe("audio/mpeg");
  });

  test("retries a PCM-only model and wraps the raw samples as WAV", async () => {
    process.env.PHANTOMBOT_OPENAI_API_KEY = "k";
    const config = makeConfig("openai-compatible");
    config.voice.openaiCompatible!.baseUrl = "https://openrouter.ai/api/v1";
    config.voice.openaiCompatible!.ttsModel = "google/gemini-3.8-flash-tts";
    config.voice.openaiCompatible!.voice = "Kore";
    const bodies: Array<Record<string, unknown>> = [];
    const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const r = await synthesize(
      config,
      "hello",
      (async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        if (bodies.length === 1) {
          return Response.json(
            { error: { message: 'Gemini TTS only supports response_format="pcm". Got "mp3".' } },
            { status: 400 },
          );
        }
        return new Response(pcm, {
          status: 200,
          headers: { "content-type": "audio/pcm;rate=24000;channels=1" },
        });
      }) as typeof fetch,
    );
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.response_format).toBe("mp3");
    expect(bodies[1]!.response_format).toBeUndefined();
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    expect(r.audio.mime).toBe("audio/wav");
    expect(r.audio.data.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(r.audio.data.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(r.audio.data.readUInt16LE(22)).toBe(1);
    expect(r.audio.data.readUInt32LE(24)).toBe(24_000);
    expect(r.audio.data.subarray(44)).toEqual(pcm);
  });

  test("raw PCM under audio/L16 is byte-swapped into little-endian WAV (RFC 2586)", async () => {
    process.env.PHANTOMBOT_OPENAI_API_KEY = "k";
    const config = makeConfig("openai-compatible");
    config.voice.openaiCompatible!.baseUrl = "https://openrouter.ai/api/v1";
    config.voice.openaiCompatible!.ttsModel = "test/l16-alias-model";
    config.voice.openaiCompatible!.voice = "Kore";
    // Network-byte-order samples: 0x0001 = 1, 0x0100 = 256.
    const pcm = Buffer.from([0x00, 0x01, 0x01, 0x00]);
    const r = await synthesize(
      config,
      "hello",
      (async (_url: string) =>
        new Response(pcm, {
          status: 200,
          headers: { "content-type": "audio/L16;rate=16000;channels=1" },
        })) as typeof fetch,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    expect(r.audio.mime).toBe("audio/wav");
    expect(r.audio.data.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(r.audio.data.readUInt32LE(24)).toBe(16_000);
    expect(r.audio.data.readInt16LE(44)).toBe(1);
    expect(r.audio.data.readInt16LE(46)).toBe(256);
  });

  test("audio/L16 with an odd byte count is rejected instead of wrapped", async () => {
    process.env.PHANTOMBOT_OPENAI_API_KEY = "k";
    const config = makeConfig("openai-compatible");
    config.voice.openaiCompatible!.baseUrl = "https://openrouter.ai/api/v1";
    config.voice.openaiCompatible!.ttsModel = "test/l16-odd-model";
    config.voice.openaiCompatible!.voice = "Kore";
    const r = await synthesize(
      config,
      "hello",
      (async (_url: string) =>
        new Response(Buffer.from([0x00, 0x01, 0x02]), {
          status: 200,
          headers: { "content-type": "audio/L16;rate=16000;channels=1" },
        })) as typeof fetch,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected a synthesis failure");
    expect(r.error).toContain("odd byte count");
  });

  test("audio/x-pcm keeps its little-endian bytes unchanged", async () => {
    process.env.PHANTOMBOT_OPENAI_API_KEY = "k";
    const config = makeConfig("openai-compatible");
    config.voice.openaiCompatible!.baseUrl = "https://openrouter.ai/api/v1";
    config.voice.openaiCompatible!.ttsModel = "test/x-pcm-model";
    config.voice.openaiCompatible!.voice = "Kore";
    const pcm = Buffer.from([0x10, 0x20, 0x30, 0x40]);
    const r = await synthesize(
      config,
      "hello",
      (async (_url: string) =>
        new Response(pcm, {
          status: 200,
          headers: { "content-type": "audio/x-pcm;rate=8000;channels=1" },
        })) as typeof fetch,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    expect(r.audio.data.subarray(44)).toEqual(pcm);
  });

  test("an mp3 rejection is remembered — the next synthesis asks for pcm directly", async () => {
    process.env.PHANTOMBOT_OPENAI_API_KEY = "k";
    const config = makeConfig("openai-compatible");
    config.voice.openaiCompatible!.baseUrl = "https://openrouter.ai/api/v1";
    config.voice.openaiCompatible!.ttsModel = "test/neg-cache-model";
    config.voice.openaiCompatible!.voice = "Kore";
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (body.response_format) {
        return Response.json(
          { error: { message: "mp3 is not supported by this provider" } },
          { status: 400 },
        );
      }
      return new Response("audi", { status: 200 });
    }) as typeof fetch;

    const first = await synthesize(config, "hello", fetchImpl);
    expect(first.ok).toBe(true);
    // Probe + retry on the first call:
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.response_format).toBe("mp3");
    expect(bodies[1]!.response_format).toBeUndefined();

    bodies.length = 0;
    const second = await synthesize(config, "again", fetchImpl);
    expect(second.ok).toBe(true);
    // No wasted mp3 probe the second time around:
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.response_format).toBeUndefined();
  });

  test("the pcm-only cache is scoped per model — another model still probes once", async () => {
    process.env.PHANTOMBOT_OPENAI_API_KEY = "k";
    const config = makeConfig("openai-compatible");
    config.voice.openaiCompatible!.baseUrl = "https://openrouter.ai/api/v1";
    // "test/neg-cache-model" was cached by the test above; a different model
    // on the same baseUrl must NOT inherit that verdict.
    config.voice.openaiCompatible!.ttsModel = "test/neg-cache-other-model";
    config.voice.openaiCompatible!.voice = "Kore";
    const bodies: Array<Record<string, unknown>> = [];
    const r = await synthesize(
      config,
      "hello",
      (async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response("audi", { status: 200 });
      }) as typeof fetch,
    );
    expect(r.ok).toBe(true);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.response_format).toBe("mp3");
  });

  test("a cached pcm-only endpoint still surfaces the provider diagnostic when the direct pcm request fails", async () => {
    process.env.PHANTOMBOT_OPENAI_API_KEY = "k";
    const config = makeConfig("openai-compatible");
    config.voice.openaiCompatible!.baseUrl = "https://openrouter.ai/api/v1";
    config.voice.openaiCompatible!.ttsModel = "test/neg-cache-fail-model";
    config.voice.openaiCompatible!.voice = "Kore";
    let pcmCalls = 0;
    const fetchImpl = (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.response_format) {
        return Response.json(
          { error: { message: "mp3 is not supported by this provider" } },
          { status: 400 },
        );
      }
      pcmCalls += 1;
      if (pcmCalls === 1) return new Response("audi", { status: 200 });
      return Response.json(
        { error: { message: "quota exhausted for this key" } },
        { status: 429 },
      );
    }) as typeof fetch;

    // First call populates the pcm-only cache (mp3 rejected, pcm succeeds).
    const first = await synthesize(config, "hello", fetchImpl);
    expect(first.ok).toBe(true);

    // Second call goes straight to pcm; when THAT fails the provider's
    // diagnostic body must survive into the returned error.
    const second = await synthesize(config, "again", fetchImpl);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("expected a synthesis failure");
    expect(second.error).toContain("HTTP 429");
    expect(second.error).toContain("quota exhausted for this key");
  });

  test("azure_edge → removal error with migration guidance", async () => {
    const r = await synthesize(makeConfig("azure_edge"), "hello");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("was removed");
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
      makeConfig("openai-compatible"),
      "hello",
      fakeBytesFetch(Buffer.from(""), 401),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("HTTP 401");
  });
});

describe("transcribe", () => {
  test("OpenAI-compatible STT uses the configured endpoint and independent model", async () => {
    process.env.PHANTOMBOT_OPENAI_API_KEY = "k";
    const config = makeConfig("openai-compatible");
    config.voice.openaiCompatible!.baseUrl = "https://openrouter.ai/api/v1/";
    config.voice.openaiCompatible!.sttModel = "openai/whisper-large-v3";
    let seenUrl = "";
    let seenModel = "";
    const r = await transcribe(
      config,
      Buffer.from("audio bytes"),
      "audio/ogg",
      (async (url, init) => {
        seenUrl = String(url);
        seenModel = String((init?.body as FormData).get("model"));
        return Response.json({ text: "hello world" });
      }) as typeof fetch,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("hello world");
    expect(seenUrl).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    expect(seenModel).toBe("openai/whisper-large-v3");
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

  test("azure_edge → STT removal error with migration guidance", async () => {
    const r = await transcribe(
      makeConfig("azure_edge"),
      Buffer.from(""),
      "audio/ogg",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("was removed");
  });

  test("HTTP error returns clear message", async () => {
    process.env.PHANTOMBOT_OPENAI_API_KEY = "bad";
    const r = await transcribe(
      makeConfig("openai-compatible"),
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
      makeConfig("openai-compatible"),
      Buffer.from(""),
      "audio/ogg",
      fakeJsonFetch({}),
    );
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-persona key resolution (#452 review)
// ---------------------------------------------------------------------------

describe("voiceApiKey — the key follows the persona, not the environment", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "phantombot-audio-"));
  });
  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  function cfgFor(persona: string): Config {
    return {
      ...makeConfig("openai-compatible"),
      personasDir: workdir,
      defaultPersona: "robbie",
      personaLayer: persona,
    };
  }

  async function seedVault(persona: string, value: string): Promise<void> {
    await mkdir(join(workdir, persona), { recursive: true });
    const v = await openPersonaVault(join(workdir, persona));
    try {
      v.set("PHANTOMBOT_OPENAI_API_KEY", value);
    } finally {
      v.close();
    }
  }

  test("a secondary persona gets ITS OWN key, not the startup persona's", async () => {
    // One daemon serves several personas; only the startup persona's vault was
    // ever injected into process.env. Reading the ambient env here would hand
    // kai robbie's key.
    await seedVault("robbie", "sk-robbie");
    await seedVault("kai", "sk-kai");
    process.env.PHANTOMBOT_OPENAI_API_KEY = "sk-robbie"; // as startup left it

    expect(await voiceApiKey(cfgFor("kai"))).toBe("sk-kai");
    expect(await voiceApiKey(cfgFor("robbie"))).toBe("sk-robbie");
  });

  test("a persona with no key of its own is NOT silently voiced by another's", async () => {
    await seedVault("kai", "sk-kai");
    await mkdir(join(workdir, "lena"), { recursive: true });

    // lena has a persona dir but no vault: no key, so no TTS/STT — reported,
    // not papered over with whatever happened to be ambient.
    expect(await voiceApiKey(cfgFor("lena"))).toBeUndefined();
    expect(await ttsSupport(cfgFor("lena"))).toEqual({
      ok: false,
      reason: "key_missing",
      provider: "openai-compatible",
      envVar: "PHANTOMBOT_OPENAI_API_KEY",
    });
    expect(await ttsSupport(cfgFor("kai"))).toEqual({ ok: true });
  });

  test("resolving one persona's key does not mutate the shared process.env", async () => {
    // Two persona listeners can be mid-turn at once; writing a resolved key
    // into the shared environment is exactly how one ends up on the other's
    // request.
    await seedVault("kai", "sk-kai");
    delete process.env.PHANTOMBOT_OPENAI_API_KEY;

    expect(await voiceApiKey(cfgFor("kai"))).toBe("sk-kai");
    expect(process.env.PHANTOMBOT_OPENAI_API_KEY).toBeUndefined();
  });

  test("falls back to the ambient env for a persona with no vault at all", async () => {
    // Pre-vault hosts, and shell/systemd exports, must keep working.
    process.env.PHANTOMBOT_OPENAI_API_KEY = "sk-ambient";
    expect(await voiceApiKey(cfgFor("never-provisioned"))).toBe("sk-ambient");
  });

  test("but NOT to an env value this process injected from another persona's vault", async () => {
    // The ambient fallback is for HOST-wide values (shell export, systemd
    // Environment=). A key startup injected from the default persona's vault
    // is that persona's alone: falling back to it puts robbie's key on lena's
    // TTS request — and nondeterministically, since reloadVaultForPersona()
    // rewrites these names before every harness spawn.
    delete process.env.PHANTOMBOT_OPENAI_API_KEY;
    await seedVault("robbie", "sk-robbie");
    await mkdir(join(workdir, "lena"), { recursive: true });
    _resetVaultTrackingForTesting();
    try {
      await loadVaultIntoEnv(join(workdir, "robbie"));
      expect(process.env.PHANTOMBOT_OPENAI_API_KEY as string | undefined).toBe(
        "sk-robbie",
      );

      expect(await voiceApiKey(cfgFor("lena"))).toBeUndefined();
      expect(await voiceApiKey(cfgFor("robbie"))).toBe("sk-robbie");
    } finally {
      _resetVaultTrackingForTesting();
    }
  });

  test("a transient vault failure does NOT mute the persona whose key is injected", async () => {
    // The other side of that guard. loadVaultIntoEnv deliberately leaves the
    // injected secrets in place when the SAME persona's vault fails to open
    // (transient blip, not a reason to strip), so refusing the ambient value
    // here would mute robbie over robbie's own key. Simulated by removing the
    // vault file after injection: the read finds nothing, the env still holds
    // his value.
    delete process.env.PHANTOMBOT_OPENAI_API_KEY;
    await seedVault("robbie", "sk-robbie");
    _resetVaultTrackingForTesting();
    try {
      await loadVaultIntoEnv(join(workdir, "robbie"));
      await rm(vaultPath(join(workdir, "robbie")), { force: true });

      expect(await voiceApiKey(cfgFor("robbie"))).toBe("sk-robbie");
      // Still no stand-in for anyone else.
      await mkdir(join(workdir, "lena"), { recursive: true });
      expect(await voiceApiKey(cfgFor("lena"))).toBeUndefined();
    } finally {
      _resetVaultTrackingForTesting();
    }
  });
});
