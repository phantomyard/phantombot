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
import { DEFAULT_STT_TIMEOUT_MS } from "./lib/voice.ts";
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
  /**
   * Persona names that act as addressing tokens in group chats — typically
   * EVERY bot sharing a group (e.g. ["robbie", "lena", "kai"]). Used by the
   * group reply gate: a bot replies when its OWN persona name appears, and a
   * no-name message is routed to whichever bot was addressed last. Every bot
   * needs the full list so it can tell "someone else was named" (go quiet)
   * from "nobody was named" (the last-addressed bot continues). Empty =
   * gate falls back to matching only this bot's own persona name, which still
   * works in a single-bot group but can't track hand-offs between bots.
   * Matched case-insensitively on letter boundaries (so "robbie" matches in
   * "@robbie_agh_bot" and "Robbie," but not "robbiee"). Optional: omitted /
   * undefined behaves the same as an empty list.
   */
  groupPersonaNames?: string[];
}

/**
 * One Matrix account: the credentials + per-account trust perimeter for a
 * Matrix homeserver login. Mirrors `TelegramAccount` so the two channels plug
 * into the same listener / notify / screener machinery.
 *
 * NOTE on E2EE invisibility (the principal's hard requirement): there is NO
 * "enable encryption" knob here and no recovery-key field. E2EE is ALWAYS on;
 * the auto-generated recovery key lives in `~/.env` as `MATRIX_RECOVERY_KEY`
 * (per-persona suffix for persona-bound bots), never in config.toml. The
 * crypto SQLite store lives next to SOUL.md under the persona work dir
 * (`<personaDir>/matrix/`) so copying the persona dir migrates the device
 * identity + Megolm sessions wholesale. See src/channels/matrix/transport.ts.
 *
 * The password is NEVER stored — the setup wizard exchanges it for the
 * `accessToken` + `deviceId` below and discards it. Only those survive.
 */
export interface MatrixAccount {
  /** Homeserver base URL, e.g. "https://matrix.org". */
  homeserver: string;
  /** The bot's full MXID, e.g. "@robbie:matrix.org". */
  userId: string;
  /** Device id minted at login. Pinned so the same crypto identity is reused
   *  across restarts (the device the crypto store is bound to). */
  deviceId: string;
  /** Access token from the password login. Bearer credential for /sync +
   *  sends; the password it was exchanged for is discarded at setup. */
  accessToken: string;
  /**
   * If non-empty, only these MXIDs are TRUSTED principals (mirror of
   * Telegram `allowedUserIds`). An empty list means "answer anyone" but —
   * exactly as for Telegram — an open bot is NOT an authenticated principal,
   * so trust stays false and security-rule writes fail closed. Allow-listing
   * is the only thing that grants TRUSTED tier on Matrix inbound.
   */
  allowedUserIds: string[];
}

export interface TurnIndexingSettings {
  enabled: boolean;
  /** Trigger when at least this many new user turns have accrued. */
  interval: number;
  /** Max raw turn rows read from memory in one SQLite page. */
  batchSize: number;
}

export const DEFAULT_TURN_INDEXING: TurnIndexingSettings = {
  enabled: true,
  interval: 20,
  batchSize: 200,
};

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
  /** Derived index over raw conversation turns, searched alongside memory/kb. */
  turnIndexing: TurnIndexingSettings;
}

export const DEFAULT_RETRIEVAL: RetrievalSettings = {
  enabled: true,
  limit: 5,
  maxTokens: 1500,
  minScore: 0,
  turnIndexing: DEFAULT_TURN_INDEXING,
};

export interface TelegramStreamingSettings {
  /** Coalesce progress narration bubbles to at most this cadence. */
  narrationFlushMs: number;
  /** Cut final text bubbles after this many sentences when markdown-safe. */
  bubbleMaxSentences: number;
  /** Cut final text bubbles after roughly this many chars when markdown-safe. */
  bubbleMaxChars: number;
  /** Pause between final bubbles so Telegram renders them as readable bursts. */
  bubbleDelayMs: number;
  /** Split voice replies into short notes by sentence count. */
  voiceMaxSentences: number;
}

export const DEFAULT_TELEGRAM_STREAMING: TelegramStreamingSettings = {
  narrationFlushMs: 4500,
  bubbleMaxSentences: 4,
  bubbleMaxChars: 700,
  bubbleDelayMs: 800,
  voiceMaxSentences: 3,
};

/**
 * Which channel carries UNSOLICITED traffic — proactive notify, briefings,
 * task fires, AND the #172 security-hold grounding write. Replies always go
 * back on the inbound channel regardless of this; `default_channel` governs
 * only outbound-without-an-inbound. Default "telegram" for back-compat with
 * every existing single-channel install.
 */
