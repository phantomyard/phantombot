/**
 * The CLI twin of the voice-availability flow. The TUI flow is pinned in
 * tests/tui-voiceFlow.test.ts, but `phantombot voice` on a TTY runs THIS
 * code path with its own copy of the probe/check logic — a fix applied to one
 * and not the other ships half a fix, so each flow carries its own pin.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let chosenVoice = "nova";

mock.module("@clack/prompts", () => ({
  intro: () => {},
  outro: () => {},
  note: () => {},
  cancel: () => {},
  select: async (opts: { message: string; options: { value: string }[] }) => {
    if (opts.message === "Speech-to-text model") return opts.options[0]?.value;
    if (opts.message === "Text-to-speech model") return opts.options[0]?.value;
    if (!opts.message.startsWith("Voice")) return "openai-compatible";
    const offered = opts.options.map((o) => o.value);
    voiceMenus.push(offered);
    return chosenVoice;
  },
  confirm: async () => true,
  password: async () => "sk-test",
  text: async (opts: { message: string }) => {
    if (opts.message.includes("base URL")) return "https://api.openai.com/v1";
    if (opts.message.includes("Speech-to-text")) return "whisper-1";
    if (opts.message.includes("Text-to-speech")) return "tts-1";
    throw new Error(`unexpected prompt: ${opts.message}`);
  },
  isCancel: () => false,
  spinner: () => ({
    start: () => {},
    stop: (message?: string) => spinnerStops.push(message ?? ""),
  }),
}));

const { runVoice } = await import("../src/cli/voice.ts");
import type { Config } from "../src/config.ts";

let workdir: string;
let personaConfig: string;
let config: Config;
let realFetch: typeof fetch;
let voiceMenus: string[][] = [];
/** Every spinner.stop() message, in order — the user-facing labels. */
let spinnerStops: string[] = []
/** Every voice POSTed to /audio/speech, in order. */
let speechCalls: string[] = [];
/** Voices this fake endpoint accepts; anything else is a 400. */
let accepted: string[] = [];
/** Model-scoped voices returned directly by the Models API. */
let catalogVoices: string[] = [];
let inconclusiveStatus: number | undefined;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-cli-voice-check-"));
  const personasDir = join(workdir, "personas");
  await mkdir(join(personasDir, "phantom"), { recursive: true });
  // The wizard writes the PERSONA's config, not the host config.
  personaConfig = join(personasDir, "phantom", "config.toml");
  config = {
    defaultPersona: "phantom",
    personaLayer: "phantom",
    personasDir,
    configPath: join(workdir, "config.toml"),
    channels: {},
    embeddings: { provider: "none" },
    voice: { provider: "none" },
  } as unknown as Config;

  voiceMenus = [];
  spinnerStops = [];
  speechCalls = [];
  chosenVoice = "nova";
  accepted = [];
  catalogVoices = [];
  inconclusiveStatus = undefined;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith("/models")) {
      const modality = parsed.searchParams.get("output_modalities");
      if (modality === "transcription")
        return Response.json({
          data: [{
            id: "whisper-1",
            architecture: { output_modalities: ["transcription"] },
          }],
        });
      if (modality === "speech")
        return Response.json({
          data: [{
            id: "tts-1",
            supported_voices: catalogVoices,
            architecture: { output_modalities: ["speech"] },
          }],
        });
      return Response.json({ data: [{ id: "tts-1" }] });
    }
    const voice = String(JSON.parse(String(init?.body)).voice);
    speechCalls.push(voice);
    if (inconclusiveStatus !== undefined)
      return new Response("account error", { status: inconclusiveStatus });
    if (accepted.includes(voice)) return new Response("audio", { status: 200 });
    return Response.json(
      {
        error: {
          message: `Invalid value: '${voice}'. Supported values are: ${accepted
            .map((v) => `'${v}'`)
            .join(", ")}.`,
        },
      },
      { status: 400 },
    );
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await rm(workdir, { recursive: true, force: true });
});

