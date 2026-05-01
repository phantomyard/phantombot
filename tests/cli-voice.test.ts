import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyVoiceConfig } from "../src/cli/voice.ts";
import { loadEnvFile } from "../src/lib/envFile.ts";

let workdir: string;
let configPath: string;
let envPath: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-voice-"));
  configPath = join(workdir, "config.toml");
  envPath = join(workdir, ".env");
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("applyVoiceConfig — elevenlabs", () => {
  test("writes [voice] + [voice.elevenlabs] to config.toml + key to env", async () => {
    await applyVoiceConfig({
      configPath,
      envPath,
      apiKey: "sk_live_TEST",
      voice: {
        provider: "elevenlabs",
        elevenlabs: {
          voiceId: "voice_123",
          modelId: "eleven_turbo_v2_5",
          stability: 1,
          similarityBoost: 0.7,
          style: 0.8,
        },
      },
    });
    const cfg = await readFile(configPath, "utf8");
    expect(cfg).toContain("[voice]");
    expect(cfg).toContain('provider = "elevenlabs"');
    expect(cfg).toContain("[voice.elevenlabs]");
    expect(cfg).toContain('voice_id = "voice_123"');
    const env = await loadEnvFile(envPath);
    expect(env.PHANTOMBOT_ELEVENLABS_API_KEY).toBe("sk_live_TEST");
  });
});

describe("applyVoiceConfig — openai", () => {
  test("writes [voice.openai] block", async () => {
    await applyVoiceConfig({
      configPath,
      envPath,
      apiKey: "sk-OAITEST",
      voice: {
        provider: "openai",
        openai: { model: "tts-1", voice: "nova", speed: 1.0 },
      },
    });
    const cfg = await readFile(configPath, "utf8");
    expect(cfg).toContain('voice = "nova"');
    const env = await loadEnvFile(envPath);
    expect(env.PHANTOMBOT_OPENAI_API_KEY).toBe("sk-OAITEST");
  });
});

describe("applyVoiceConfig — azure_edge", () => {
  test("writes [voice.azure_edge] block; does NOT write any key (free)", async () => {
    await applyVoiceConfig({
      configPath,
      envPath,
      voice: {
        provider: "azure_edge",
        azure_edge: {
          voice: "en-US-JennyNeural",
          rate: "+0%",
          pitch: "+0Hz",
        },
      },
    });
    const cfg = await readFile(configPath, "utf8");
    expect(cfg).toContain('voice = "en-US-JennyNeural"');
    const env = await loadEnvFile(envPath);
    expect(env.PHANTOMBOT_ELEVENLABS_API_KEY).toBeUndefined();
    expect(env.PHANTOMBOT_OPENAI_API_KEY).toBeUndefined();
  });
});

describe("applyVoiceConfig — none", () => {
  test('flips provider to "none"', async () => {
    await applyVoiceConfig({
      configPath,
      envPath,
      voice: { provider: "none" },
    });
    const cfg = await readFile(configPath, "utf8");
    expect(cfg).toContain('provider = "none"');
  });
});