export type DefaultChannel = "telegram" | "matrix";

export interface Config {
  /** Persona used by `ask`/`chat` when --persona is omitted. */
  defaultPersona: string;
  /**
   * Channel for unsolicited/proactive outbound + held-episode grounding
   * writes (see DefaultChannel). Optional on the type (like `retrieval`) so
   * ad-hoc Config literals in tests/scripts needn't spell it out;
   * `loadConfig` ALWAYS populates it, and callers treat an absent value as
   * "telegram" (see `resolveDefaultChannel`).
   */
  defaultChannel?: DefaultChannel;
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
    /**
     * Default Matrix account, bound to `config.defaultPersona`. Mirrors the
     * `telegram` slot. Undefined when no `[channels.matrix]` block is set, so
     * a Telegram-only install is wholly unaffected.
     */
    matrix?: MatrixAccount;
    /**
     * Per-persona Matrix accounts, keyed by persona name — the Matrix mirror
     * of `telegramPersonas`. Each spawns its own listener + crypto store.
     */
    matrixPersonas?: Record<string, MatrixAccount>;
  };

  telegramStreaming?: TelegramStreamingSettings;

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
  const tomlMatrix = (tomlChannels.matrix ?? {}) as Record<string, unknown>;
  const tomlChat = (toml.chat ?? {}) as Record<string, unknown>;
  const tomlEmbeddings = (toml.embeddings ?? {}) as Record<string, unknown>;
  const tomlGemini = (tomlEmbeddings.gemini ?? {}) as Record<string, unknown>;
  const tomlRetrieval = (toml.retrieval ?? {}) as Record<string, unknown>;
  const tomlTurnIndexing = (tomlRetrieval.turn_indexing ?? {}) as Record<
    string,
    unknown
  >;
  const tomlVoice = (toml.voice ?? {}) as Record<string, unknown>;

  return {
    defaultPersona:
      process.env.PHANTOMBOT_DEFAULT_PERSONA ??
      state.default_persona ??
      asString(toml.default_persona) ??
      "phantom",

    // Unsolicited-traffic channel. Env > [chat].default_channel > "telegram".
    // Anything unrecognized falls back to "telegram" (the safe, pre-existing
    // behaviour) rather than throwing on a fat-fingered config.
    defaultChannel: normalizeDefaultChannel(
      process.env.PHANTOMBOT_DEFAULT_CHANNEL ??
        asString(tomlChat.default_channel),
    ),

    // Legacy alias: pre-PR-#56 configs only had `turn_timeout_s`, which
    // meant "kill at this wall-clock with no other constraints." The new
    // model splits that into idle (silence) + hard (total). To preserve
    // the OLD semantics for an unmodified legacy config we map
    // turn_timeout_s to BOTH ceilings: idle == hard == legacy value.
    // That way a `turn_timeout_s = 600` config still tolerates 10
    // minutes of silence, the way it used to. New configs that want a
    // different idle window set harness_idle_timeout_s explicitly.
    //
    // Default is 300s (5 min). Modern agent turns legitimately go quiet
    // for minutes at a time — a single tool call can fan out to many
    // sub-agents, or run a long build/search — so the old 120s default
    // killed genuinely-working turns as if they were wedged. 5 min sits
    // well under the 60-min hard cap and gives real work room to breathe
    // while still catching a truly stuck subprocess.
    harnessIdleTimeoutMs:
      asInt(process.env.PHANTOMBOT_HARNESS_IDLE_TIMEOUT_MS) ??
      (asInt(toml.harness_idle_timeout_s) !== undefined
        ? asInt(toml.harness_idle_timeout_s)! * 1000
        : undefined) ??
      legacyTurnTimeoutMs(toml) ??
      300_000,

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
          state.harness_bins?.claude ??
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
          state.harness_bins?.pi ??
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
          state.harness_bins?.gemini ??
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
          state.harness_bins?.codex ??
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
      matrix: buildMatrixConfig(tomlMatrix),
      matrixPersonas: buildMatrixPersonasConfig(tomlMatrix),
    },

    telegramStreaming: buildTelegramStreamingConfig(tomlTelegram),

    embeddings: buildEmbeddingsConfig(tomlEmbeddings, tomlGemini),

    retrieval: buildRetrievalConfig(tomlRetrieval, tomlTurnIndexing),

    voice: buildVoiceConfig(tomlVoice),
  };
}

