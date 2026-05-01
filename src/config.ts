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
    /** Order = primary → fallback. Recognized ids: "claude", "pi". */
    chain: string[];
    claude: { bin: string; model: string; fallbackModel: string };
    pi: { bin: string; maxPayloadBytes: number };
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
}

export function xdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}
export function xdgDataHome(): string {
  return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
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
  const tomlChannels = (toml.channels ?? {}) as Record<string, unknown>;
  const tomlTelegram = (tomlChannels.telegram ?? {}) as Record<string, unknown>;

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
      600_000,

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
    },

    channels: {
      telegram: buildTelegramConfig(tomlTelegram),
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
