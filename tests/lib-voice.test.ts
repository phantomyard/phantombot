import { describe, expect, test } from "bun:test";
import {
  fetchOpenAIAudioModelOptions,
  fetchOpenAIVoiceOptions,
  validateOpenAIVoice,
  fallbackVoiceOptions,
  openAIVoiceMenuOptions,
  parseOpenAIVoiceOptions,
  parseOpenClawVoice,
  validateElevenLabsKey,
  validateOpenAIKey,
} from "../src/lib/voice.ts";

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("validateElevenLabsKey", () => {
  test("ok=true returns voice count", async () => {
    const r = await validateElevenLabsKey(
      "k",
      fakeFetch({ voices: [{}, {}, {}] }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.voiceCount).toBe(3);
  });

  test("ok=false on 401", async () => {
    const r = await validateElevenLabsKey("badkey", fakeFetch({}, 401));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("401");
  });

  test("ok=false on network error", async () => {
    const failing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await validateElevenLabsKey("k", failing);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("network");
  });
});

describe("validateOpenAIKey", () => {
  test("ok=true returns model count", async () => {
    const r = await validateOpenAIKey(
      "k",
      fakeFetch({ data: [{}, {}] }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.modelCount).toBe(2);
  });

  test("ok=false on 401", async () => {
    const r = await validateOpenAIKey("k", fakeFetch({}, 401));
    expect(r.ok).toBe(false);
  });
});

describe("parseOpenAIVoiceOptions", () => {
  test("parses the gpt-4o-mini-tts error shape", () => {
    const msg =
      "Invalid value: 'not-a-voice'. Supported values are: 'alloy', 'echo', " +
      "'fable', 'onyx', 'nova', 'shimmer', 'coral', 'verse', 'ballad', " +
      "'ash', 'sage', 'marin', and 'cedar'.";
    expect(parseOpenAIVoiceOptions(msg)).toEqual([
      "alloy", "echo", "fable", "onyx", "nova", "shimmer",
      "coral", "verse", "ballad", "ash", "sage", "marin", "cedar",
    ]);
  });

  test("parses the tts-1 pydantic 'expected' shape", () => {
    const msg =
      `[{"type": "enum", "loc": ("body", "voice"), "msg": "Input should be ` +
      `'nova', 'shimmer', 'echo', 'onyx', 'fable', 'alloy', 'ash', 'sage' ` +
      `or 'coral'", "ctx": {"expected": "'nova', 'shimmer', 'echo', 'onyx', ` +
      `'fable', 'alloy', 'ash', 'sage' or 'coral'"}}]`;
    expect(parseOpenAIVoiceOptions(msg)).toEqual([
      "nova", "shimmer", "echo", "onyx", "fable", "alloy",
      "ash", "sage", "coral",
    ]);
  });

  test("parses OpenRouter's unquoted supported-voices shape", () => {
    const msg =
      'Unknown voice "x". Supported voices: aura-2-thalia-en, aura-2-beatrix-nl, aura-2-zeus-en.';
    expect(parseOpenAIVoiceOptions(msg)).toEqual([
      "aura-2-thalia-en",
      "aura-2-beatrix-nl",
      "aura-2-zeus-en",
    ]);
  });

  test("returns [] on unrelated errors", () => {
    expect(parseOpenAIVoiceOptions("401 Unauthorized")).toEqual([]);
    expect(parseOpenAIVoiceOptions("")).toEqual([]);
  });
});

describe("fetchOpenAIAudioModelOptions", () => {
  test("queries and returns only the requested annotated audio models", async () => {
    let seen = "";
    const fakeFetch = (async (url: URL) => {
      seen = String(url);
      return Response.json({
        data: [
          {
            id: "deepgram/aura-2",
            architecture: { output_modalities: ["speech"] },
          },
          {
            id: "openai/whisper-1",
            architecture: { output_modalities: ["transcription"] },
          },
        ],
      });
    }) as unknown as typeof fetch;
    expect(
      await fetchOpenAIAudioModelOptions(
        "k",
        "https://openrouter.ai/api/v1/",
        "speech",
        fakeFetch,
      ),
    ).toEqual(["deepgram/aura-2"]);
    expect(seen).toBe(
      "https://openrouter.ai/api/v1/models?output_modalities=speech",
    );
  });

  test("returns no menu when an endpoint ignores the modality filter", async () => {
    const fakeFetch = (async () =>
      Response.json({ data: [{ id: "gpt-4.1" }] })) as unknown as typeof fetch;
    expect(
      await fetchOpenAIAudioModelOptions(
        "k",
        "https://api.openai.com/v1",
        "speech",
        fakeFetch,
      ),
    ).toEqual([]);
  });
});

describe("fetchOpenAIVoiceOptions", () => {
  test("enumerates voices from the speech-endpoint validation error", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          error: {
            message:
              "Invalid value: '__phantombot_probe__'. Supported values are: " +
              "'nova', 'shimmer', 'echo', 'onyx', 'fable', 'alloy', 'ash', " +
              "'sage' or 'coral'.",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const r = await fetchOpenAIVoiceOptions("k", "tts-1", fakeFetch);
    expect(r).toEqual([
      "nova", "shimmer", "echo", "onyx", "fable", "alloy",
      "ash", "sage", "coral",
    ]);
    const body = JSON.parse(String(captured?.init.body)) as Record<
      string,
      string
    >;
    expect(captured?.url).toContain("/v1/audio/speech");
    expect(body.voice).toBe("__phantombot_probe__");
  });

  test("returns [] on 401", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: { message: "401" } }), {
        status: 401,
      })) as unknown as typeof fetch;
    expect(await fetchOpenAIVoiceOptions("bad", "tts-1", fakeFetch)).toEqual(
      [],
    );
  });

  test("returns [] on network error", async () => {
    const failing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await fetchOpenAIVoiceOptions("k", "tts-1", failing)).toEqual([]);
  });
});