function buildTelegramStreamingConfig(
  tomlTelegram: Record<string, unknown>,
): TelegramStreamingSettings {
  const tomlStreaming = (tomlTelegram.streaming ?? {}) as Record<string, unknown>;
  return {
    narrationFlushMs: clampInt(
      asInt(process.env.PHANTOMBOT_TELEGRAM_NARRATION_FLUSH_MS) ??
        asInt(tomlStreaming.narration_flush_ms) ??
        DEFAULT_TELEGRAM_STREAMING.narrationFlushMs,
      500,
      30_000,
    ),
    bubbleMaxSentences: clampInt(
      asInt(process.env.PHANTOMBOT_TELEGRAM_BUBBLE_MAX_SENTENCES) ??
        asInt(tomlStreaming.bubble_max_sentences) ??
        DEFAULT_TELEGRAM_STREAMING.bubbleMaxSentences,
      1,
      20,
    ),
    bubbleMaxChars: clampInt(
      asInt(process.env.PHANTOMBOT_TELEGRAM_BUBBLE_MAX_CHARS) ??
        asInt(tomlStreaming.bubble_max_chars) ??
        DEFAULT_TELEGRAM_STREAMING.bubbleMaxChars,
      100,
      3500,
    ),
    bubbleDelayMs: clampInt(
      asInt(process.env.PHANTOMBOT_TELEGRAM_BUBBLE_DELAY_MS) ??
        asInt(tomlStreaming.bubble_delay_ms) ??
        DEFAULT_TELEGRAM_STREAMING.bubbleDelayMs,
      0,
      10_000,
    ),
    voiceMaxSentences: clampInt(
      asInt(process.env.PHANTOMBOT_TELEGRAM_VOICE_MAX_SENTENCES) ??
        asInt(tomlStreaming.voice_max_sentences) ??
        DEFAULT_TELEGRAM_STREAMING.voiceMaxSentences,
      1,
      20,
    ),
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
  tomlTurnIndexing: Record<string, unknown>,
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
    turnIndexing: buildTurnIndexingConfig(tomlTurnIndexing),
  };
}

