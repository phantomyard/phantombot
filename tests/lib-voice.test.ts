import { describe, expect, test } from "bun:test";
import {
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
