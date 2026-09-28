import { describe, expect, test } from "bun:test";

import {
  configureVoice,
  type VoiceFlowDeps,
} from "../src/tui/voiceFlow.ts";
import type { ChannelsQuestions } from "../src/tui/channelsFlow.ts";

function questions(values: string[], confirms: boolean[] = [true]) {
  const asked: string[] = [];
  const q: ChannelsQuestions = {
    choose: async (input: { title: string; options: readonly { value: string }[] }) => {
      asked.push(input.title);
      return input.options[0]?.value;
    },
    value: async (input: { title: string }) => {
      asked.push(input.title);
      return values.shift();
    },
    confirm: async (input: { title: string }) => {
      asked.push(input.title);
      return confirms.shift();
    },
  } as never;
  return { q, asked };
}

function deps(overrides: Partial<VoiceFlowDeps> = {}): VoiceFlowDeps {
  return {
    findCredential: async () => undefined,
    validateKey: async () => ({ ok: true }),
    probeModels: async () => [],
    probeVoices: async () => [],
    checkVoice: async () => ({ ok: true }),
    ...overrides,
  };
}

describe("configureVoice — OpenAI Compatible", () => {
  test("collects endpoint, independent STT/TTS models, voice, and key", async () => {
    const { q } = questions([
      "https://openrouter.ai/api/v1/",
      "or-key",
      "openai/whisper-1",
      "openai/gpt-4o-mini-tts",
      "nova",
    ]);
    const seen: string[] = [];
    const result = await configureVoice(
      "phantom",
      "openai-compatible",
      q,
      deps({
        validateKey: async (_provider, key, baseUrl) => {
          seen.push(`${baseUrl}:${key}`);
          return { ok: true };
        },
        probeVoices: async () => ["nova", "shimmer"],
      }),
    );

    expect(seen).toEqual(["https://openrouter.ai/api/v1:or-key"]);
    expect(result && "voice" in result && result.voice.openaiCompatible).toEqual({
      baseUrl: "https://openrouter.ai/api/v1",
      keyEnv: "OPENROUTER_API_KEY",
      sttModel: "openai/whisper-1",
      ttsModel: "openai/gpt-4o-mini-tts",
      voice: "nova",
      speed: 1,
    });
    expect(result && "apiKey" in result && result.apiKey).toBe("or-key");
  });

  test("offers a matching stored key without displaying it", async () => {
    const { q, asked } = questions([
      "https://openrouter.ai/api/v1",
      "whisper",
      "tts",
      "coral",
    ]);
    const result = await configureVoice(
      "phantom",
      "openai-compatible",
      q,
      deps({
        findCredential: async () => ({
          name: "OPENROUTER_API_KEY",
          value: "secret-never-rendered",
          needsWrite: false,
        }),
      }),
    );
    expect(asked).toContain("Use stored key for OpenRouter?");
    expect(asked.join("\n")).not.toContain("secret-never-rendered");
    expect(result && "apiKey" in result && result.apiKey).toBeUndefined();
  });

  test("keeps the configured endpoint by default without opening the URL prompt", async () => {
    const valueTitles: string[] = [];
    let endpointChoice: {
      initial?: string;
      options: readonly { value: string; label: string }[];
    } | undefined;
    const q: ChannelsQuestions = {
      choose: async (input) => {
        if (input.title === "OpenAI Compatible endpoint") {
          endpointChoice = { initial: input.initial, options: input.options };
          return "keep";
        }
        return input.options[0]?.value;
      },
      value: async (input) => {
        valueTitles.push(input.title);
        return undefined;
      },
      confirm: async () => true,
    };
    const result = await configureVoice(
      "phantom",
      "openai-compatible",
      q,
      deps({
        existing: {
          provider: "openai-compatible",
          openaiCompatible: {
            baseUrl: "https://openrouter.ai/api/v1",
            keyEnv: "OPENROUTER_API_KEY",
            sttModel: "openai/whisper-1",
            ttsModel: "x-ai/grok-voice-tts-1.0",
            voice: "leo",
            speed: 1,
          },
        },
        findCredential: async () => ({
          name: "OPENROUTER_API_KEY",
          value: "stored-key",
          needsWrite: false,
        }),
        probeModels: async ({ modality }) => modality === "transcription"
          ? [{ id: "openai/whisper-1", voices: [] }]
          : [{ id: "x-ai/grok-voice-tts-1.0", voices: ["leo"] }],
      }),
    );

    expect(endpointChoice?.initial).toBe("keep");
    expect(endpointChoice?.options.map((option) => option.label)).toEqual([
      "Keep https://openrouter.ai/api/v1",
      "Change endpoint",
    ]);
    expect(valueTitles).not.toContain("OpenAI Compatible base URL (include /v1)");
    expect(result && "voice" in result && result.voice.openaiCompatible?.baseUrl)
      .toBe("https://openrouter.ai/api/v1");
  });

  test("prefills the configured URL when changing endpoint and returns the replacement", async () => {
    let endpointInitial: string | undefined;
    const q: ChannelsQuestions = {
      choose: async (input) => input.title === "OpenAI Compatible endpoint"
        ? "change"
        : input.options[0]?.value,
      value: async (input) => {
        if (input.title === "OpenAI Compatible base URL (include /v1)") {
          endpointInitial = input.initial;
          return "https://audio.example.test/v1/";
        }
        if (input.masked) return "replacement-key";
        return undefined;
      },
      confirm: async () => true,
    };
    const result = await configureVoice(
      "phantom",
      "openai-compatible",
      q,
      deps({
        existing: {
          provider: "openai-compatible",
          openaiCompatible: {
            baseUrl: "https://openrouter.ai/api/v1",
            keyEnv: "OPENROUTER_API_KEY",
            sttModel: "openai/whisper-1",
            ttsModel: "x-ai/grok-voice-tts-1.0",
            voice: "leo",
            speed: 1,
          },
        },
        probeModels: async ({ modality }) => modality === "transcription"
          ? [{ id: "vendor/stt", voices: [] }]
          : [{ id: "vendor/tts", voices: ["new-voice"] }],
      }),
    );

    expect(endpointInitial).toBe("https://openrouter.ai/api/v1");
    expect(result && "voice" in result && result.voice.openaiCompatible).toMatchObject({
      baseUrl: "https://audio.example.test/v1",
      keyEnv: "PHANTOMBOT_OPENAI_COMPATIBLE_API_KEY",
      sttModel: "vendor/stt",
      ttsModel: "vendor/tts",
      voice: "new-voice",
    });
    expect(result && "apiKey" in result && result.apiKey).toBe("replacement-key");
  });

  test("declining a shared stored key writes the replacement to a voice-only slot", async () => {
    const { q } = questions([
      "https://openrouter.ai/api/v1",
      "voice-only-key",
      "whisper",
      "tts",
      "coral",
    ], [false]);
    const result = await configureVoice(
      "phantom",
      "openai-compatible",
      q,
      deps({
        findCredential: async () => ({
          name: "OPENROUTER_API_KEY",
          value: "routing-key-must-survive",
          needsWrite: false,
        }),
      }),
    );

    expect(result && "voice" in result && result.voice.openaiCompatible?.keyEnv)
      .toBe("PHANTOMBOT_VOICE_OPENAI_COMPATIBLE_API_KEY");
    expect(result && "apiKey" in result && result.apiKey).toBe("voice-only-key");
  });

  test("rejects the retired Azure provider with migration guidance", async () => {
    const result = await configureVoice(
      "phantom",
      "azure_edge",
      questions([]).q,
      deps(),
    );
    expect(result).toEqual({
      rejected: "Azure Edge TTS was removed; choose another provider",
    });
  });
});