function buildTurnIndexingConfig(
  tomlTurnIndexing: Record<string, unknown>,
): TurnIndexingSettings {
  const enabled =
    asBool(process.env.PHANTOMBOT_RETRIEVAL_TURN_INDEXING_ENABLED) ??
    asBool(tomlTurnIndexing.enabled) ??
    DEFAULT_TURN_INDEXING.enabled;
  const interval =
    asInt(process.env.PHANTOMBOT_RETRIEVAL_TURN_INDEXING_INTERVAL) ??
    asInt(tomlTurnIndexing.interval) ??
    DEFAULT_TURN_INDEXING.interval;
  const batchSize =
    asInt(process.env.PHANTOMBOT_RETRIEVAL_TURN_INDEXING_BATCH_SIZE) ??
    asInt(tomlTurnIndexing.batch_size) ??
    DEFAULT_TURN_INDEXING.batchSize;
  return {
    enabled,
    interval: Math.max(1, Math.min(10_000, interval)),
    batchSize: Math.max(1, Math.min(5_000, batchSize)),
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

  const sttTimeoutMs =
    asNumber(tomlVoice.stt_timeout_ms) ?? DEFAULT_STT_TIMEOUT_MS;

  if (provider === "elevenlabs") {
    const e = (tomlVoice.elevenlabs ?? {}) as Record<string, unknown>;
    return {
      provider: "elevenlabs",
      sttTimeoutMs,
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
      sttTimeoutMs,
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
      sttTimeoutMs,
      azure_edge: {
        voice: asString(a.voice) ?? "en-US-JennyNeural",
        rate: asString(a.rate) ?? "+0%",
        pitch: asString(a.pitch) ?? "+0Hz",
      },
    };
  }
  return { provider: "none", sttTimeoutMs };
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

  const groupPersonaNames =
    parseGroupPersonaNames(process.env.PHANTOMBOT_TELEGRAM_GROUP_PERSONAS) ??
    asStringArray(tomlTelegram.group_persona_names) ??
    [];

  return { token, pollTimeoutS, allowedUserIds, groupPersonaNames };
}

/**
 * Parse a comma-separated `PHANTOMBOT_TELEGRAM_GROUP_PERSONAS` env value into
 * a trimmed, non-empty string list. Returns undefined when unset so callers
 * can fall through to the TOML value.
 */
function parseGroupPersonaNames(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return names.length > 0 ? names : undefined;
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
    const groupPersonaNames =
      parseGroupPersonaNames(
        process.env[`PHANTOMBOT_TELEGRAM_GROUP_PERSONAS_${envSuffix}`],
      ) ??
      asStringArray(entry.group_persona_names) ??
      [];
    out[personaName] = {
      token,
      pollTimeoutS,
      allowedUserIds,
      groupPersonaNames,
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Normalize an arbitrary string to a DefaultChannel; default "telegram". */
function normalizeDefaultChannel(raw: string | undefined): DefaultChannel {
  return raw === "matrix" ? "matrix" : "telegram";
}

/**
 * The single place consumers read `default_channel`. Absent (ad-hoc Config
 * literal) → "telegram", the pre-existing behaviour. Keeps the `?? "telegram"`
 * default from being copy-pasted across notify / heartbeat / screen routing.
 */
export function resolveDefaultChannel(config: Config): DefaultChannel {
  return config.defaultChannel ?? "telegram";
}

/**
 * Build the default `[channels.matrix]` account from TOML + env. Mirrors
 * buildTelegramConfig: returns undefined when the block has no usable login
 * (no homeserver / userId / accessToken), so a Matrix-less install resolves
 * to `channels.matrix === undefined` exactly like before.
 *
 * The access token + device id are written by the setup wizard
 * (`phantombot chat matrix`); the env overrides exist so they can be pinned
 * in systemd EnvironmentFile / ~/.env without rewriting config.toml.
 */
function buildMatrixConfig(
  tomlMatrix: Record<string, unknown>,
): MatrixAccount | undefined {
  const homeserver =
    process.env.MATRIX_HOMESERVER ?? asString(tomlMatrix.homeserver);
  const userId = process.env.MATRIX_USER_ID ?? asString(tomlMatrix.user_id);
  const deviceId =
    process.env.MATRIX_DEVICE_ID ?? asString(tomlMatrix.device_id);
  const accessToken =
    process.env.MATRIX_ACCESS_TOKEN ?? asString(tomlMatrix.access_token);
  // A Matrix account needs all four to function; anything less is "not
  // configured" rather than a half-built bot that crashes at /sync.
  if (!homeserver || !userId || !deviceId || !accessToken) return undefined;

  const allowedFromEnv = process.env.MATRIX_ALLOWED_USERS
    ?.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const allowedUserIds =
    allowedFromEnv ?? asStringArray(tomlMatrix.allowed_user_ids) ?? [];

  return { homeserver, userId, deviceId, accessToken, allowedUserIds };
}

/**
 * Parse `[channels.matrix.personas.<name>]` blocks into a persona →
 * MatrixAccount map. The Matrix mirror of buildTelegramPersonasConfig: entries
 * missing any of the four required fields are dropped with a warning. Env
 * tokens follow the same `MATRIX_ACCESS_TOKEN_<PERSONA_UPPERCASE>` convention
 * as Telegram's per-persona tokens.
 */
function buildMatrixPersonasConfig(
  tomlMatrix: Record<string, unknown>,
): Record<string, MatrixAccount> | undefined {
  const personas = tomlMatrix.personas;
  if (!personas || typeof personas !== "object" || Array.isArray(personas)) {
    return undefined;
  }
  const out: Record<string, MatrixAccount> = {};
  for (const [personaName, raw] of Object.entries(
    personas as Record<string, unknown>,
  )) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const envSuffix = personaEnvSuffix(personaName);
    const homeserver =
      process.env[`MATRIX_HOMESERVER_${envSuffix}`] ??
      asString(entry.homeserver);
    const userId =
      process.env[`MATRIX_USER_ID_${envSuffix}`] ?? asString(entry.user_id);
    const deviceId =
      process.env[`MATRIX_DEVICE_ID_${envSuffix}`] ?? asString(entry.device_id);
    const accessToken =
      process.env[`MATRIX_ACCESS_TOKEN_${envSuffix}`] ??
      asString(entry.access_token);
    if (!homeserver || !userId || !deviceId || !accessToken) {
      log.warn(
        `config: channels.matrix.personas.${personaName} is missing homeserver/user_id/device_id/access_token — skipping (run \`phantombot chat matrix\` to set it up)`,
      );
      continue;
    }
    const allowedFromEnv = process.env[`MATRIX_ALLOWED_USERS_${envSuffix}`]
      ?.split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const allowedUserIds =
      allowedFromEnv ?? asStringArray(entry.allowed_user_ids) ?? [];
    out[personaName] = { homeserver, userId, deviceId, accessToken, allowedUserIds };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function clampPollTimeout(s: number): number {
  if (!Number.isFinite(s)) return 30;
  return Math.max(1, Math.min(50, Math.floor(s)));
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
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
 * The Matrix rust-crypto SQLite store directory for a persona — DELIBERATELY
 * next to SOUL.md, under the persona work dir (`<personaDir>/matrix/`), not in
 * a global XDG cache. This is the migration contract: the store holds the
 * device identity + Olm/Megolm sessions, so copying the persona dir to a new
 * VM carries the SAME device with it (no re-verification, no lost history).
 * `cryptoDatabasePrefix` passed to `MatrixClient.initRustCrypto` points here.
 * Reuses `personaDir` so it tracks any future change to persona-dir resolution.
 */
export function matrixCryptoStoreDir(config: Config, persona: string): string {
  return join(personaDir(config, persona), "matrix");
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
