import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("@clack/prompts", () => ({
  intro: () => {},
  outro: () => {},
  note: () => {},
  cancel: () => {},
  select: async () => "openai-compatible",
  confirm: async () => false,
  password: async () => "voice-only-key",
  text: async (opts: { message: string }) => {
    if (opts.message.includes("base URL")) return "https://openrouter.ai/api/v1";
    if (opts.message.includes("Speech-to-text")) return "openai/whisper-large-v3";
    if (opts.message.includes("Text-to-speech")) return "openai/gpt-audio-mini";
    if (opts.message === "Voice") return "alloy";
    throw new Error(`unexpected prompt: ${opts.message}`);
  },
  isCancel: () => false,
  spinner: () => ({ start: () => {}, stop: () => {} }),
}));

const { runVoice } = await import("../src/cli/voice.ts");
const { openPersonaVault } = await import("../src/lib/vault.ts");
import type { Config } from "../src/config.ts";

let workdir: string;
let personasDir: string;
let config: Config;
let realFetch: typeof fetch;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-cli-voice-decline-"));
  personasDir = join(workdir, "personas");
  await mkdir(join(personasDir, "phantom"), { recursive: true });
  config = {
    defaultPersona: "phantom",
    personaLayer: "phantom",
    personasDir,
    configPath: join(workdir, "config.toml"),
    channels: {},
    embeddings: { provider: "none" },
    voice: { provider: "none" },
  } as unknown as Config;

  const vault = await openPersonaVault(join(personasDir, "phantom"));
  try {
    vault.set("OPENROUTER_API_KEY", "routing-key-must-survive");
  } finally {
    vault.close();
  }

  realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ data: [{ id: "model" }] })) as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await rm(workdir, { recursive: true, force: true });
});

test("declining a stored routing key writes the typed key to the voice-only slot", async () => {
  expect(await runVoice({ config, embedded: true })).toBe(0);

  const vault = await openPersonaVault(join(personasDir, "phantom"));
  try {
    expect(vault.get("OPENROUTER_API_KEY")).toBe("routing-key-must-survive");
    expect(vault.get("PHANTOMBOT_VOICE_OPENAI_COMPATIBLE_API_KEY")).toBe(
      "voice-only-key",
    );
  } finally {
    vault.close();
  }
});
