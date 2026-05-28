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
import { log } from "./lib/logger.ts";
import { loadState } from "./state.ts";

/**
 * Read the legacy `turn_timeout_s` (TOML) or `PHANTOMBOT_TURN_TIMEOUT_MS`
 * (env) and convert to ms. Returns undefined if neither is set.
 *
 * A side effect of being called: logs a one-shot warn naming the new
 * pair so legacy users see the migration hint at startup. The warn is
 * gated by a module-scoped flag so loadConfig can be called multiple
 * times in tests without spamming.
 */
let legacyWarnLogged = false;
function legacyTurnTimeoutMs(
  toml: Record<string, unknown>,
): number | undefined {
  const envMs = asInt(process.env.PHANTOMBOT_TURN_TIMEOUT_MS);
  if (envMs !== undefined) {
    if (!legacyWarnLogged) {
      log.warn(
        "config: PHANTOMBOT_TURN_TIMEOUT_MS is deprecated; set PHANTOMBOT_HARNESS_IDLE_TIMEOUT_MS and PHANTOMBOT_HARNESS_HARD_TIMEOUT_MS instead",
      );
      legacyWarnLogged = true;
    }
    return envMs;
  }
  const tomlS = asInt(toml.turn_timeout_s);
  if (tomlS !== undefined) {
    if (!legacyWarnLogged) {
      log.warn(
        "config: turn_timeout_s is deprecated; replace with harness_idle_timeout_s and harness_hard_timeout_s in config.toml (currently aliased to both for back-compat)",
      );
      legacyWarnLogged = true;
    }
    return tomlS * 1000;
  }
  return undefined;
}

/**
 * One Telegram bot account: token + per-bot poll/allowlist tuning.
 * The default account in `channels.telegram` binds to
 * `config.defaultPersona`. Entries in `channels.telegramPersonas`
 * each bind to the persona named by their map key.
 */
export interface TelegramAccount {
  token: string;
  /** Long-poll timeout in seconds (1..50). Default 30. */
  pollTimeoutS: number;
  /** If non-empty, only these Telegram numeric user IDs can talk to the bot. */
  allowedUserIds: number[];
}

/**
 * Auto-retrieval settings. When enabled, each interactive turn embeds the
 * incoming user message, hybrid-searches the persona's memory/ + kb/ index,
 * and injects the top hits into the system prompt's "Retrieved context"
 * slot — so relevant standing knowledge surfaces without the agent having
 * to consciously run `phantombot memory search`. Degrades to FTS-only when
 * embeddings aren't configured, and never blocks a turn on failure.
 */
export interface RetrievalSettings {
  /** Master switch. When false, no retrieval is attempted on any turn. */
  enabled: boolean;
  /** Max number of hits to inject. */
  limit: number;
  /**
   * Approximate token budget for the injected block. Hits are added
   * newest-best-first until the budget is hit (chars ≈ tokens × 4).
   */
  maxTokens: number;
  /**
   * Minimum hit score (RRF when hybrid, FTS otherwise) to include. 0 = no
   * floor (include anything the index matched). Raise to suppress weak hits.
   */
  minScore: number;
}

export const DEFAULT_RETRIEVAL: RetrievalSettings = {
  enabled: true,
  limit: 5,
  maxTokens: 1500,
  minScore: 0,
};

export interface Config {
  /** Persona used by `ask`/`chat` when --persona is omitted. */
  defaultPersona: string;
  /**
   * Kill the harness subprocess if no output lands on stdout for this
   * long. Resets every time the harness emits a chunk. Right knob for
   * "subprocess wedged on a hung tool call" — productive work that's
   * spitting out tool events keeps the timer fed.
   */
  harnessIdleTimeoutMs: number;
  /**
   * Hard wall-clock cap on a single harness turn. Independent of activity.
   * Caps runaway agents that legitimately keep emitting but never finish.
   */
  harnessHardTimeoutMs: number;
  /** Directory holding `<persona>/` subdirs. */
  personasDir: string;
  /** Path to the SQLite memory store file. */
  memoryDbPath: string;
  /** Path to the config file we loaded (whether it existed or not). */
  configPath: string;

  harnesses: {
    /** Order = primary → fallback. Recognized ids: "claude", "pi", "gemini", "codex". */
    chain: string[];
    claude: { bin: string; model: string; fallbackModel: string };
    pi: { bin: string; maxPayloadBytes: number };
    gemini: { bin: string; model: string };
    codex?: { bin: string; model: string };
  };

