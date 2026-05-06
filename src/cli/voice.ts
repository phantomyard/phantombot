/**
 * `phantombot voice` — interactive TUI for TTS/STT provider configuration.
 *
 * Provider + voice metadata land in config.toml under [voice]. API keys
 * land in the .env file alongside config.toml.
 */

import { defineCommand } from "citty";
import * as p from "@clack/prompts";

import { type Config, loadConfig } from "../config.ts";
import { setIn, updateConfigToml } from "../lib/configWriter.ts";
import { defaultEnvFilePath, updateEnvFile } from "../lib/envFile.ts";
import { defaultServiceControl, type ServiceControl } from "../lib/platform.ts";
import {
  AZURE_EDGE_DEFAULTS,
  AZURE_EDGE_VOICE_OPTIONS,
  ELEVENLABS_DEFAULTS,
  ENV_KEY_FOR_PROVIDER,
  OPENAI_DEFAULTS,
  OPENAI_VOICE_OPTIONS,
  type VoiceConfig,
  type VoiceProvider,
  validateElevenLabsKey,
  validateOpenAIKey,
} from "../lib/voice.ts";
import { maybePromptRestart } from "./harness.ts";

export interface ApplyVoiceInput {
  configPath: string;
  envPath: string;
  voice: VoiceConfig;
  /** If set, write to env. If "" (empty string), CLEAR the env var. If undefined, leave env untouched. */
  apiKey?: string;
}

export async function applyVoiceConfig(input: ApplyVoiceInput): Promise<void> {
  await updateConfigToml(input.configPath, (toml) => {
    setIn(toml, ["voice", "provider"], input.voice.provider);
    if (input.voice.provider === "elevenlabs" && input.voice.elevenlabs) {
      const e = input.voice.elevenlabs;
      setIn(toml, ["voice", "elevenlabs", "voice_id"], e.voiceId);
      setIn(toml, ["voice", "elevenlabs", "model_id"], e.modelId);
      setIn(toml, ["voice", "elevenlabs", "stability"], e.stability);
      setIn(toml, ["voice", "elevenlabs", "similarity_boost"], e.similarityBoost);
      setIn(toml, ["voice", "elevenlabs", "style"], e.style);
    }
    if (input.voice.provider === "openai" && input.voice.openai) {
      const o = input.voice.openai;
      setIn(toml, ["voice", "openai", "model"], o.model);
      setIn(toml, ["voice", "openai", "voice"], o.voice);
      setIn(toml, ["voice", "openai", "speed"], o.speed);
    }
    if (input.voice.provider === "azure_edge" && input.voice.azure_edge) {
      const a = input.voice.azure_edge;
      setIn(toml, ["voice", "azure_edge", "voice"], a.voice);
      setIn(toml, ["voice", "azure_edge", "rate"], a.rate);
      setIn(toml, ["voice", "azure_edge", "pitch"], a.pitch);
    }
  });

  if (input.apiKey !== undefined) {
    const provider = input.voice.provider;
    if (provider === "elevenlabs" || provider === "openai") {
      const envVar = ENV_KEY_FOR_PROVIDER[provider];
      await updateEnvFile(input.envPath, { [envVar]: input.apiKey });
    }
  }
}

interface RunInput {
  config?: Config;
  serviceControl?: ServiceControl;
}

export async function runVoice(input: RunInput = {}): Promise<number> {
  const config = input.config ?? (await loadConfig());
  const svc = input.serviceControl ?? defaultServiceControl();

  p.intro("Configure TTS / STT");

  const existing = config.voice;
  if (existing.provider !== "none") {
    p.note(
      `provider:  ${existing.provider}\n` +
        formatExistingDetails(existing),
      "Existing config",
    );
  }

  const provider = await p.select<VoiceProvider | "cancel">({
    message: "Provider",
    options: [
      {
        value: "elevenlabs",
        label: "ElevenLabs",
        hint: "premium, custom voices, paid (API key required)",
      },
      {
        value: "openai",
        label: "OpenAI",
        hint: "6 built-in voices, cheap, paid (API key required)",
      },
      {
        value: "azure_edge",
        label: "Azure Edge TTS",
        hint: "Microsoft's free Edge endpoint (no key needed)",
      },
      { value: "none", label: "None — disable TTS/STT" },
      { value: "cancel", label: "Cancel" },
    ],
    initialValue: existing.provider === "none" ? "elevenlabs" : existing.provider,
  });
  if (p.isCancel(provider) || provider === "cancel") {
    p.cancel("cancelled");
    return 0;
  }

  if (provider === "none") {
    await applyVoiceConfig({
      configPath: config.configPath,
      envPath: defaultEnvFilePath(),
      voice: { provider: "none" },
    });
    p.note(`provider set to "none"`, "Saved");
    await maybePromptRestart(svc);
    p.outro("done");
    return 0;
  }

  if (provider === "elevenlabs") return runElevenLabsFlow(config, svc, existing);
  if (provider === "openai") return runOpenAIFlow(config, svc, existing);
  if (provider === "azure_edge") return runAzureEdgeFlow(config, svc, existing);
  return 0;
}