describe("parseOpenClawVoice", () => {
  test("modern tts.elevenlabs layout", () => {
    const r = parseOpenClawVoice({
      tts: {
        provider: "elevenlabs",
        elevenlabs: {
          voiceId: "voice_123",
          modelId: "eleven_v3",
          voiceSettings: {
            stability: 0.5,
            similarityBoost: 0.6,
            style: 0.7,
          },
        },
      },
    });
    expect(r).toBeDefined();
    expect(r?.config.provider).toBe("elevenlabs");
    expect(r?.config.elevenlabs?.voiceId).toBe("voice_123");
    expect(r?.config.elevenlabs?.modelId).toBe("eleven_v3");
    expect(r?.config.elevenlabs?.stability).toBe(0.5);
    expect(r?.importedKey).toBeUndefined();
  });

  test("older talk block — extracts voiceId + apiKey", () => {
    const r = parseOpenClawVoice({
      talk: {
        voiceId: "onwK4e9ZLuTAKqWW03F9",
        apiKey: "sk_secret",
      },
    });
    expect(r?.config.provider).toBe("elevenlabs");
    expect(r?.config.elevenlabs?.voiceId).toBe("onwK4e9ZLuTAKqWW03F9");
    expect(r?.importedKey?.var).toBe("PHANTOMBOT_ELEVENLABS_API_KEY");
    expect(r?.importedKey?.value).toBe("sk_secret");
  });

  test("returns undefined when no voice block is present", () => {
    expect(parseOpenClawVoice({})).toBeUndefined();
    expect(parseOpenClawVoice({ tts: {} })).toBeUndefined();
    expect(parseOpenClawVoice({ talk: {} })).toBeUndefined();
  });
});

describe("fallbackVoiceOptions / openAIVoiceMenuOptions", () => {
  test("legacy models exclude the gpt-4o-mini-tts-only voices", () => {
    for (const model of ["tts-1", "tts-1-hd"]) {
      const options = fallbackVoiceOptions(model);
      expect(options).toHaveLength(9);
      for (const gpt4oOnly of ["ballad", "cedar", "marin", "verse"]) {
        expect(options).not.toContain(gpt4oOnly);
      }
    }
  });

  test("gpt-4o-mini-tts and unknown models get the full set", () => {
    expect(fallbackVoiceOptions("gpt-4o-mini-tts")).toHaveLength(13);
    expect(fallbackVoiceOptions("some-future-model")).toHaveLength(13);
  });

  test("the menu prefers the live list and sorts it", () => {
    expect(openAIVoiceMenuOptions("tts-1", ["shimmer", "alloy"])).toEqual([
      "alloy",
      "shimmer",
    ]);
  });

  test("the menu falls back to the MODEL-SCOPED list (regression for the CLI path)", () => {
    // Kai, PR #570 review: the CLI offered all 13 voices BEFORE the model
    // choice, so ballad + tts-1 could be persisted even with a valid key.
    const options = openAIVoiceMenuOptions("tts-1", []);
    expect(options).toHaveLength(9);
    expect(options).not.toContain("ballad");
  });
});

describe("validateOpenAIVoice", () => {
  test("accepts a voice the endpoint synthesises, sending one character", async () => {
    let seenUrl = "";
    let seenBody: Record<string, unknown> = {};
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init.body));
      return new Response("audio", { status: 200 });
    }) as unknown as typeof fetch;

    expect(
      await validateOpenAIVoice(
        "k",
        "tts-1",
        "shimmer",
        fakeFetch,
        undefined,
        "https://openrouter.ai/api/v1/",
      ),
    ).toEqual({ ok: true });
    // The chosen voice itself is what gets proven — probing with a sentinel
    // would say nothing about it. Input stays one character so proving a
    // voice is the cheapest billable call there is.
    expect(seenUrl).toBe("https://openrouter.ai/api/v1/audio/speech");
    expect(seenBody).toEqual({
      model: "tts-1",
      voice: "shimmer",
      input: ".",
      response_format: "mp3",
    });
  });

  test("reports a rejection and the voices the model does accept", async () => {
    const fakeFetch = (async () =>
      Response.json(
        {
          error: {
            message:
              "Invalid value: 'ballad'. Supported values are: 'alloy', 'echo' and 'nova'.",
          },
        },
        { status: 400 },
      )) as unknown as typeof fetch;

    const r = await validateOpenAIVoice("k", "tts-1", "ballad", fakeFetch);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected rejection");
    expect(r.error).toContain("HTTP 400");
    expect(r.error).toContain("Invalid value: 'ballad'");
    expect(r.supported).toEqual(["alloy", "echo", "nova"]);
  });

  test("auth, permission, and quota responses do not masquerade as bad voices", async () => {
    for (const status of [401, 403, 429]) {
      const statusFetch = (async () =>
        new Response("nope", { status })) as unknown as typeof fetch;
      expect(
        await validateOpenAIVoice("bad", "tts-1", "nova", statusFetch),
      ).toEqual({ ok: true });
    }
  });

  test("a network failure is not treated as a bad voice", async () => {
    // An unreachable endpoint says nothing about the voice. Failing here
    // would block a valid config behind a blip, so the wizard proceeds.
    const failing = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    expect(await validateOpenAIVoice("k", "tts-1", "nova", failing)).toEqual({
      ok: true,
    });
  });
});
