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
import {
  getPersonaSecretStrict,
  setPersonaSecret,
} from "../lib/vaultSecrets.ts";
import {
  findOpenAICompatibleCredential,
  type StoredOpenAICompatibleCredential,
} from "../lib/openAICompatibleCredentials.ts";
import { defaultServiceControl, type ServiceControl } from "../lib/platform.ts";
import {
  ELEVENLABS_DEFAULTS,
  ENV_KEY_FOR_PROVIDER,
  OPENAI_COMPATIBLE_DEFAULTS,
  OPENAI_COMPATIBLE_VOICE_KEY_ENV,
  OPENAI_BASE_URL,
  OPENROUTER_BASE_URL,
  normalizeOpenAICompatibleBaseUrl,
  openAICompatibleKeyEnv,
  openAICompatibleProviderLabel,
  type VoiceConfig,
  type VoiceProvider,
  validateElevenLabsKey,
  validateOpenAICompatibleKey,
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
  if (input.voice.provider === "azure_edge") {
    throw new Error(
      "Azure Edge TTS was removed — choose ElevenLabs or OpenAI Compatible",
    );
  }
  await updateConfigToml(input.configPath, (toml) => {
    setIn(toml, ["voice", "provider"], input.voice.provider);
    const voiceToml = toml.voice;
    if (voiceToml && typeof voiceToml === "object" && !Array.isArray(voiceToml)) {
      // Retired wire shapes remain readable for migration, but a successful
      // save must not carry them forward indefinitely.
      delete (voiceToml as Record<string, unknown>).openai;
      delete (voiceToml as Record<string, unknown>).azure_edge;
    }
    if (input.voice.provider === "elevenlabs" && input.voice.elevenlabs) {
      const e = input.voice.elevenlabs;
      setIn(toml, ["voice", "elevenlabs", "voice_id"], e.voiceId);
      setIn(toml, ["voice", "elevenlabs", "model_id"], e.modelId);
      setIn(toml, ["voice", "elevenlabs", "stability"], e.stability);
      setIn(toml, ["voice", "elevenlabs", "similarity_boost"], e.similarityBoost);
      setIn(toml, ["voice", "elevenlabs", "style"], e.style);
    }
    if (
      input.voice.provider === "openai-compatible" &&
      input.voice.openaiCompatible
    ) {
      const o = input.voice.openaiCompatible;
      setIn(toml, ["voice", "openai_compatible", "base_url"], o.baseUrl);
      setIn(toml, ["voice", "openai_compatible", "key_env"], o.keyEnv);
      setIn(toml, ["voice", "openai_compatible", "stt_model"], o.sttModel);
      setIn(toml, ["voice", "openai_compatible", "tts_model"], o.ttsModel);
      setIn(toml, ["voice", "openai_compatible", "voice"], o.voice);
      setIn(toml, ["voice", "openai_compatible", "speed"], o.speed);
    }
  });

  if (input.apiKey !== undefined && input.apiKey !== "") {
    const provider = input.voice.provider;
    if (provider === "elevenlabs" || provider === "openai-compatible") {
      const envVar = provider === "openai-compatible"
        ? input.voice.openaiCompatible!.keyEnv
        : ENV_KEY_FOR_PROVIDER[provider];
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

export type StoredVoiceCredential = StoredOpenAICompatibleCredential;

/** Find a matching credential in this persona only; never prints the value. */
export async function findStoredVoiceCredential(
  config: Config,
  persona: string,
  provider: VoiceProvider,
  baseUrl?: string,
): Promise<StoredVoiceCredential | undefined> {
  if (provider === "elevenlabs") {
    const name = ENV_KEY_FOR_PROVIDER.elevenlabs;
    const value = await getPersonaSecretStrict(config, name, persona);
    return value ? { name, value, needsWrite: false } : undefined;
  }
  if (provider !== "openai-compatible" || !baseUrl) return undefined;

  return findOpenAICompatibleCredential(config, persona, baseUrl);
}

export async function runVoice(input: RunInput = {}): Promise<number> {
  const err = input.err ?? process.stderr;
  const { config, persona } = input.config
    ? {
        config: input.config,
        persona: resolvePersona(input.persona, input.config),
      }
    : await loadConfigForPersona(input.persona);

  const dir = personaDir(config, persona);
  if (!existsSync(dir)) {
    err.write(`no persona '${persona}' at ${dir}\n`);
    return 2;
  }
  const voiceConfigPath = personaConfigPath(config.personasDir, persona);
  const svc = input.serviceControl ?? defaultServiceControl();
  const embedded = input.embedded ?? false;

  if (process.stdin.isTTY && !embedded) {
    const { runStandaloneFlow } = await import("../tui/standalone.tsx");
    const { configureVoice } = await import("../tui/voiceFlow.ts");

    return await runStandaloneFlow(async (q) => {
      const existing = config.voice;
      const provider = await q.choose({
        title: `Voice for ${persona}`,
        description: "how this phantom speaks and hears voice notes",
        options: [
          {
            value: "elevenlabs",
            label: "ElevenLabs",
            hint:
              existing.provider === "elevenlabs"
                ? "current · premium · paid (API key required)"
                : "premium · paid (API key required)",
          },
          {
            value: "openai-compatible",
            label: "OpenAI Compatible",
            hint:
              existing.provider === "openai-compatible"
                ? "current · paid (API key required)"
                : "paid (API key required)",
          },
          {
            value: "none",
            label: "None (disabled)",
            hint:
              existing.provider === "none"
                ? "current · text only"
                : "text only",
          },
        ],
        initial: existing.provider,
      });

      if (!provider) return "voice unchanged";

      const questions = {
        choose: (opts: any) => q.choose(opts),
        value: (opts: any) => q.value(opts),
        confirm: (opts: any) => q.confirm(opts),
      };

      const result = await configureVoice(
        persona,
        provider as VoiceProvider,
        questions,
        {
          existing,
          findCredential: async (pr, baseUrl) =>
            findStoredVoiceCredential(config, persona, pr, baseUrl),
          validateKey: async (pr, key, baseUrl) => {
            if (pr === "elevenlabs") return validateElevenLabsKey(key);
            if (pr === "openai-compatible") {
              return validateOpenAICompatibleKey(key, baseUrl ?? OPENAI_BASE_URL);
            }
            return { ok: true };
          },
        },
      );

      if (!result) return "voice unchanged";
      if ("rejected" in result)
        return `voice unchanged — rejected: ${result.rejected}`;

      await applyVoiceConfig({
        configPath: voiceConfigPath,
        config,
        persona,
        voice: result.voice,
        apiKey: result.apiKey,
      });

      await maybePromptRestart(
        svc,
        async (msg) =>
          await q.confirm({
            title: msg,
            consequence: {
              summary: "restarts daemon",
              detail: "",
              longRunning: false,
              restarts: true,
            },
          }),
        {
          note: (body: string, title?: string) =>
            q.note(title ?? "", body),
        } as never,
      );

      return `voice saved: ${result.summary}`;
    }, ["phantombot", persona, "voice"]);
  }

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
        value: "openai-compatible",
        label: "OpenAI Compatible",
        hint: "OpenAI, OpenRouter, or another /audio endpoint",
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
  if (provider === "openai-compatible")
    return runOpenAICompatibleFlow(
      voiceConfigPath,
      config,
      persona,
      svc,
      existing,
      embedded,
    );
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

async function runOpenAICompatibleFlow(
  /** The persona config file these settings are written to. */
  voiceConfigPath: string,
  config: Config,
  persona: string,
  svc: ServiceControl,
  existing: VoiceConfig,
  embedded: boolean,
): Promise<number> {
  const cur = existing.openaiCompatible ?? OPENAI_COMPATIBLE_DEFAULTS;
  const baseUrlAnswer = await p.text({
    message: "OpenAI Compatible base URL (include /v1)",
    placeholder:
      `${OPENAI_BASE_URL} · ${OPENROUTER_BASE_URL}`,
    defaultValue: cur.baseUrl,
    validate: (v) => (!v?.trim() ? "base URL is required" : undefined),
  });
  if (p.isCancel(baseUrlAnswer)) {
    p.cancel("cancelled");
    return 0;
  }
  const baseUrl = normalizeOpenAICompatibleBaseUrl(String(baseUrlAnswer));
  const stored = await findStoredVoiceCredential(
    config,
    persona,
    "openai-compatible",
    baseUrl,
  );
  let key = stored?.value;
  let keyEnv = stored?.name ?? openAICompatibleKeyEnv(baseUrl);
  if (stored) {
    const reuse = await p.confirm({
      message: `Use stored key for ${openAICompatibleProviderLabel(baseUrl)}?`,
      initialValue: true,
    });
    if (p.isCancel(reuse)) {
      p.cancel("cancelled");
      return 0;
    }
    if (!reuse) {
      key = undefined;
      // Declining a reusable routing/embeddings key means the typed key is
      // voice-only; keep it out of the shared credential's vault slot.
      keyEnv = OPENAI_COMPATIBLE_VOICE_KEY_ENV;
    }
  }
  if (!key) {
    const typed = await p.password({
      message: `${openAICompatibleProviderLabel(baseUrl)} API key`,
      validate: (v) => (!v || v.length === 0 ? "key is required" : undefined),
    });
    if (p.isCancel(typed)) {
      p.cancel("cancelled");
      return 0;
    }
    key = String(typed);
    if (!stored) keyEnv = openAICompatibleKeyEnv(baseUrl);
  }

  const spinner = p.spinner();
  spinner.start("validating key against /models…");
  const r = await validateOpenAICompatibleKey(key, baseUrl);
  if (!r.ok) {
    spinner.stop(`key rejected: ${r.error}`);
    p.cancel("aborting — key did not validate");
    return 1;
  }
  spinner.stop(`key validated (${r.modelCount} models visible)`);

  const sttModel = await p.text({
    message: "Speech-to-text model",
    defaultValue: cur.sttModel,
    validate: (v) => (!v?.trim() ? "STT model is required" : undefined),
  });
  if (p.isCancel(sttModel)) {
    p.cancel("cancelled");
    return 0;
  }
  const ttsModel = await p.text({
    message: "Text-to-speech model",
    defaultValue: cur.ttsModel,
    validate: (v) => (!v?.trim() ? "TTS model is required" : undefined),
  });
  if (p.isCancel(ttsModel)) {
    p.cancel("cancelled");
    return 0;
  }

  const voice = await p.text({
    message: "Voice",
    defaultValue: cur.voice,
    validate: (v) => (!v?.trim() ? "voice is required" : undefined),
  });
  if (p.isCancel(voice)) {
    p.cancel("cancelled");
    return 0;
  }

  await applyVoiceConfig({
    configPath: voiceConfigPath,
    config,
    persona,
    apiKey:
      stored?.value === key && stored.name === keyEnv && !stored.needsWrite
        ? undefined
        : key,
    voice: {
      provider: "openai-compatible",
      openaiCompatible: {
        baseUrl,
        keyEnv,
        sttModel: String(sttModel).trim(),
        ttsModel: String(ttsModel).trim(),
        voice: String(voice).trim(),
        speed: cur.speed,
      },
    },
  });
  p.note(
    `provider:  openai-compatible\n` +
      `base URL:  ${baseUrl}\n` +
      `voice:     ${voice}\n` +
      `STT model: ${sttModel}\n` +
      `TTS model: ${ttsModel}\n` +
      `key:       ${stored?.value === key ? `reused from ${keyEnv}` : `saved as ${keyEnv}`}`,
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
  if (v.provider === "openai-compatible" && v.openaiCompatible) {
    return (
      `base URL:  ${v.openaiCompatible.baseUrl}\n` +
      `voice:     ${v.openaiCompatible.voice}\n` +
      `STT model: ${v.openaiCompatible.sttModel}\n` +
      `TTS model: ${v.openaiCompatible.ttsModel}`
    );
  }
  if (v.provider === "azure_edge" && v.azure_edge) {
    return `REMOVED: run phantombot voice and choose another provider`;
  }
  return "";
}

export default defineCommand({
  meta: {
    name: "voice",
    description:
      "Configure TTS / STT provider (ElevenLabs / OpenAI Compatible). Validates the API key before saving.",
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
