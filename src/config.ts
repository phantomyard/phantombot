/**
 * Config loading. Single source of truth for env-var names and defaults.
 *
 * Keep this thin: every option has a default or fails loudly on startup.
 * Don't read process.env from anywhere else in the codebase.
 */

import { resolve } from "node:path";

export interface Config {
  agentDir: string;
  memoryDb: string;

  channels: {
    telegram?: { token: string };
    signal?: { url: string; number: string };
    googlechat?: { serviceAccountPath: string; projectId: string };
  };

  harnesses: {
    chain: string[]; // order = primary -> last fallback
    claude: { bin: string; model: string; fallbackModel: string };
    codex: { bin: string; model: string };
    gemini: { bin: string; model: string };
    pi: { bin: string; model: string };
  };

  turnTimeoutMs: number;
  logLevel: string;
}

function env(name: string, fallback: string): string;
function env(name: string, fallback?: undefined): string | undefined;
function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v;
}

export function loadConfig(): Config {
  const agentDir = resolve(env("PHANTOMBOT_AGENT_DIR", "./agents/phantom"));
  const memoryDb = resolve(env("PHANTOMBOT_MEMORY_DB", "./data/memory.sqlite"));

  const channels: Config["channels"] = {};
  const tg = env("TELEGRAM_BOT_TOKEN");
  if (tg) channels.telegram = { token: tg };

  const sigUrl = env("SIGNAL_CLI_URL");
  const sigNumber = env("SIGNAL_CLI_NUMBER");
  if (sigUrl && sigNumber) channels.signal = { url: sigUrl, number: sigNumber };

  const gcSa = env("GOOGLE_CHAT_SERVICE_ACCOUNT");
  const gcProj = env("GOOGLE_CHAT_PROJECT_ID");
  if (gcSa && gcProj) channels.googlechat = { serviceAccountPath: gcSa, projectId: gcProj };

  const chain = env("PHANTOMBOT_HARNESS_CHAIN", "claude,codex,gemini,pi")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return {
    agentDir,
    memoryDb,
    channels,
    harnesses: {
      chain,
      claude: {
        bin: env("PHANTOMBOT_CLAUDE_BIN", "claude"),
        model: env("PHANTOMBOT_CLAUDE_MODEL", "opus"),
        fallbackModel: env("PHANTOMBOT_CLAUDE_FALLBACK_MODEL", "sonnet"),
      },
      codex: {
        bin: env("PHANTOMBOT_CODEX_BIN", "codex"),
        model: env("PHANTOMBOT_CODEX_MODEL", ""),
      },
      gemini: {
        bin: env("PHANTOMBOT_GEMINI_BIN", "gemini"),
        model: env("PHANTOMBOT_GEMINI_MODEL", ""),
      },
      pi: {
        bin: env("PHANTOMBOT_PI_BIN", "pi"),
        model: env("PHANTOMBOT_PI_MODEL", ""),
      },
    },
    turnTimeoutMs: Number(env("PHANTOMBOT_TURN_TIMEOUT_MS", "600000")),
    logLevel: env("PHANTOMBOT_LOG_LEVEL", "info"),
  };
}
