/**
 * Config loader. Single source of truth for paths, harness binaries, and
 * the harness chain order.
 *
 * Resolution priority (highest wins):
 *   1. Env vars (PHANTOMBOT_*)
 *   2. TOML config at $XDG_CONFIG_HOME/phantombot/config.toml
 *      (override path with PHANTOMBOT_CONFIG)
 *   3. Built-in defaults
 *
 * The config file is optional — phantombot runs with built-in defaults if
 * it doesn't exist.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { loadState } from "./state.ts";

export interface Config {
  /** Persona used by `ask`/`chat` when --persona is omitted. */
  defaultPersona: string;
  /** Per-harness wall-clock timeout in milliseconds. */
  turnTimeoutMs: number;
  /** Directory holding `<persona>/` subdirs. */
  personasDir: string;
  /** Path to the SQLite memory store file. */
  memoryDbPath: string;
  /** Path to the config file we loaded (whether it existed or not). */
  configPath: string;

  harnesses: {
    /** Order = primary → fallback. Recognized ids: "claude", "pi", "gemini". */
    chain: string[];
    claude: { bin: string; model: string; fallbackModel: string };
    pi: { bin: string; maxPayloadBytes: number };
    gemini: { bin: string; model: string };
  };

  channels: {
    telegram?: {
      token: string;
      /** Long-poll timeout in seconds (1..50). Default 30. */
      pollTimeoutS: number;
      /** If non-empty, only these Telegram numeric user IDs can talk to the bot. */
      allowedUserIds: number[];
    };
  };

  embeddings: {
    /** "gemini" | "none". "none" = FTS5-only search. */
    provider: "gemini" | "none";
    gemini?: {
      apiKey: string;
      model: string;
      dims: number;
    };
  };

  voice: import("./lib/voice.ts").VoiceConfig;
}

export function xdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}
export function xdgDataHome(): string {
  return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
}
export function xdgStateHome(): string {
  return process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
}

const DEFAULT_HARNESS_CHAIN = ["claude"] as const;

export async function loadConfig(): Promise<Config> {
  const configPath =
    process.env.PHANTOMBOT_CONFIG ??
    join(xdgConfigHome(), "phantombot", "config.toml");

  const toml = await tryReadToml(configPath);
  const state = await loadState();

  const dataDir = join(xdgDataHome(), "phantombot");

  const tomlHarnesses = (toml.harnesses ?? {}) as Record<string, unknown>;
  const tomlClaude = (tomlHarnesses.claude ?? {}) as Record<string, unknown>;
  const tomlPi = (tomlHarnesses.pi ?? {}) as Record<string, unknown>;
  const tomlGeminiHarness = (tomlHarnesses.gemini ?? {}) as Record<string, unknown>;
  const tomlChannels = (toml.channels ?? {}) as Record<string, unknown>;
  const tomlTelegram = (tomlChannels.telegram ?? {}) as Record<string, unknown>;
  const tomlEmbeddings = (toml.embeddings ?? {}) as Record<string, unknown>;
  const tomlGemini = (tomlEmbeddings.gemini ?? {}) as Record<string, unknown>;
  const tomlVoice = (toml.voice ?? {}) as Record<string, unknown>;

  return {
    defaultPersona:
      process.env.PHANTOMBOT_DEFAULT_PERSONA ??
      state.default_persona ??
      asString(toml.default_persona) ??
      "phantom",

    turnTimeoutMs:
      asInt(process.env.PHANTOMBOT_TURN_TIMEOUT_MS) ??
      (asInt(toml.turn_timeout_s) !== undefined
        ? asInt(toml.turn_timeout_s)! * 1000
        : undefined) ??
      120_000,

    personasDir:
      process.env.PHANTOMBOT_PERSONAS_DIR ??
      asString(toml.personas_dir) ??
      join(dataDir, "personas"),

    memoryDbPath:
      process.env.PHANTOMBOT_MEMORY_DB ??
      asString(toml.memory_db) ??
      join(dataDir, "memory.sqlite"),

    configPath,

    harnesses: {
      chain:
        process.env.PHANTOMBOT_HARNESS_CHAIN
          ?.split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0) ??
        asStringArray(tomlHarnesses.chain) ??
        [...DEFAULT_HARNESS_CHAIN],

      claude: {
        bin:
          process.env.PHANTOMBOT_CLAUDE_BIN ??
          asString(tomlClaude.bin) ??
          "claude",
        model:
          process.env.PHANTOMBOT_CLAUDE_MODEL ??
          asString(tomlClaude.model) ??
          "opus",
        fallbackModel:
          process.env.PHANTOMBOT_CLAUDE_FALLBACK_MODEL ??
          asString(tomlClaude.fallback_model) ??
          "sonnet",
      },

      pi: {
        bin:
          process.env.PHANTOMBOT_PI_BIN ??
          asString(tomlPi.bin) ??
          "pi",
        maxPayloadBytes:
          asInt(process.env.PHANTOMBOT_PI_MAX_PAYLOAD) ??
          asInt(tomlPi.max_payload_bytes) ??
          1_500_000,
      },

      gemini: {
        bin:
          process.env.PHANTOMBOT_GEMINI_BIN ??
          asString(tomlGeminiHarness.bin) ??
          "gemini",
        // Empty string = "let gemini-cli pick its own default" — see
        // GeminiHarness for why we don't pass -m in that case.
        model:
          process.env.PHANTOMBOT_GEMINI_MODEL ??
          asString(tomlGeminiHarness.model) ??
          "",
      },
    },

    channels: {
      telegram: buildTelegramConfig(tomlTelegram),
    },

    embeddings: buildEmbeddingsConfig(tomlEmbeddings, tomlGemini),

    voice: buildVoiceConfig(tomlVoice),
  };
}