async function runElevenLabsFlow(
  config: Config,
  svc: ServiceControl,
  existing: VoiceConfig,
): Promise<number> {
  const cur = existing.elevenlabs ?? ELEVENLABS_DEFAULTS;
  const key = await p.password({
    message: "ElevenLabs API key (https://elevenlabs.io/app/settings/api-keys)",
    validate: (v) => (!v || v.length === 0 ? "key is required" : undefined),
  });
  if (p.isCancel(key)) {
    p.cancel("cancelled");
    return 0;
  }
  const spinner = p.spinner();
  spinner.start("validating key against /v1/voices…");
  const r = await validateElevenLabsKey(key as string);
  if (!r.ok) {
    spinner.stop(`key rejected: ${r.error}`);
    p.cancel("aborting — key did not validate");
    return 1;
  }
  spinner.stop(`key validated (${r.voiceCount} voices on this account)`);

  const voiceId = await p.text({
    message: "Voice ID (default = your previous one or Daniel)",
    placeholder: cur.voiceId,
    defaultValue: cur.voiceId,
  });
  if (p.isCancel(voiceId)) {
    p.cancel("cancelled");
    return 0;
  }
  const modelId = await p.text({
    message: "Model ID",
    placeholder: cur.modelId,
    defaultValue: cur.modelId,
  });
  if (p.isCancel(modelId)) {
    p.cancel("cancelled");
    return 0;
  }

  await applyVoiceConfig({
    configPath: config.configPath,
    envPath: defaultEnvFilePath(),
    apiKey: key as string,
    voice: {
      provider: "elevenlabs",
      elevenlabs: {
        voiceId: (voiceId as string) || cur.voiceId,
        modelId: (modelId as string) || cur.modelId,
        stability: cur.stability,
        similarityBoost: cur.similarityBoost,
        style: cur.style,
      },
    },
  });

  p.note(
    `provider:  elevenlabs\n` +
      `voice id:  ${(voiceId as string) || cur.voiceId}\n` +
      `model:     ${(modelId as string) || cur.modelId}\n` +
      `key saved to ${defaultEnvFilePath()} as ${ENV_KEY_FOR_PROVIDER.elevenlabs}`,
    "Saved",
  );
  await maybePromptRestart(svc);
  p.outro("done");
  return 0;
}

async function runOpenAIFlow(
  config: Config,
  svc: ServiceControl,
  existing: VoiceConfig,
): Promise<number> {
  const cur = existing.openai ?? OPENAI_DEFAULTS;
  const key = await p.password({
    message: "OpenAI API key (https://platform.openai.com/api-keys)",
    validate: (v) => (!v || v.length === 0 ? "key is required" : undefined),
  });
  if (p.isCancel(key)) {
    p.cancel("cancelled");
    return 0;
  }
  const spinner = p.spinner();
  spinner.start("validating key against /v1/models…");
  const r = await validateOpenAIKey(key as string);
  if (!r.ok) {
    spinner.stop(`key rejected: ${r.error}`);
    p.cancel("aborting — key did not validate");
    return 1;
  }
  spinner.stop(`key validated (${r.modelCount} models visible)`);

  const voice = await p.select<string>({
    message: "Voice",
    options: OPENAI_VOICE_OPTIONS.map((v) => ({ value: v, label: v })),
    initialValue: cur.voice,
  });
  if (p.isCancel(voice)) {
    p.cancel("cancelled");
    return 0;
  }
  const model = await p.select<string>({
    message: "Model",
    options: [
      { value: "tts-1", label: "tts-1 (fast, lower quality)" },
      { value: "tts-1-hd", label: "tts-1-hd (slower, higher quality)" },
    ],
    initialValue: cur.model,
  });
  if (p.isCancel(model)) {
    p.cancel("cancelled");
    return 0;
  }

  await applyVoiceConfig({
    configPath: config.configPath,
    envPath: defaultEnvFilePath(),
    apiKey: key as string,
    voice: {
      provider: "openai",
      openai: {
        model: model as string,
        voice: voice as string,
        speed: cur.speed,
      },
    },
  });
  p.note(
    `provider:  openai\n` +
      `voice:     ${voice}\n` +
      `model:     ${model}\n` +
      `key saved to ${defaultEnvFilePath()} as ${ENV_KEY_FOR_PROVIDER.openai}`,
    "Saved",
  );
  await maybePromptRestart(svc);
  p.outro("done");
  return 0;
}

async function runAzureEdgeFlow(
  config: Config,
  svc: ServiceControl,
  existing: VoiceConfig,
): Promise<number> {
  const cur = existing.azure_edge ?? AZURE_EDGE_DEFAULTS;
  const voice = await p.select<string>({
    message: "Voice (Azure Edge — free, no key)",
    options: AZURE_EDGE_VOICE_OPTIONS.map((v) => ({ value: v, label: v })),
    initialValue: cur.voice,
  });
  if (p.isCancel(voice)) {
    p.cancel("cancelled");
    return 0;
  }

  await applyVoiceConfig({
    configPath: config.configPath,
    envPath: defaultEnvFilePath(),
    voice: {
      provider: "azure_edge",
      azure_edge: {
        voice: voice as string,
        rate: cur.rate,
        pitch: cur.pitch,
      },
    },
  });
  p.note(
    `provider:  azure_edge\n` +
      `voice:     ${voice}\n` +
      `(no API key required)`,
    "Saved",
  );
  await maybePromptRestart(svc);
  p.outro("done");
  return 0;
}

function formatExistingDetails(v: VoiceConfig): string {
  if (v.provider === "elevenlabs" && v.elevenlabs) {
    return `voice id:  ${v.elevenlabs.voiceId}\nmodel:     ${v.elevenlabs.modelId}`;
  }
  if (v.provider === "openai" && v.openai) {
    return `voice:     ${v.openai.voice}\nmodel:     ${v.openai.model}`;
  }
  if (v.provider === "azure_edge" && v.azure_edge) {
    return `voice:     ${v.azure_edge.voice}`;
  }
  return "";
}

export default defineCommand({
  meta: {
    name: "voice",
    description:
      "Configure TTS / STT provider (ElevenLabs / OpenAI / Azure Edge). Validates the API key before saving.",
  },
  async run() {
    process.exitCode = await runVoice();
  },
});