  channels: {
    telegram?: TelegramAccount;
    /**
     * Optional additional Telegram bots, keyed by persona name. Each
     * entry spawns its own listener bound to the named persona, so the
     * same host can run several persona-bound bots from one process.
     * Backward compatible: configs without `[channels.telegram.personas]`
     * resolve to undefined and behave exactly as before.
     */
    telegramPersonas?: Record<string, TelegramAccount>;
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

  /**
   * Auto-retrieval (line-111 instinct). See RetrievalSettings.
   *
   * Optional on the type so ad-hoc Config constructors (tests, scripts)
   * needn't spell it out — `loadConfig` ALWAYS populates it, so production
   * code can rely on it being present. When absent (or `enabled: false`),
   * `makeRetriever` returns undefined and no retrieval is attempted: the
   * safe, side-effect-free default.
   */
  retrieval?: RetrievalSettings;

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
  const tomlCodex = (tomlHarnesses.codex ?? {}) as Record<string, unknown>;
  const tomlChannels = (toml.channels ?? {}) as Record<string, unknown>;
  const tomlTelegram = (tomlChannels.telegram ?? {}) as Record<string, unknown>;
  const tomlEmbeddings = (toml.embeddings ?? {}) as Record<string, unknown>;
  const tomlGemini = (tomlEmbeddings.gemini ?? {}) as Record<string, unknown>;
  const tomlRetrieval = (toml.retrieval ?? {}) as Record<string, unknown>;
  const tomlVoice = (toml.voice ?? {}) as Record<string, unknown>;

  return {
    defaultPersona:
      process.env.PHANTOMBOT_DEFAULT_PERSONA ??
      state.default_persona ??
      asString(toml.default_persona) ??
      "phantom",

    // Legacy alias: pre-PR-#56 configs only had `turn_timeout_s`, which
    // meant "kill at this wall-clock with no other constraints." The new
    // model splits that into idle (silence) + hard (total). To preserve
    // the OLD semantics for an unmodified legacy config we map
    // turn_timeout_s to BOTH ceilings: idle == hard == legacy value.
    // That way a `turn_timeout_s = 600` config still tolerates 10
    // minutes of silence, the way it used to. New configs that want the
    // safer 120s-idle behavior set harness_idle_timeout_s explicitly.
    harnessIdleTimeoutMs:
      asInt(process.env.PHANTOMBOT_HARNESS_IDLE_TIMEOUT_MS) ??
      (asInt(toml.harness_idle_timeout_s) !== undefined
        ? asInt(toml.harness_idle_timeout_s)! * 1000
        : undefined) ??
      legacyTurnTimeoutMs(toml) ??
      120_000,

    harnessHardTimeoutMs:
      asInt(process.env.PHANTOMBOT_HARNESS_HARD_TIMEOUT_MS) ??
      (asInt(toml.harness_hard_timeout_s) !== undefined
        ? asInt(toml.harness_hard_timeout_s)! * 1000
        : undefined) ??
      legacyTurnTimeoutMs(toml) ??
      3_600_000,

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

      codex: {
        bin:
          process.env.PHANTOMBOT_CODEX_BIN ??
          asString(tomlCodex.bin) ??
          "codex",
        // Empty string = "let codex pick its own default".
        model:
          process.env.PHANTOMBOT_CODEX_MODEL ??
          asString(tomlCodex.model) ??
          "",
      },
    },

    channels: {
      telegram: buildTelegramConfig(tomlTelegram),
      telegramPersonas: buildTelegramPersonasConfig(tomlTelegram),
    },

    embeddings: buildEmbeddingsConfig(tomlEmbeddings, tomlGemini),

    retrieval: buildRetrievalConfig(tomlRetrieval),

    voice: buildVoiceConfig(tomlVoice),
  };
}

/**
 * Resolve auto-retrieval settings. Env wins over TOML wins over defaults,
 * same precedence as everything else. Values are clamped to sane ranges so
 * a fat-fingered config can't, say, blow the token budget to infinity or
 * ask for a negative number of hits.
 */