test("offers the voices the TTS model enumerates, and saves without a second call", async () => {
  accepted = ["echo", "nova"];

  expect(await runVoice({ config, embedded: true })).toBe(0);

  expect(voiceMenus.at(-1)).toEqual(["echo", "nova", "__other__"]);
  // One call only: the free enumeration probe. A voice the endpoint just
  // listed must not be re-proven with a billable synthesis.
  expect(speechCalls).toEqual(["__phantombot_probe__"]);
  expect(await readFile(personaConfig, "utf8")).toContain('voice = "nova"');
});

test("uses model-scoped catalogue voices without a synthesis probe", async () => {
  catalogVoices = ["eve", "ara", "rex", "sal", "leo"];
  chosenVoice = "leo";

  expect(await runVoice({ config, embedded: true })).toBe(0);

  expect(voiceMenus.at(-1)).toEqual([
    "ara", "eve", "leo", "rex", "sal", "__other__",
  ]);
  expect(speechCalls).toEqual([]);
  expect(await readFile(personaConfig, "utf8")).toContain('voice = "leo"');
});

test("a voice the endpoint rejects aborts the wizard instead of saving a mute config", async () => {
  accepted = ["echo", "nova"];
  // The endpoint enumerates, but the operator types something else.
  chosenVoice = "aura-asteria";

  expect(await runVoice({ config, embedded: true })).toBe(1);

  expect(speechCalls).toEqual(["__phantombot_probe__", "aura-asteria"]);
  // Nothing persisted: a config naming a voice this model refuses would be
  // silently mute on the persona's first spoken turn.
  await expect(readFile(personaConfig, "utf8")).rejects.toThrow();
});

test("a rejected voice is labelled 'voice rejected', never mislabelled as a bad key", async () => {
  accepted = ["echo", "nova"];
  chosenVoice = "aura-asteria";

  expect(await runVoice({ config, embedded: true })).toBe(1);

  // CLI twin pin (TUI pinned in tests/tui-voiceFlow.test.ts): the label must
  // say "voice rejected", so a bad voice name never reads as a bad API key.
  const rejected = spinnerStops.find((m) => m.includes("rejected"));
  expect(rejected).toContain("voice rejected");
  expect(spinnerStops.some((m) => m.includes("key rejected"))).toBe(false);
});

test("a non-enumerating endpoint still proves the chosen fallback voice", async () => {
  // Accepts the probe voice too — i.e. never reports its voice list.
  accepted = ["__phantombot_probe__", "alloy"];
  chosenVoice = "alloy";

  expect(await runVoice({ config, embedded: true })).toBe(0);

  // Fallback menu offered, and the pick proven for real because the probe
  // returned nothing.
  expect(voiceMenus.at(-1)).toContain("alloy");
  expect(voiceMenus.at(-1)).not.toContain("ballad"); // tts-1 rejects it
  expect(speechCalls).toEqual(["__phantombot_probe__", "alloy"]);
  expect(await readFile(personaConfig, "utf8")).toContain('voice = "alloy"');
});

test("a quota response during voice proof does not reject a valid configuration", async () => {
  inconclusiveStatus = 429;
  chosenVoice = "alloy";

  expect(await runVoice({ config, embedded: true })).toBe(0);

  expect(speechCalls).toEqual(["__phantombot_probe__", "alloy"]);
  expect(await readFile(personaConfig, "utf8")).toContain('voice = "alloy"');
});

test("a transient server error during voice proof does not reject a valid configuration", async () => {
  inconclusiveStatus = 502;
  chosenVoice = "leo";

  expect(await runVoice({ config, embedded: true })).toBe(0);

  expect(speechCalls).toEqual(["__phantombot_probe__", "leo"]);
  expect(await readFile(personaConfig, "utf8")).toContain('voice = "leo"');
});
