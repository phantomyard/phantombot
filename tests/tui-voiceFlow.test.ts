/**
 * The OpenAI voice menu is fetched LIVE when a key exists, and falls back to
 * the offline list when it can't (#57 in AGENTS.md).
 *
 * `OPENAI_VOICE_OPTIONS` hardcoded the six tts-1-era voices, so the seven
 * voices OpenAI added with `gpt-4o-mini-tts` were invisible in the TUI even
 * though the API accepted them. These tests pin the replacement behavior at
 * the flow level: with a key the menu IS the provider's list (model-scoped);
 * without a probe result it is the curated fallback, labelled as such.
 */

import { describe, expect, test } from "bun:test";

import {
  configureVoice,
  type VoiceFlowDeps,
} from "../src/tui/voiceFlow.ts";
import type { ChannelsQuestions } from "../src/tui/channelsFlow.ts";

const GPT4O_VOICES = [
  "alloy", "echo", "fable", "onyx", "nova", "shimmer", "coral",
  "verse", "ballad", "ash", "sage", "marin", "cedar",
];

interface Chosen {
  title: string;
  options: readonly { value: string; hint?: string }[];
}

/**
 * A question harness: every choose() takes its first option; value() answers
 * `typedKey` ("" = the user submitted nothing).
 */
function fakeQ(typedKey = "typed-key"): ChannelsQuestions & {
  chosen: Chosen[];
} {
  const chosen: Chosen[] = [];
  return {
    chosen,
    choose: async (input: {
      title: string;
      options: readonly { value: string; hint?: string }[];
    }) => {
      chosen.push({ title: input.title, options: input.options });
      return input.options[0]?.value;
    },
    value: async () => typedKey,
    confirm: async () => true,
  } as never;
}

function deps(overrides: Partial<VoiceFlowDeps> = {}): VoiceFlowDeps {
  return {
    hasKey: () => false,
    validateKey: async () => ({ ok: true }),
    ...overrides,
  };
}

describe("configureVoice — openai voice list", () => {
  test("with a fresh key, the menu is the LIVE model-scoped list", async () => {
    const seen: string[] = [];
    const q = fakeQ();
    const r = await configureVoice("phantom", "openai", q, deps({
      fetchVoiceOptions: async (key, model) => {
        seen.push(`${key}:${model}`);
        return GPT4O_VOICES;
      },
    }));
    expect(seen).toEqual(["typed-key:gpt-4o-mini-tts"]);
    expect(r && "voice" in r && r.voice.openai?.voice).toBe("alloy");
    // The title carries no offline caveat when the live list arrived.
    expect(q.chosen[0]?.title).toBe("Voice for phantom");
  });

  test("a key typed THIS flow is preferred over the stored one for the probe", async () => {
    const seen: string[] = [];
    await configureVoice("phantom", "openai", fakeQ(), deps({
      openaiKeyForVoices: "stored-key",
      fetchVoiceOptions: async (key) => {
        seen.push(key);
        return GPT4O_VOICES;
      },
    }));
    expect(seen).toEqual(["typed-key"]);
  });

  test("stored key kept, none exposed for probing: fallback list, no probe", async () => {
    const q = fakeQ("");
    const r = await configureVoice("phantom", "openai", q, deps({
      hasKey: () => true,
      fetchVoiceOptions: async () => {
        throw new Error("must not probe without a key");
      },
    }));
    const voiceMenu = q.chosen[q.chosen.length - 1];
    expect(voiceMenu?.title).toBe(
      "Voice for phantom (offline list — full set with a working key)",
    );
    expect(r && "voice" in r && r.voice.openai?.voice).toBe("alloy");
  });

  test("probe failure (offline, unparsed error) degrades to the fallback list", async () => {
    const q = fakeQ("");
    await configureVoice("phantom", "openai", q, deps({
      hasKey: () => true,
      openaiKeyForVoices: "stored-key",
      fetchVoiceOptions: async () => [],
    }));
    const voiceMenu = q.chosen[q.chosen.length - 1];
    expect(voiceMenu?.title).toBe(
      "Voice for phantom (offline list — full set with a working key)",
    );
  });

  test("offline fallback on a legacy model is MODEL-SCOPED (regression)", async () => {
    // Kai, PR #570 review: the unscoped fallback offered all 13 voices even
    // on tts-1, where picking ballad persists an invalid pair that fails
    // with HTTP 400 on the next TTS call.
    const q = fakeQ("");
    await configureVoice("phantom", "openai", q, deps({
      hasKey: () => true,
      existing: {
        provider: "openai",
        openai: { model: "tts-1", voice: "nova", speed: 1 },
      },
      fetchVoiceOptions: async () => [], // probe returns nothing (offline)
    }));
    const offered = q.chosen[q.chosen.length - 1]?.options.map((o) => o.value);
    expect(offered).toHaveLength(9);
    for (const gpt4oOnly of ["ballad", "cedar", "marin", "verse"]) {
      expect(offered).not.toContain(gpt4oOnly);
    }
    expect(offered).toContain("nova");
  });

  test("the current voice is offered with the current hint", async () => {
    const q = fakeQ();
    await configureVoice("phantom", "openai", q, deps({
      existing: {
        provider: "openai",
        openai: { model: "gpt-4o-mini-tts", voice: "sage", speed: 1 },
      },
      openaiKeyForVoices: "stored-key",
      fetchVoiceOptions: async () => GPT4O_VOICES,
    }));
    const voiceMenu = q.chosen[q.chosen.length - 1];
    expect(voiceMenu?.options.find((o) => o.value === "sage")?.hint).toBe(
      "current",
    );
  });
});