/**
 * Questions that let a test drive the voice MENU, not just the text boxes:
 * `pick` receives the option values offered and returns the chosen one.
 */
function menuQuestions(
  values: string[],
  pick: (options: string[]) => string | undefined,
) {
  const offered: string[][] = [];
  const titles: string[] = [];
  const q: ChannelsQuestions = {
    choose: async (input: {
      title: string;
      options: readonly { value: string }[];
    }) => {
      titles.push(input.title);
      const options = input.options.map((o) => o.value);
      offered.push(options);
      return pick(options);
    },
    value: async (input: { title: string }) => {
      titles.push(input.title);
      return values.shift();
    },
    confirm: async () => true,
  } as never;
  return { q, offered, titles };
}

const BASE = ["https://api.openai.com/v1", "sk-test", "whisper-1", "tts-1"];

describe("configureVoice — voice availability", () => {
  test("offers separate live STT and TTS catalogues from one endpoint", async () => {
    const seen: string[] = [];
    const { q, offered } = menuQuestions(
      ["https://openrouter.ai/api/v1", "or-key"],
      (options) => {
        if (options.includes("openai/whisper-1")) return "openai/whisper-1";
        if (options.includes("deepgram/aura-2")) return "deepgram/aura-2";
        return "aura-2-beatrix-nl";
      },
    );
    const result = await configureVoice(
      "phantom",
      "openai-compatible",
      q,
      deps({
        probeModels: async ({ modality }) => {
          seen.push(modality);
          return modality === "transcription"
            ? [{ id: "openai/whisper-1", voices: [] }]
            : [{ id: "deepgram/aura-2", voices: [] }];
        },
        probeVoices: async () => ["aura-2-beatrix-nl"],
      }),
    );
    expect(seen.sort()).toEqual(["speech", "transcription"]);
    expect(offered[0]).toEqual(["openai/whisper-1", "__other_audio_model__"]);
    expect(offered[1]).toEqual(["deepgram/aura-2", "__other_audio_model__"]);
    expect(result && "voice" in result && result.voice.openaiCompatible).toMatchObject({
      baseUrl: "https://openrouter.ai/api/v1",
      sttModel: "openai/whisper-1",
      ttsModel: "deepgram/aura-2",
      voice: "aura-2-beatrix-nl",
    });
  });

  test("offers the model's live voices and spends no synthesis on them", async () => {
    let probedWith: { baseUrl: string; model: string } | undefined;
    let checks = 0;
    const { q, offered } = menuQuestions([...BASE], (options) => options[1]);

    const result = await configureVoice(
      "phantom",
      "openai-compatible",
      q,
      deps({
        probeVoices: async ({ baseUrl, model }) => {
          probedWith = { baseUrl, model };
          return ["echo", "nova"];
        },
        checkVoice: async () => {
          checks += 1;
          return { ok: true };
        },
      }),
    );

    // Probed against the TTS model at the normalised endpoint — not the STT
    // model, whose voice set is irrelevant.
    expect(probedWith).toEqual({
      baseUrl: "https://api.openai.com/v1",
      model: "tts-1",
    });
    // Live list drives the menu, with the type-it-yourself escape last.
    expect(offered.at(-1)).toEqual(["echo", "nova", "__other__"]);
    expect(result && "voice" in result && result.voice.openaiCompatible?.voice)
      .toBe("nova");
    // Enumerated by the endpoint one moment ago: proving it again would bill
    // a synthesis for nothing.
    expect(checks).toBe(0);
  });

  test("prefers voices published on the selected model catalogue row", async () => {
    let probes = 0;
    let checks = 0;
    const { q, offered } = menuQuestions(
      ["https://openrouter.ai/api/v1", "or-key"],
      (options) => {
        if (options.includes("openai/whisper-1")) return "openai/whisper-1";
        if (options.includes("x-ai/grok-voice-tts-1.0"))
          return "x-ai/grok-voice-tts-1.0";
        return "leo";
      },
    );

    const result = await configureVoice(
      "phantom",
      "openai-compatible",
      q,
      deps({
        probeModels: async ({ modality }) => modality === "transcription"
          ? [{ id: "openai/whisper-1", voices: [] }]
          : [{
            id: "x-ai/grok-voice-tts-1.0",
            voices: ["eve", "ara", "rex", "sal", "leo"],
          }],
        probeVoices: async () => {
          probes += 1;
          return [];
        },
        checkVoice: async () => {
          checks += 1;
          return { ok: true };
        },
      }),
    );

    expect(offered.at(-1)).toEqual([
      "ara", "eve", "leo", "rex", "sal", "__other__",
    ]);
    expect(probes).toBe(0);
    expect(checks).toBe(0);
    expect(result && "voice" in result && result.voice.openaiCompatible?.voice)
      .toBe("leo");
  });

  test("falls back to the known list and PROVES the pick when the endpoint will not enumerate", async () => {
    const seen: string[] = [];
    const { q, offered, titles } = menuQuestions([...BASE], (o) => o[0]);

    const result = await configureVoice(
      "phantom",
      "openai-compatible",
      q,
      deps({
        probeVoices: async () => [],
        checkVoice: async ({ model, voice }) => {
          seen.push(`${model}:${voice}`);
          return { ok: true };
        },
      }),
    );

    // tts-1 rejects the four gpt-4o-mini-tts-only voices, so they must not
    // be offered for it even in the offline fallback.
    const menu = offered.at(-1) ?? [];
    for (const v of ["ballad", "cedar", "marin", "verse"])
      expect(menu).not.toContain(v);
    expect(titles.some((t) => t.includes("unverified"))).toBe(true);
    expect(seen).toEqual(["tts-1:alloy"]);
    expect(result && "voice" in result && result.voice.openaiCompatible?.voice)
      .toBe("alloy");
  });

  test("a rejected voice is stated with the real choices and nothing is written", async () => {
    const { q } = menuQuestions([...BASE], (o) => o[0]);
    const result = await configureVoice(
      "phantom",
      "openai-compatible",
      q,
      deps({
        probeVoices: async () => [],
        checkVoice: async () => ({
          ok: false,
          error: "HTTP 400: Invalid value: 'alloy'.",
          supported: ["aura-1", "aura-2"],
        }),
      }),
    );

    expect(result && "rejected" in result && result.rejected).toBe(
      "voice alloy rejected: HTTP 400: Invalid value: 'alloy'. — tts-1 accepts: aura-1, aura-2",
    );
    // A rejection must not smuggle a voice block through.
    expect(result && "voice" in result).toBe(false);
  });

  test("a hand-typed voice is proven, and the menu sentinel is never persisted", async () => {
    const seen: string[] = [];
    const { q } = menuQuestions([...BASE, "aura-asteria"], (o) => o.at(-1));
    const result = await configureVoice(
      "phantom",
      "openai-compatible",
      q,
      deps({
        // A live list that does NOT contain the typed voice: picking "Other"
        // must still reach the check rather than riding on the list.
        probeVoices: async () => ["echo", "nova"],
        checkVoice: async ({ voice }) => {
          seen.push(voice);
          return { ok: true };
        },
      }),
    );

    expect(seen).toEqual(["aura-asteria"]);
    expect(result && "voice" in result && result.voice.openaiCompatible?.voice)
      .toBe("aura-asteria");
    expect(result && "summary" in result && result.summary).not.toContain(
      "__other__",
    );
  });

  test("backing out of the voice menu writes nothing", async () => {
    const { q } = menuQuestions([...BASE], () => undefined);
    expect(
      await configureVoice(
        "phantom",
        "openai-compatible",
        q,
        deps({ probeVoices: async () => ["nova"] }),
      ),
    ).toBeUndefined();
  });
});
