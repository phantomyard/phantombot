/**
 * `phantombot voice` — interactive TUI for TTS/STT provider configuration.
 *
 * Provider + voice metadata land in config.toml under [voice]. API keys land
 * in the PERSONA'S ENCRYPTED VAULT (#452) — never in a plaintext .env, which
 * nothing reads at runtime any more.
 */

import { defineCommand } from "citty";
import * as p from "@clack/prompts";

import { existsSync } from "node:fs";

import {
  type Config,
  loadConfigForPersona,
  personaDir,
  resolvePersona,
} from "../config.ts";
import type { WriteSink } from "../lib/io.ts";
import { personaConfigPath } from "../lib/personaConfig.ts";
import { setIn, updateConfigToml } from "../lib/configWriter.ts";
import { setPersonaSecret } from "../lib/vaultSecrets.ts";
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
  /** Host config — resolves which persona's vault the key is written to. */
  config: Config;
  /** Persona whose vault receives the key. Default: PHANTOMBOT_PERSONA env, then the default persona. */
  persona?: string;
  voice: VoiceConfig;
  /** If set, store in the persona vault. If undefined, leave secrets alone. */
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

  if (input.apiKey !== undefined && input.apiKey !== "") {
    const provider = input.voice.provider;
    if (provider === "elevenlabs" || provider === "openai") {
      const envVar = ENV_KEY_FOR_PROVIDER[provider];
      const r = await setPersonaSecret(
        input.config,
        envVar,
        input.apiKey,
        input.persona,
      );
      if (!r.ok) {
        // Surfaced, not swallowed: the config now names a provider whose key
        // did not persist, and a silent failure here reads to the operator as
        // "voice configured" right up until the first turn goes mute.
        throw new Error(
          `voice: could not store ${envVar} in the ${r.persona} vault: ${r.error}`,
        );
      }
    }
  }
}

interface RunInput {
  /**
   * Persona to configure (phantombot#439). Voice is persona-scoped — each
   * phantom gets its own voice — so the settings are written to
   * `<personas-root>/<persona>/config.toml`, not to the host's global file.
   * Defaults to PHANTOMBOT_PERSONA env, then the host's default persona.
   */
  persona?: string;
  config?: Config;
  serviceControl?: ServiceControl;
  /**
   * When true, this runs as a sub-step of another wizard (e.g.
   * `phantombot init`) rather than standalone. Two effects:
   *   - suppresses the standalone intro/outro and the "Existing config"
   *     note (the parent owns the framing; a nested clack intro renders a
   *     stray bracket), and
   *   - skips the post-save restart prompt (the parent installs/starts the
   *     service afterwards, so there is nothing running to restart yet).
   */
  embedded?: boolean;
  /** Error sink (test seam). Default: process.stderr. */
  err?: WriteSink;
}

export async function runVoice(input: RunInput = {}): Promise<number> {
  const err = input.err ?? process.stderr;
  // Resolve the target persona BEFORE loading config, so the env-fallback
  // persona gets ITS layer — "Existing config" then shows what that persona
  // actually runs with rather than the default persona's voice
  // (phantombot#474 review). With an injected config the seam stays hermetic:
  // resolve against it, never read from disk.
  const { config, persona } = input.config
    ? {
        config: input.config,
        persona: resolvePersona(input.persona, input.config),
      }
    : await loadConfigForPersona(input.persona);
  // An explicit `--persona` must EXIST before anything is written. Without
  // this check a typo is silently "successful": `loadConfig("robbei")` reads a
  // missing persona file as an empty layer, and the writes below CREATE
  // `<personas-root>/robbei/config.toml` (and its directory), store the
  // provider credential and restart the service — for a persona that does not
  // exist and never runs. `task --persona` already refuses this class of
  // silent loss; so does this.
  const dir = personaDir(config, persona);
  if (!existsSync(dir)) {
    err.write(`no persona '${persona}' at ${dir}\n`);
    return 2;
  }
  // Writes land in the persona's own file. The global file is left alone: on
  // an unmigrated host it still holds the old `[voice]` block, and the merge
  // has the persona file winning, so the new value takes effect immediately
  // and a rollback to an older binary still finds a working global block.
  const voiceConfigPath = personaConfigPath(config.personasDir, persona);
  const svc = input.serviceControl ?? defaultServiceControl();
  const embedded = input.embedded ?? false;

  if (!embedded) p.intro("Configure TTS / STT");

  const existing = config.voice;
  if (!embedded && existing.provider !== "none") {
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
      configPath: voiceConfigPath,
      config,
      persona,
      voice: { provider: "none" },
    });
    p.note(`provider set to "none"`, "Saved");
    if (!embedded) {
      await maybePromptRestart(svc);
      p.outro("done");
    }
    return 0;
  }

  if (provider === "elevenlabs")
    return runElevenLabsFlow(voiceConfigPath, config, persona, svc, existing, embedded);
  if (provider === "openai")
    return runOpenAIFlow(voiceConfigPath, config, persona, svc, existing, embedded);
  if (provider === "azure_edge")
    return runAzureEdgeFlow(voiceConfigPath, config, persona, svc, existing, embedded);
  return 0;
}

async function runElevenLabsFlow(
  /** The persona config file these settings are written to. */
  voiceConfigPath: string,
  config: Config,
  persona: string,
  svc: ServiceControl,
  existing: VoiceConfig,
  embedded: boolean,
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
    configPath: voiceConfigPath,
    config,
    persona,
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
      `key saved to the ${persona} vault as ${ENV_KEY_FOR_PROVIDER.elevenlabs}`,
    "Saved",
  );
  if (!embedded) {
    await maybePromptRestart(svc);
    p.outro("done");
  }
  return 0;
}

async function runOpenAIFlow(
  /** The persona config file these settings are written to. */
  voiceConfigPath: string,
  config: Config,
  persona: string,
  svc: ServiceControl,
  existing: VoiceConfig,
  embedded: boolean,
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
    configPath: voiceConfigPath,
    config,
    persona,
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
      `key saved to the ${persona} vault as ${ENV_KEY_FOR_PROVIDER.openai}`,
    "Saved",
  );
  if (!embedded) {
    await maybePromptRestart(svc);
    p.outro("done");
  }
  return 0;
}

async function runAzureEdgeFlow(
  /** The persona config file these settings are written to. */
  voiceConfigPath: string,
  config: Config,
  persona: string,
  svc: ServiceControl,
  existing: VoiceConfig,
  embedded: boolean,
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
    configPath: voiceConfigPath,
    config,
    persona,
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
  if (!embedded) {
    await maybePromptRestart(svc);
    p.outro("done");
  }
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
  args: {
    persona: {
      type: "string",
      required: false,
      description:
        "Persona to configure voice for. Default: PHANTOMBOT_PERSONA env, then the host's default persona.",
    },
  },
  async run({ args }) {
    process.exitCode = await runVoice({
      persona: args.persona as string | undefined,
    });
  },
});