function buildVoiceConfig(
  tomlVoice: Record<string, unknown>,
): import("./lib/voice.ts").VoiceConfig {
  const provider =
    (asString(tomlVoice.provider) as
      | "elevenlabs"
      | "openai"
      | "azure_edge"
      | "none"
      | undefined) ?? "none";

  if (provider === "elevenlabs") {
    const e = (tomlVoice.elevenlabs ?? {}) as Record<string, unknown>;
    return {
      provider: "elevenlabs",
      elevenlabs: {
        voiceId: asString(e.voice_id) ?? "",
        modelId: asString(e.model_id) ?? "eleven_turbo_v2_5",
        stability: asNumber(e.stability) ?? 1,
        similarityBoost: asNumber(e.similarity_boost) ?? 0.7,
        style: asNumber(e.style) ?? 0.8,
      },
    };
  }
  if (provider === "openai") {
    const o = (tomlVoice.openai ?? {}) as Record<string, unknown>;
    return {
      provider: "openai",
      openai: {
        model: asString(o.model) ?? "tts-1",
        voice: asString(o.voice) ?? "nova",
        speed: asNumber(o.speed) ?? 1.0,
      },
    };
  }
  if (provider === "azure_edge") {
    const a = (tomlVoice.azure_edge ?? {}) as Record<string, unknown>;
    return {
      provider: "azure_edge",
      azure_edge: {
        voice: asString(a.voice) ?? "en-US-JennyNeural",
        rate: asString(a.rate) ?? "+0%",
        pitch: asString(a.pitch) ?? "+0Hz",
      },
    };
  }
  return { provider: "none" };
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function buildEmbeddingsConfig(
  tomlEmbeddings: Record<string, unknown>,
  tomlGemini: Record<string, unknown>,
): Config["embeddings"] {
  const envApiKey = process.env.PHANTOMBOT_GEMINI_API_KEY;
  const tomlApiKey = asString(tomlGemini.api_key);
  const apiKey = envApiKey ?? tomlApiKey;

  const provider =
    (asString(tomlEmbeddings.provider) as "gemini" | "none" | undefined) ??
    (apiKey ? "gemini" : "none");

  if (provider !== "gemini") return { provider };

  return {
    provider: "gemini",
    gemini: {
      apiKey: apiKey ?? "",
      model: asString(tomlGemini.model) ?? "gemini-embedding-001",
      dims: asInt(tomlGemini.dims) ?? 1536,
    },
  };
}

function buildTelegramConfig(
  tomlTelegram: Record<string, unknown>,
): Config["channels"]["telegram"] {
  const token =
    process.env.TELEGRAM_BOT_TOKEN ?? asString(tomlTelegram.token);
  if (!token) return undefined;

  const pollTimeoutS = clampPollTimeout(
    asInt(process.env.PHANTOMBOT_TELEGRAM_POLL_S) ??
      asInt(tomlTelegram.poll_timeout_s) ??
      30,
  );

  const allowedFromEnv = process.env.PHANTOMBOT_TELEGRAM_ALLOWED_USERS
    ?.split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n));
  const allowedFromToml = asIntArray(tomlTelegram.allowed_user_ids);
  const allowedUserIds = allowedFromEnv ?? allowedFromToml ?? [];

  return { token, pollTimeoutS, allowedUserIds };
}

function clampPollTimeout(s: number): number {
  if (!Number.isFinite(s)) return 30;
  return Math.max(1, Math.min(50, Math.floor(s)));
}

function asIntArray(v: unknown): number[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: number[] = [];
  for (const x of v) {
    const n = asInt(x);
    if (n !== undefined) out.push(n);
  }
  return out;
}

/** Resolve the on-disk directory for a named persona. */
export function personaDir(config: Config, name: string): string {
  return join(config.personasDir, name);
}

async function tryReadToml(path: string): Promise<Record<string, unknown>> {
  try {
    const content = await readFile(path, "utf8");
    return parseToml(content) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asInt(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? Math.floor(n) : undefined;
  }
  return undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
}
