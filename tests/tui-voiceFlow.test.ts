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