function buildRetrievalConfig(
  tomlRetrieval: Record<string, unknown>,
): RetrievalSettings {
  const enabled =
    asBool(process.env.PHANTOMBOT_RETRIEVAL_ENABLED) ??
    asBool(tomlRetrieval.enabled) ??
    DEFAULT_RETRIEVAL.enabled;

  const limit =
    asInt(process.env.PHANTOMBOT_RETRIEVAL_LIMIT) ??
    asInt(tomlRetrieval.limit) ??
    DEFAULT_RETRIEVAL.limit;

  const maxTokens =
    asInt(process.env.PHANTOMBOT_RETRIEVAL_MAX_TOKENS) ??
    asInt(tomlRetrieval.max_tokens) ??
    DEFAULT_RETRIEVAL.maxTokens;

  const minScore =
    asNumber(process.env.PHANTOMBOT_RETRIEVAL_MIN_SCORE) ??
    asNumber(tomlRetrieval.min_score) ??
    DEFAULT_RETRIEVAL.minScore;

  return {
    enabled,
    // 1..50 mirrors MemoryIndex.search's own clamp; 0 hits would be pointless.
    limit: Math.max(1, Math.min(50, limit)),
    // Floor at 0 (disables injection); no hard ceiling — operators may
    // legitimately want a large budget, the per-turn hit count caps it anyway.
    maxTokens: Math.max(0, maxTokens),
    minScore,
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

/**
 * Map a persona name to its env-var suffix. Uppercased, with anything
 * outside [A-Z0-9] replaced by `_` so a persona like "my-bot.test"
 * resolves to `TELEGRAM_BOT_TOKEN_MY_BOT_TEST`. Matches conventional
 * shell-safe env-var naming.
 */
export function personaEnvSuffix(personaName: string): string {
  // Empty name is unreachable in practice (TOML can't express
  // `[channels.telegram.personas.]`) but guard anyway so we never
  // construct a dangling `TELEGRAM_BOT_TOKEN_` lookup.
  if (!personaName) {
    throw new Error("personaEnvSuffix: persona name must be non-empty");
  }
  return personaName.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

/**
 * Parse `[channels.telegram.personas.<name>]` blocks into a
 * persona → TelegramAccount map. Entries without a token are dropped
 * with a warning (a half-configured bot would just crash at startup).
 * Returns undefined when no per-persona bots are configured so the
 * field is genuinely optional on the resolved Config.
 *
 * Tokens may come from either TOML (`token = "..."`) or the environment
 * (`TELEGRAM_BOT_TOKEN_<PERSONA_UPPERCASE>` — same convention you'd
 * expect from a 12-factor app, and matches the default account's
 * `TELEGRAM_BOT_TOKEN` env var). Env wins over TOML so operators can
 * pin tokens in systemd unit files / .env without rewriting the
 * checked-in config.
 */
function buildTelegramPersonasConfig(
  tomlTelegram: Record<string, unknown>,
): Record<string, TelegramAccount> | undefined {
  const personas = tomlTelegram.personas;
  if (!personas || typeof personas !== "object" || Array.isArray(personas)) {
    return undefined;
  }
  const out: Record<string, TelegramAccount> = {};
  for (const [personaName, raw] of Object.entries(
    personas as Record<string, unknown>,
  )) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const envSuffix = personaEnvSuffix(personaName);
    const tokenFromEnv = process.env[`TELEGRAM_BOT_TOKEN_${envSuffix}`];
    const token = tokenFromEnv ?? asString(entry.token);
    if (!token) {
      log.warn(
        `config: channels.telegram.personas.${personaName} has no token — skipping (set TELEGRAM_BOT_TOKEN_${envSuffix} or token = "...")`,
      );
      continue;
    }
    const allowedFromEnv = process.env[
      `PHANTOMBOT_TELEGRAM_ALLOWED_USERS_${envSuffix}`
    ]
      ?.split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n));
    const pollTimeoutS = clampPollTimeout(
      asInt(process.env[`PHANTOMBOT_TELEGRAM_POLL_S_${envSuffix}`]) ??
        asInt(entry.poll_timeout_s) ??
        30,
    );
    const allowedUserIds =
      allowedFromEnv ?? asIntArray(entry.allowed_user_ids) ?? [];
    out[personaName] = { token, pollTimeoutS, allowedUserIds };
  }
  return Object.keys(out).length > 0 ? out : undefined;
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

/**
 * Path to the per-persona FTS5 + embeddings index. One file per persona so a
 * single persona can be rebuilt without touching others. Shared by
 * `phantombot memory ...` and the turn-time auto-retrieval so both read and
 * write the same index file.
 */
export function memoryIndexPath(persona: string): string {
  return join(xdgDataHome(), "phantombot", "memory-index", `${persona}.sqlite`);
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

/**
 * Parse a boolean from TOML (native bool) or env/string ("1"/"true"/"yes"/
 * "on" → true; "0"/"false"/"no"/"off" → false). Returns undefined for
 * anything unrecognized so the caller can fall through to its default.
 */
function asBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(s)) return true;
    if (["0", "false", "no", "off"].includes(s)) return false;
  }
  return undefined;
}
