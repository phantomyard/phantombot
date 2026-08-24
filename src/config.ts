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
import {
  asUpdateChannel,
  DEFAULT_UPDATE_CHANNEL,
  type UpdateChannel,
} from "./lib/githubReleases.ts";
import {
  ENV_CODING_MODEL,
  ENV_IMAGE_MODEL,
  ENV_PI_PROVIDER,
  ENV_PRIMARY_MODEL,
  type PiRoutingConfig,
  resolveRouting,
} from "./lib/piRouting.ts";
import { DEFAULT_STT_TIMEOUT_MS } from "./lib/voice.ts";
import {
  mergeToml,
  readPersonaToml,
  stripHostOnlyKeys,
} from "./lib/personaConfig.ts";
import type { TomlObject } from "./lib/configWriter.ts";
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
/**
 * One-shot deprecation warning for the retired pi `max_payload_bytes` /
 * `PHANTOMBOT_PI_MAX_PAYLOAD` knob. Module-scoped flag so repeated loadConfig
 * calls (tests, reloads) don't spam.
 */
let piMaxPayloadWarnLogged = false;
function warnPiMaxPayloadDeprecated(): void {
  if (piMaxPayloadWarnLogged) return;
  piMaxPayloadWarnLogged = true;
  log.warn(
    "config: pi max_payload_bytes / PHANTOMBOT_PI_MAX_PAYLOAD is deprecated and ignored — pi now streams its payload via temp files with no size ceiling, so the fallback never refuses a turn for size. Remove the setting; it has no effect.",
  );
}

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
 * The 5 default public relays the PhantomChat PWA uses. phantombot must share
 * relays with Andrew's PWA for a DM to reach it, so these are the defaults when
 * a persona's `phantomchat.json` omits `relays`.
 *
 * NOTE: phantomchat identity + settings are now PER-PERSONA and live in
 * `<persona-dir>/phantomchat.json` (see channels/phantomchat/personaStore.ts),
 * NOT in config.toml. There is intentionally no `[channels.phantomchat]` block.
 */
export const DEFAULT_PHANTOMCHAT_RELAYS: readonly string[] = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://nostr.mom",
  "wss://nostr.data.haus",
];

export interface TurnIndexingSettings {
  enabled: boolean;
  /** Trigger when at least this many new user turns have accrued. */
  interval: number;
  /** Max raw turn rows read from memory in one SQLite page. */
  batchSize: number;
  /**
   * Time-based safety net. Flush a conversation's unindexed tail when its
   * oldest unindexed turn has aged past this many hours, even if the
   * user-turn count hasn't reached `interval`. This drains sub-threshold
   * tails (e.g. a conversation stuck at 19 turns) so recent chat stays
   * semantically recallable instead of going invisible for days. The live
   * service only flushes on a new message crossing the batch; the 30-min
   * heartbeat applies this time-based drain across all conversations. Set
   * to 0 to disable the time-based flush (count trigger only).
   */
  flushAfterHours: number;
  /**
   * Self-healing budget for turns that reached the FTS index but whose
   * embedding call failed (a 429, a network blip, a provider outage). Those
   * turns sit *behind* the `lastTurnId` cursor, so no cursor-driven path —
   * the batch trigger, the age flush, the sweep, not even
   * `memory index --turns --force` — will ever look at them again. They stay
   * lexical-only forever, silently, and embed failures arrive in bursts, so a
   * bad ten minutes permanently demotes every turn in that window.
   *
   * Each sweep re-embeds up to this many such turns, found by a cursor-free
   * scan for FTS rows with no embedding row. Set to 0 to disable the repair.
   */
  repairBatchSize: number;
}

export const DEFAULT_TURN_INDEXING: TurnIndexingSettings = {
  enabled: true,
  // Tight batch so an early-established fact (a procedure, a connection string)
  // becomes semantically recallable within a few user turns instead of after
  // 20 — the window where it has scrolled past the verbatim history but isn't
  // yet indexed is the mechanical cause of "forgot mid-conversation, remembered
  // when nudged". Cheap: each flush is sha-deduped, so only the growing tail
  // costs an embed call.
  interval: 3,
  batchSize: 200,
  // Align the time-based safety net with the 30-min heartbeat cadence so a
  // quiet sub-threshold tail is never more than ~30 min from being recallable.
  flushAfterHours: 0.5,
  repairBatchSize: 32,
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
  /**
   * OKF link-graph expansion for the no-embeddings (BM25-only) path. When a
   * persona has no Gemini key, fielded BM25 hits are augmented with concepts
   * reachable via markdown links from those hits — the keyword-only stand-in
   * for semantic spread. Ignored when embeddings are configured (the hybrid
   * vector path is used instead, so Gemini users are unaffected).
   */
  graphExpansion: GraphExpansionSettings;
  /**
   * Time-decay on raw conversation-turn hits. Ranking has no clock of its own —
   * BM25 + RRF are purely relevance-based, so a stale turn that lexically
   * matches (e.g. a superseded infra note repeated in old chat) competes with a
   * fresh correction on equal footing and can win forever. Decay multiplies a
   * turn hit's score by `0.5^(ageDays/halfLifeDays)` (floored), so old turns
   * sink no matter how strongly they match. Applies ONLY to `turns` scope —
   * curated memory/ + kb/ notes are immune (factor 1.0) and never age out, so
   * rarely-recalled-but-important runbooks survive for years. There is no
   * refresh-on-recall by design: a ghost is recalled *because* it matches, so
   * bumping it on recall would keep it alive — the opposite of the goal.
   */
  decay: RetrievalDecaySettings;
  /**
   * Tier-2 cross-conversation (persona-scoped) retrieval. Defaults ON —
   * see CrossConversationRetrievalSettings.
   */
  crossConversation: CrossConversationRetrievalSettings;
}

/** Time-decay knobs for raw conversation-turn hits (curated notes are immune). */
export interface RetrievalDecaySettings {
  /** Master switch. When false, turn hits are ranked without any time-decay. */
  enabled: boolean;
  /**
   * Half-life in days for a turn hit's relevance score. After this many days a
   * turn's score is halved; after 2× it is quartered; etc. Lower = turns age
   * out faster. Only affects `turns` scope. `<= 0` disables decay (factor 1).
   */
  halfLifeDays: number;
  /**
   * Lower bound on the decay multiplier so a very old turn's score is damped
   * but never driven to exactly 0 — it stays a tie-broken last resort rather
   * than vanishing. 0..1; 0 lets ancient turns decay to nothing.
   */
  floor: number;
}

/** OKF link-graph expansion knobs (BM25-only retrieval path). */
export interface GraphExpansionSettings {
  /** Master switch for graph expansion on the FTS-only path. */
  enabled: boolean;
  /** Hops to walk out from each lexical hit. */
  hops: number;
  /** Max neighbour concepts to fold in per retrieval. */
  maxAdd: number;
}

export const DEFAULT_GRAPH_EXPANSION: GraphExpansionSettings = {
  enabled: true,
  hops: 1,
  maxAdd: 3,
};

export const DEFAULT_RETRIEVAL_DECAY: RetrievalDecaySettings = {
  enabled: true,
  // 30 days: raw chat history a month old is worth about half a fresh turn.
  // Long enough that this-week's context is barely touched; short enough that
  // a months-old ghost is effectively dead (180d → 0.5^6 ≈ 0.016 × floor).
  halfLifeDays: 30,
  // Keep a sliver so an ancient turn is a last-resort tie-break, not erased.
  floor: 0.02,
};

/**
 * Cross-conversation (persona-scoped) retrieval — tier 2 of auto-retrieval.
 *
 * The problem it solves: auto-retrieval was scoped to the CURRENT
 * conversation only (PR #132, leak fix), so knowledge earned in one chat
 * (say, a tricky fix worked out in a Telegram DM) never surfaced when a
 * similar problem came up days later in another chat (PhantomChat, an ACP
 * session). The persona had the memory; retrieval couldn't reach it without
 * a conscious `memory search` — and you can't search for what you don't
 * remember exists.
 *
 * Tier 2 widens the net to the whole persona, with guardrails that keep it
 * a supplement, never a flood: a higher relevance bar than in-conversation
 * hits, a hard per-turn cap, source attribution on every hit, and a
 * prompt-level disclosure rule (inform the reply, never quote the excerpt
 * or name the chat it came from). See orchestrator/retrieval.ts.
 *
 * DEFAULTS TO ON when the flag is absent — deliberate anti-config-fatigue
 * choice: the right behaviour out of the box, no knob to babysit. The flag
 * exists purely as an escape hatch for genuinely sensitive setups.
 */
export interface CrossConversationRetrievalSettings {
  /**
   * Master switch for tier-2 (cross-conversation) hits. DEFAULT true —
   * including when the whole [retrieval.cross_conversation] table is absent.
   * Set false to restore strict per-conversation retrieval (PR #132
   * behaviour).
   */
  enabled: boolean;
  /**
   * Hard cap on cross-conversation hits injected per turn, appended AFTER
   * in-conversation hits so they can never displace tier 1. 0 disables
   * tier 2 without touching the flag.
   */
  limit: number;
  /**
   * Absolute tier-2 relevance floor on the BM25 score. Rank-fused scores
   * (RRF) encode position within a result set, not relevance, so the bar
   * must be absolute — and it must be non-zero by default, or an empty
   * tier 1 would inject any cross-conversation turn that matched FTS at
   * all (Robert's PR #378 review). Default 2.0: sampled against a live
   * 4,353-turn index, incidental single-common-token matches score ≈ 0
   * while genuine single-term matches score ≈ 4+.
   */
  minScore: number;
  /**
   * Cosine floor for the vector leg of the tier-2 gate. NOTE: cosine is
   * never sufficient on its own — a vector hit must ALSO share at least
   * one query term (raw BM25 > 0). The gate is applied to the MAXIMUM
   * over the whole persona index, whose distribution is dominated by
   * register/boilerplate similarity: on a live 4k-turn
   * gemini-embedding-001 index, 79% of arbitrary queries had a
   * cross-conversation turn above 0.85 on cosine alone, and the hits were
   * shared phrasing, not knowledge (PR #378 review). No absolute value
   * calibrated against random-pair marginals (p50 0.65 / p90 0.75 /
   * p99 0.89) is safe as a standalone bar; 0.85 WITH lexical support
   * keeps genuine paraphrase matches while rejecting shared phrasing.
   */
  minVecScore: number;
  /**
   * Channels/conversations excluded from tier 2 in BOTH directions: their
   * turns never surface in other chats, and no cross-conversation hits are
   * injected when they are the current conversation. Entries match a full
   * conversation key ("phantomchat:group:abc123") or a channel prefix
   * ("telegram" matches every telegram:* conversation). The sensitive-DM
   * escape hatch.
   */
  exclude: string[];
}

export const DEFAULT_CROSS_CONVERSATION: CrossConversationRetrievalSettings = {
  enabled: true,
  limit: 3,
  minScore: 2.0,
  minVecScore: 0.85,
  exclude: [],
};

export const DEFAULT_RETRIEVAL: RetrievalSettings = {
  enabled: true,
  limit: 5,
  maxTokens: 1500,
  minScore: 0,
  turnIndexing: DEFAULT_TURN_INDEXING,
  graphExpansion: DEFAULT_GRAPH_EXPANSION,
  decay: DEFAULT_RETRIEVAL_DECAY,
  crossConversation: DEFAULT_CROSS_CONVERSATION,
};

/**
 * Durable-facts settings (PhantomOps-style, adapted). Two halves:
 *
 *   WRITE (extract-at-cliff): when a turn ages out of the ~30-turn live
 *   window, an out-of-band temp-0 pass on the PRIMARY harness pulls durable
 *   facts out of it BEFORE it is lost, and stores them in the `durable_facts`
 *   table. Non-blocking — it never delays the interactive reply.
 *
 *   READ (inject-every-prompt): at prompt-assembly time a plain SQL SELECT
 *   pulls the top facts for this persona/conversation (confidence + recency)
 *   into the system prompt. No model call on the read path.
 *
 * Optional on Config (like retrieval): `loadConfig` always populates it, but
 * ad-hoc test configs may omit it, in which case the `make*` factories return
 * undefined and neither half runs.
 */
/**
 * Provenance of a durable fact — WHO asserted it, which sets how much we trust
 * it and how fast it goes stale. Derived at turn-append time (orchestrator/
 * turn.ts) from the turn's role + trust bit, carried onto the fact:
 *   - `principal` — the owner said it in a trusted turn. Highest trust, slowest
 *     decay: a standing fact the owner gave us holds until they correct it.
 *   - `self`      — a first-hand observation the persona has EARNED trust in:
 *     the default assistant turn no longer lands here (see `unverified`); a fact
 *     reaches `self` only when it was promoted — e.g. re-asserted after the
 *     principal engaged with it. Trust the sighting, but decay it fast: infra
 *     state churns, so a stale reading must not masquerade as current.
 *   - `unverified` — the persona's OWN assistant turn by default. The harness
 *     reply is a mix of the persona's reasoning and whatever untrusted bytes a
 *     tool (curl, gog, headless chrome, exec) pulled in mid-turn, and we cannot
 *     tell them apart at the turn layer — so nothing the persona emits is
 *     trusted first-hand until the principal engages with it. Low trust, short
 *     life; promoted to `principal` when the owner discusses/confirms it, else
 *     it decays and retires. This is the #327 fix: fail-closed by construction,
 *     no allowlist, no fetch-detection, no self-declaring tools.
 *   - `other`     — anyone else in a shared/group conversation (another agent,
 *     a third party). Lowest trust, shortest life: heard in a room, not told to
 *     us one-on-one.
 */
export type FactSource = "principal" | "self" | "other" | "unverified";

export const FACT_SOURCES: readonly FactSource[] = [
  "principal",
  "self",
  "other",
  "unverified",
] as const;

/**
 * The three knobs that make persona-scoping a fact SAFE. Without them, merging
 * every conversation's facts into one persona pool would let a group member's
 * claim land in the owner's private pool at equal weight (the trust-bleed we
 * flagged in design). Each tier ranks, decays, and retires on its own clock.
 */
export interface FactSourceTier {
  /** Ranking multiplier on confidence. principal ≥ self ≥ other. */
  weight: number;
  /** Decay half-life in days: score halves every `halfLifeDays` unseen. */
  halfLifeDays: number;
  /**
   * Retirement floor: a fact not re-seen/re-injected for longer than this is
   * PRUNED (hard-deleted) out of band. Any recall refreshes `last_seen_at`, so
   * only genuinely-unused facts age out — a yearly-reviewed procedure the owner
   * gave us (principal, 365d) survives to its next natural use, while a
   * transient self-observation retires quickly.
   */
  maxAgeDays: number;
}

export type FactSourceTiers = Record<FactSource, FactSourceTier>;

export interface DurableFactsSettings {
  /** Master switch for BOTH the extract and inject halves. */
  enabled: boolean;
  /** Max facts injected into the system prompt per turn (read path). */
  maxInjected: number;
  /** Only inject facts at or above this confidence (0..1). */
  minConfidence: number;
  /** Max evicted turns extracted from in one out-of-band pass. */
  maxExtractPerTurn: number;
  /**
   * Per-source provenance tiers (ranking weight, decay half-life, retirement
   * age). The read path scores every candidate as
   * `weight · confidence · 2^(-ageDays / halfLifeDays)` and drops anything
   * under `injectFloor`; the write path prunes anything past its tier's
   * `maxAgeDays`.
   */
  tiers: FactSourceTiers;
  /**
   * Minimum decay-adjusted score for a fact to be injected. Keeps a deeply
   * decayed or low-trust fact from surfacing even when the prompt has room.
   */
  injectFloor: number;
  /**
   * Verbose per-fact logging on the extract / inject / prune paths, for
   * dogfooding the provenance+decay model (e.g. on Lena) before trusting it.
   * Off by default; flip on with PHANTOMBOT_DURABLE_FACTS_DEBUG=1.
   */
  debug: boolean;
  /**
   * Crash-recovery lease window (ms) for a claimed-but-not-yet-committed turn.
   * If the pass that claimed a turn dies without committing or releasing it,
   * the lease expires after this long and the turn becomes re-claimable. The
   * common failure (harness reject/timeout) releases immediately and does not
   * wait this out; only a hard process crash does.
   *
   * MUST outlast a full harness extraction, or a slow-but-successful pass would
   * have its lease expire mid-call and let a concurrent pass re-claim the same
   * turn — a duplicate model call plus a stale late write (Kai, PR #320).
   * buildDurableFactsConfig floors this at harnessHardTimeoutMs plus a commit
   * margin, so only a genuine crash (which never finishes) can hit expiry.
   */
  leaseMs: number;
}

/**
 * Safety margin (ms) added on top of the harness hard timeout when flooring
 * leaseMs — covers the commit/release write that runs AFTER a slow extraction
 * returns, so the lease can't lapse in the gap between the harness completing
 * and the commit landing.
 */
export const LEASE_COMMIT_MARGIN_MS = 300_000;

/**
 * Default provenance tiers. Half-lives and retirement ages encode the trust
 * model agreed in design: the owner's standing facts live ~a year (a procedure
 * reviewed once a year must not be forgotten just because it's rarely recalled),
 * the persona's own observations rot in a quarter (infra state churns), and
 * overheard third-party claims fade fastest.
 */
export const DEFAULT_FACT_TIERS: FactSourceTiers = {
  principal: { weight: 1.0, halfLifeDays: 180, maxAgeDays: 365 },
  self: { weight: 0.6, halfLifeDays: 30, maxAgeDays: 90 },
  other: { weight: 0.3, halfLifeDays: 7, maxAgeDays: 30 },
  // The persona's own default output. Weight sits at `other`'s level — untrusted
  // until the principal engages — but with a slightly longer life (14d/60d vs
  // 7d/30d): it is the persona's OWN work product, so a genuinely useful
  // procedure gets a fair window to be confirmed and promoted before it retires,
  // without ever masquerading as first-hand `self` (0.6) knowledge in the mean
  // time. Injected tagged `unverified`, never recall-bumped (see durableFacts).
  unverified: { weight: 0.3, halfLifeDays: 14, maxAgeDays: 60 },
};

export const DEFAULT_DURABLE_FACTS: DurableFactsSettings = {
  enabled: true,
  maxInjected: 8,
  minConfidence: 0.5,
  maxExtractPerTurn: 4,
  tiers: DEFAULT_FACT_TIERS,
  injectFloor: 0.05,
  debug: false,
  // Default harness hard timeout (3_600_000) + LEASE_COMMIT_MARGIN_MS. Kept
  // self-consistent with the default hard timeout so even a Config assembled
  // without buildDurableFactsConfig (e.g. an ad-hoc test) is race-safe;
  // buildDurableFactsConfig re-enforces the floor against the ACTUAL timeout.
  leaseMs: 3_900_000,
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

/**
 * Standing default for interim progress-narration bubbles whenever no
 * `chattiness` key is set — regardless of whether a `config.toml` exists.
 * ON so every phantom narrates by default: the running commentary keeps the
 * agent anchored across long tool-heavy runs (empirically it holds the thread
 * better and produces more reliable work on large tasks), and an operator can
 * always quiet it via `chattiness = false` or `/chattiness off`. Also the
 * fallback used by read sites given a partial config. See lib/chattiness.ts.
 */
export const DEFAULT_CHATTINESS = true;

export const DEFAULT_TELEGRAM_STREAMING: TelegramStreamingSettings = {
  narrationFlushMs: 4500,
  bubbleMaxSentences: 4,
  bubbleMaxChars: 700,
  bubbleDelayMs: 800,
  voiceMaxSentences: 3,
};

export interface Config {
  /** Persona used by `ask`/`chat` when --persona is omitted. */
  defaultPersona: string;
  /**
   * Personas that get their channels started at boot ALONGSIDE the default
   * persona (phantombot#439). Host-level: it lives in the global config.toml,
   * never in a persona file.
   *
   * Explicit list, never inferred from what happens to be on disk — an
   * imported or archived persona must not start talking to the world because
   * its directory exists. Empty (or absent) means exactly the old behaviour:
   * the default persona only. The default persona is always started and is
   * filtered out of this list, so listing it is harmless.
   *
   * Optional on the type (mirrors `updateChannel`) so partial test fixtures
   * need no update; `loadConfig` always populates it and read sites treat
   * absence as [].
   */
  autostartPersonas?: string[];
  /**
   * The persona whose `<persona>/config.toml` layer was merged into this
   * object, when any. `loadConfig()` sets it to the default persona;
   * `loadConfigForPersona(name)` sets it to `name`. Undefined only in
   * hand-built test fixtures.
   */
  personaLayer?: string;
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
  /**
   * Cap on time-to-first-output for a foreground harness turn. A subprocess
   * that emits nothing at all (classically `claude --print` wedged on its MCP
   * `initialize` handshake) would otherwise idle for the full
   * harnessIdleTimeoutMs before failing over. This bounds the startup phase
   * separately so the orchestrator advances to the next harness in seconds.
   * Set generously (default 60s) so a healthy-but-slow cold start under load —
   * the same contention that triggers the wedge — is never false-killed.
   */
  harnessStartupTimeoutMs: number;
  /** Directory holding `<persona>/` subdirs. */
  personasDir: string;
  /** Path to the SQLite memory store file. */
  memoryDbPath: string;
  /** Path to the config file we loaded (whether it existed or not). */
  configPath: string;

  harnesses: {
    /** Order = primary → fallback. Recognized ids: "claude", "pi", "codex". */
    chain: string[];
    /**
     * Optional chain overrides keyed by persona name. A persona without an
     * entry uses the global `chain` above.
     */
    personas?: Record<string, { chain: string[] }>;
    /**
     * Harness ids whose `bin` was stated by THIS persona's own config.toml
     * (phantombot#441). Everything else in the block is persona-scoped by
     * value, but a `bin` is normally a property of the machine — so the daemon
     * re-imposes the host's probed paths on a persona layer
     * (`withHostHarnessBins`) EXCEPT for the ids listed here, which the
     * operator pinned deliberately. Absent/empty = nothing pinned.
     */
    ownBins?: string[];
    claude: { bin: string; model: string; fallbackModel: string };
    pi: {
      bin: string;
      /**
       * @deprecated Retired and IGNORED. Pi now always streams its payload via
       * temp files, so there is no argv-length ceiling and the fallback never
       * refuses a turn for size. Kept as an optional field only so a stale
       * config object still type-checks; nothing reads it. See warnPiMaxPayloadDeprecated.
       */
      maxPayloadBytes?: number;
      /**
       * Capability routing (distinct from the failover `chain`). When set, the
       * bundled Pi extension delegates vision/coding subtasks to specialist
       * models. See lib/piRouting.ts for the env-var contract. Optional: absent
       * = no per-capability routing (Pi uses its configured default model).
       */
      routing?: import("./lib/piRouting.ts").PiRoutingConfig;
    };
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
    // phantomchat (Nostr NIP-17 DM) is configured PER-PERSONA in
    // `<persona-dir>/phantomchat.json` (channels/phantomchat/personaStore.ts),
    // not here — so it has no config.toml block.
  };

  telegramStreaming?: TelegramStreamingSettings;

  /**
   * Standing default for interim "progress narration" bubbles in the chat
   * channels (Telegram + PhantomChat). `true` = stream the running commentary
   * ("checking your calendar…"); `false` = quiet, final reply only. A
   * per-conversation `/chattiness` override wins over this default; the final
   * reply and error paths are never affected either way. When unset in config
   * — no `chattiness` key, an empty file, or no `config.toml` at all — the
   * default is `true` (narrate), so every phantom keeps the agent anchored on
   * long runs until an operator opts out. Also gates the editor (ACP)
   * surface's pre-tool narration — the config default only. See
   * lib/chattiness.ts. Optional in the type (mirrors telegramStreaming?) so
   * partial test fixtures need no update; loadConfig always sets it, and read
   * sites default to `true` (DEFAULT_CHATTINESS) when absent.
   */
  chattiness?: boolean;

  /**
   * Release ring this HOST follows (#432): "stable" (default) or "preview".
   *
   * Host-level, not per-persona, because it selects which BINARY the box
   * installs — every persona on a host necessarily runs the same one.
   * "preview" picks up every merge to main; "stable" only moves when a
   * human presses the promote button on a release. See lib/githubReleases.ts.
   *
   * Optional on the type so partial test fixtures need no update; loadConfig
   * always populates it, and read sites default to DEFAULT_UPDATE_CHANNEL.
   */
  updateChannel?: UpdateChannel;

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

  /**
   * Durable facts (extract-at-cliff + inject-every-prompt). See
   * DurableFactsSettings. Optional on the type so ad-hoc Config constructors
   * needn't spell it out — `loadConfig` ALWAYS populates it. When absent (or
   * `enabled: false`), `makeFactExtractor`/`makeDurableFactPuller` return
   * undefined and neither half runs.
   */
  durableFacts?: DurableFactsSettings;

  voice: import("./lib/voice.ts").VoiceConfig;

  /**
   * P2P transport (phantombot#258, rewritten in #61): werift WebRTC channels to
   * peer nodes, NAT-traversed via public STUN, with Nostr carrying only the
   * signaling handshake and acting as the delivery fallback. On by default;
   * inbound frames terminate in the persona's phantomchat channel and replies
   * tee back over WebRTC. No ws/localhost bridge (retired in #61). See
   * P2PSettings and buildP2PConfig.
   *
   * Optional on the type (so partial test configs need not spell it out), but
   * `loadConfig` always populates it; consumers treat absence as `DEFAULT_P2P`.
   */
  p2p?: P2PSettings;
}

/** Settings for the P2P WebRTC transport node (phantombot#258, #61). */
export interface P2PSettings {
  /** Master switch. Default true — P2P is on by default (phantombot#267). */
  enabled: boolean;
  /**
   * Public STUN servers for NAT traversal. STUN only reflects your public
   * IP:port back — it never relays media — so using public STUN keeps the
   * "no infrastructure of ours" constraint intact. Empty = host candidates
   * only (LAN works; remote NAT traversal won't).
   */
  stunServers: string[];
}

export const DEFAULT_P2P: P2PSettings = {
  enabled: true,
  // Google's public STUN — reflexive-only, no relaying, no infra of ours.
  stunServers: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"],
};

/**
 * XDG base-directory resolution, identical on every platform. Windows uses
 * the same home-relative layout as Linux/macOS so a persona's on-disk tree is
 * portable across machines: `~/.config/phantombot`, `~/.local/share/phantombot`
 * and `~/.local/state/phantombot` (on Windows `~` is the `%USERPROFILE%` root,
 * e.g. `C:\Users\<you>\.local\share\phantombot`). The `XDG_*` env vars still
 * take precedence everywhere, so an explicit override remains the escape hatch.
 */
export function xdgConfigHome(): string {
  if (process.env.XDG_CONFIG_HOME) return process.env.XDG_CONFIG_HOME;
  return join(homedir(), ".config");
}
export function xdgDataHome(): string {
  if (process.env.XDG_DATA_HOME) return process.env.XDG_DATA_HOME;
  return join(homedir(), ".local", "share");
}
export function xdgStateHome(): string {
  if (process.env.XDG_STATE_HOME) return process.env.XDG_STATE_HOME;
  return join(homedir(), ".local", "state");
}

const DEFAULT_HARNESS_CHAIN = ["claude"] as const;

/**
 * Merge a persona's own TOML over the host globals, with the two corrections
 * the plain deep-merge cannot make on its own.
 *
 * 1. A persona's own `[harnesses].chain` must beat the LEGACY
 *    `[harnesses.personas.<name>].chain` entry. Migration copies rather than
 *    deletes (so a rollback still boots), which means both descriptions of the
 *    same persona live on forever; `harnessChainIds` reads the legacy table
 *    first, so without this the persona's own file could never take effect and
 *    editing it would silently do nothing. The persona's own entry is dropped
 *    from the merged legacy table only when the persona file actually states a
 *    chain — an unmigrated host keeps the legacy entry and behaves exactly as
 *    it did before.
 *
 * 2. A NON-DEFAULT persona never inherits the global `[channels.telegram]`
 *    account — not even key by key. That block is the DEFAULT persona's bot;
 *    handing it to a second persona would put two listeners on one token,
 *    which planListeners (rightly) refuses to start. Its account is therefore
 *    REBUILT, not merged: its legacy `[channels.telegram.personas.<name>]`
 *    entry first, then its own `[channels.telegram]` table on top, and no
 *    Telegram at all when it has neither. A persona file stating only part of
 *    an account (an allowlist but no token) is incomplete, not a licence to
 *    borrow the host's token.
 *
 * Everything else is the ordinary per-key deep merge: persona wins, absent
 * keys fall back to the global file, never to a constant.
 */
export function applyPersonaLayer(
  globalToml: TomlObject,
  personaToml: TomlObject,
  opts: { persona: string; isDefault: boolean },
): TomlObject {
  const merged = mergeToml(globalToml, personaToml);

  const personaHarnesses = personaToml.harnesses;
  const statesOwnChain =
    isTomlTable(personaHarnesses) && Array.isArray(personaHarnesses.chain);
  if (statesOwnChain) {
    const harnesses = merged.harnesses;
    if (isTomlTable(harnesses) && isTomlTable(harnesses.personas)) {
      const { [opts.persona]: _legacy, ...rest } = harnesses.personas;
      merged.harnesses = { ...harnesses, personas: rest };
    }
  }

  if (!opts.isDefault) {
    const channels = merged.channels;
    if (isTomlTable(channels)) {
      // NEVER start from the merged account: `mergeToml` has already folded the
      // GLOBAL `[channels.telegram]` (the default persona's bot) into it, so a
      // persona file stating only `allowed_user_ids` would otherwise resolve to
      // the default token with this persona's allowlist — two listeners on one
      // token, or worse, this persona answering on the owner's bot. Build the
      // account from scratch out of the only two sources that describe THIS
      // persona: its legacy routing entry, then its own file on top.
      const telegram = channels.telegram;
      const globalRouting =
        isTomlTable(telegram) && isTomlTable(telegram.personas)
          ? telegram.personas
          : undefined;
      const legacyEntry =
        globalRouting && isTomlTable(globalRouting[opts.persona])
          ? (globalRouting[opts.persona] as TomlObject)
          : undefined;
      const personaChannels = personaToml.channels;
      const ownTelegram =
        isTomlTable(personaChannels) && isTomlTable(personaChannels.telegram)
          ? personaChannels.telegram
          : undefined;
      // The routing table stays visible either way: planListeners still reads
      // it to plan the legacy listeners of OTHER personas.
      const routing =
        (ownTelegram && isTomlTable(ownTelegram.personas)
          ? ownTelegram.personas
          : undefined) ?? globalRouting;

      let account: TomlObject | undefined;
      if (legacyEntry || ownTelegram) {
        account = { ...(legacyEntry ?? {}), ...(ownTelegram ?? {}) };
        delete account.personas;
      }

      const nextChannels: TomlObject = { ...channels };
      if (account) {
        nextChannels.telegram = {
          ...account,
          ...(routing ? { personas: routing } : {}),
        };
      } else if (routing) {
        nextChannels.telegram = { personas: routing };
      } else {
        delete nextChannels.telegram;
      }
      merged.channels = nextChannels;
    }
  }

  return merged;
}

function isTomlTable(v: unknown): v is TomlObject {
  return typeof v === "object" && v !== null && !Array.isArray(v) &&
    !(v instanceof Date);
}



/**
 * Load the effective config for ONE persona.
 *
 * Two layers, merged per key, persona wins:
 *   1. the host's global config.toml (paths, harness bins, default persona)
 *   2. `<personas-root>/<persona>/config.toml` (that persona's own settings)
 *
 * Env vars are applied after both and still win over everything, so
 * `PHANTOMBOT_*` remains the top of the precedence order it has always been.
 *
 * A key the persona file does not mention falls back to the GLOBAL FILE, not
 * to a built-in default. An unmigrated host therefore behaves exactly as it
 * did before this existed: no persona file, empty layer, identical config.
 *
 * @param persona persona whose layer to apply. Omit for the default persona.
 */
export async function loadConfig(persona?: string): Promise<Config> {
  const configPath =
    process.env.PHANTOMBOT_CONFIG ??
    join(xdgConfigHome(), "phantombot", "config.toml");

  const globalToml = await tryReadToml(configPath);
  const state = await loadState();

  const dataDir = join(xdgDataHome(), "phantombot");

  // personas_dir and default_persona are resolved from the GLOBAL layer only —
  // they are what tells us which persona file to read, so they cannot
  // themselves come from it.
  const personasDir =
    process.env.PHANTOMBOT_PERSONAS_DIR ??
    asString(globalToml.personas_dir) ??
    join(dataDir, "personas");
  const personaLayer =
    persona ??
    process.env.PHANTOMBOT_DEFAULT_PERSONA ??
    state.default_persona ??
    asString(globalToml.default_persona) ??
    "phantom";

  const personaToml = stripHostOnlyKeys(
    await readPersonaToml(personasDir, personaLayer),
  );
  const isDefaultPersona =
    personaLayer ===
    (process.env.PHANTOMBOT_DEFAULT_PERSONA ??
      state.default_persona ??
      asString(globalToml.default_persona) ??
      "phantom");
  const toml = applyPersonaLayer(globalToml, personaToml, {
    persona: personaLayer,
    isDefault: isDefaultPersona,
  });

  const tomlHarnesses = (toml.harnesses ?? {}) as Record<string, unknown>;
  const tomlClaude = (tomlHarnesses.claude ?? {}) as Record<string, unknown>;
  const tomlPi = (tomlHarnesses.pi ?? {}) as Record<string, unknown>;
  // DEPRECATED & IGNORED: pi's payload now always travels via temp files, so
  // there is no argv-length ceiling and no reason to cap payload size — pi is
  // the transparent last-resort fallback and must never refuse a turn for
  // size. Honor neither the env override nor the TOML key; just warn once so a
  // hand-tweaked `max_payload_bytes = 4000` on an old box becomes harmless
  // instead of silently starving the fallback. No user need ever touch this.
  if (
    process.env.PHANTOMBOT_PI_MAX_PAYLOAD !== undefined ||
    tomlPi.max_payload_bytes !== undefined
  ) {
    warnPiMaxPayloadDeprecated();
  }
  const tomlCodex = (tomlHarnesses.codex ?? {}) as Record<string, unknown>;
  const tomlHarnessPersonas = (tomlHarnesses.personas ?? {}) as Record<
    string,
    unknown
  >;
  // ── The harness env layer, scoped per persona (phantombot#441) ──────────
  //
  // `[harnesses]` is persona-scoped now (chain, models, Pi routing, bins), and
  // a config layer is not isolation until the ENV layer is scoped with it —
  // the lesson from #440's Telegram-token leak. The wizard writes
  // PHANTOMBOT_PRIMARY_MODEL & friends into the shared env file, so without
  // this every persona's carefully-stated model would be overwritten by the
  // host's ambient one and persona scoping would be decorative.
  //
  // Precedence per key, most specific first:
  //
  //   1. this persona's own env var   PHANTOMBOT_CLAUDE_MODEL_<PERSONA>
  //   2. this persona's config.toml   <persona>/config.toml  [harnesses]
  //   3. the host's ambient env var   PHANTOMBOT_CLAUDE_MODEL
  //   4. the host's config.toml       [harnesses]
  //   5. the built-in default
  //
  // (2) beating (3) is deliberate and is the ONE place this departs from
  // phantombot's usual env-wins rule: the ambient var is the HOST's statement
  // about its default brain, while the persona file is that persona's
  // statement about itself — the more specific one wins. Crucially it is
  // conditioned on the persona file actually STATING the key, so an unmigrated
  // host (no persona file, or one that omits the key) keeps exactly its
  // pre-#441 behaviour: ambient env over global TOML.
  //
  // The default persona is untouched by all of this — it reads the unsuffixed
  // vars as it always has, since its layer and the host's are the same thing.
  const personaHarnessToml = isDefaultPersona
    ? {}
    : ((personaToml.harnesses ?? {}) as Record<string, unknown>);
  const harnessEnvSuffix = isDefaultPersona
    ? undefined
    : personaEnvSuffix(personaLayer);

  /** Does this persona's OWN file state `[harnesses].<path>`? */
  const personaStatesHarness = (path: readonly string[]): boolean => {
    let node: unknown = personaHarnessToml;
    for (const key of path) {
      if (typeof node !== "object" || node === null || Array.isArray(node)) {
        return false;
      }
      node = (node as Record<string, unknown>)[key];
      if (node === undefined) return false;
    }
    return true;
  };

  /**
   * Resolve the ENV half of the precedence above for one harness key: the
   * persona's own suffixed var, else undefined when the persona states the key
   * itself (so the caller's `?? toml` fallback lands on the persona's value),
   * else the host's ambient var.
   */
  const harnessEnv = (
    name: string,
    path: readonly string[],
  ): string | undefined => {
    if (harnessEnvSuffix) {
      const own = process.env[`${name}_${harnessEnvSuffix}`];
      if (own !== undefined && own.trim() !== "") return own;
      if (personaStatesHarness(path)) return undefined;
    }
    return process.env[name];
  };

  // Bins the persona pinned for itself. Migration copies the host's bins into
  // every persona file, so "the file mentions a bin" alone would freeze each
  // persona on whatever path was probed the day it migrated. What we record is
  // narrower: only ids whose bin the persona file states AND that differ from
  // the host's — i.e. a deliberate pin, not a copied echo. See
  // withHostHarnessBins.
  const personaOwnBins = ["claude", "pi", "codex"].filter((id) => {
    if (!personaStatesHarness([id, "bin"])) return false;
    const own = asString(
      ((personaHarnessToml[id] ?? {}) as Record<string, unknown>).bin,
    );
    const hostToml = ((globalToml.harnesses ?? {}) as Record<string, unknown>)[id];
    const host = asString((hostToml as Record<string, unknown> | undefined)?.bin);
    return own !== undefined && own !== host;
  });

  const tomlChannels = (toml.channels ?? {}) as Record<string, unknown>;
  const tomlTelegram = (tomlChannels.telegram ?? {}) as Record<string, unknown>;
  const tomlP2p = (toml.p2p ?? {}) as Record<string, unknown>;
  const tomlEmbeddings = (toml.embeddings ?? {}) as Record<string, unknown>;
  const tomlGemini = (tomlEmbeddings.gemini ?? {}) as Record<string, unknown>;
  const tomlRetrieval = (toml.retrieval ?? {}) as Record<string, unknown>;
  const tomlTurnIndexing = (tomlRetrieval.turn_indexing ?? {}) as Record<
    string,
    unknown
  >;
  const tomlDurableFacts = (toml.durable_facts ?? {}) as Record<
    string,
    unknown
  >;
  const tomlVoice = (toml.voice ?? {}) as Record<string, unknown>;

  const configuredChain =
    harnessEnv("PHANTOMBOT_HARNESS_CHAIN", ["chain"])
      ?.split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0) ??
    asStringArray(tomlHarnesses.chain) ??
    [...DEFAULT_HARNESS_CHAIN];
  const migratedChain = configuredChain.filter((id) => id !== "gemini");
  if (migratedChain.length !== configuredChain.length) {
    console.warn(
      "warning: the Gemini CLI harness was removed; it was dropped from " +
        "harnesses.chain. Run `phantombot harness` to choose a replacement.",
    );
  }
  if (migratedChain.length === 0) migratedChain.push(...DEFAULT_HARNESS_CHAIN);

  // Resolved once here (not just inline in the object) because the durable-fact
  // lease floor is derived from it — see buildDurableFactsConfig.
  const harnessHardTimeoutMs =
    asInt(process.env.PHANTOMBOT_HARNESS_HARD_TIMEOUT_MS) ??
    (asInt(toml.harness_hard_timeout_s) !== undefined
      ? asInt(toml.harness_hard_timeout_s)! * 1000
      : undefined) ??
    legacyTurnTimeoutMs(toml) ??
      3_600_000;

  const telegram = buildTelegramConfig(
    tomlTelegram,
    // Default persona keeps the unsuffixed env vars; every other persona
    // reads only its own suffixed ones. See buildTelegramConfig.
    isDefaultPersona ? undefined : personaEnvSuffix(personaLayer),
  );
  let telegramPersonas = buildTelegramPersonasConfig(tomlTelegram);

  if (isDefaultPersona && telegram && telegramPersonas?.[personaLayer]) {
    const personaChannels = personaToml.channels;
    const ownTelegram =
      isTomlTable(personaChannels) && isTomlTable(personaChannels.telegram)
        ? personaChannels.telegram
        : undefined;
    const globalChannels = globalToml.channels;
    const globalTelegram =
      isTomlTable(globalChannels) && isTomlTable(globalChannels.telegram)
        ? globalChannels.telegram
        : undefined;
    const routing = globalTelegram && isTomlTable(globalTelegram.personas)
      ? globalTelegram.personas
      : undefined;
    const legacyEntry = routing && isTomlTable(routing[personaLayer])
      ? routing[personaLayer] as TomlObject
      : undefined;

    // Migration is copy-not-delete for rollback safety. Suppress the old
    // routing entry only when the persona file proves it was copied from that
    // exact account AND both resolve to the same bot after env overrides. A
    // distinct legacy token remains a supported second bot.
    if (
      ownTelegram &&
      legacyEntry &&
      asString(ownTelegram.token) === asString(legacyEntry.token) &&
      telegram.token === telegramPersonas[personaLayer]?.token
    ) {
      const { [personaLayer]: _migrated, ...rest } = telegramPersonas;
      telegramPersonas = Object.keys(rest).length > 0 ? rest : undefined;
    }
  }

  return {
    defaultPersona:
      process.env.PHANTOMBOT_DEFAULT_PERSONA ??
      state.default_persona ??
      asString(globalToml.default_persona) ??
      "phantom",

    autostartPersonas: parseAutostartPersonas(globalToml),

    personaLayer,

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

    // Time-to-first-output cap for foreground turns. Default 60s: a healthy
    // `claude --print` emits its `system init` line within ~1s once the MCP
    // handshake completes (a live proxy answers `initialize` in well under a
    // second), so 60s is a wide margin over even a loaded cold start while
    // still cutting a genuine startup wedge from the 300s idle window down to
    // one minute. Env/toml overridable; the idle timer still runs concurrently,
    // so whichever ceiling is lower fires first.
    harnessStartupTimeoutMs:
      asInt(process.env.PHANTOMBOT_HARNESS_STARTUP_TIMEOUT_MS) ??
      (asInt(toml.harness_startup_timeout_s) !== undefined
        ? asInt(toml.harness_startup_timeout_s)! * 1000
        : undefined) ??
      60_000,

    harnessHardTimeoutMs,

    personasDir,

    memoryDbPath:
      process.env.PHANTOMBOT_MEMORY_DB ??
      asString(globalToml.memory_db) ??
      join(dataDir, "memory.sqlite"),

    configPath,

    harnesses: {
      chain: migratedChain,
      personas: buildHarnessPersonasConfig(tomlHarnessPersonas),

      ownBins: personaOwnBins,

      claude: {
        bin:
          harnessEnv("PHANTOMBOT_CLAUDE_BIN", ["claude", "bin"]) ??
          asString(tomlClaude.bin) ??
          state.harness_bins?.claude ??
          "claude",
        model:
          harnessEnv("PHANTOMBOT_CLAUDE_MODEL", ["claude", "model"]) ??
          asString(tomlClaude.model) ??
          "opus",
        fallbackModel:
          harnessEnv("PHANTOMBOT_CLAUDE_FALLBACK_MODEL", [
            "claude",
            "fallback_model",
          ]) ??
          asString(tomlClaude.fallback_model) ??
          "sonnet",
      },

      pi: {
        bin:
          harnessEnv("PHANTOMBOT_PI_BIN", ["pi", "bin"]) ??
          asString(tomlPi.bin) ??
          state.harness_bins?.pi ??
          "pi",
        routing: buildPiRoutingConfig(tomlPi, {
          [ENV_PI_PROVIDER]: harnessEnv(ENV_PI_PROVIDER, [
            "pi",
            "routing",
            "provider",
          ]),
          [ENV_PRIMARY_MODEL]: harnessEnv(ENV_PRIMARY_MODEL, [
            "pi",
            "routing",
            "primary_model",
          ]),
          [ENV_IMAGE_MODEL]: harnessEnv(ENV_IMAGE_MODEL, [
            "pi",
            "routing",
            "image_model",
          ]),
          [ENV_CODING_MODEL]: harnessEnv(ENV_CODING_MODEL, [
            "pi",
            "routing",
            "coding_model",
          ]),
        }),
      },

      codex: {
        bin:
          harnessEnv("PHANTOMBOT_CODEX_BIN", ["codex", "bin"]) ??
          asString(tomlCodex.bin) ??
          state.harness_bins?.codex ??
          "codex",
        // Empty string = "let codex pick its own default".
        model:
          harnessEnv("PHANTOMBOT_CODEX_MODEL", ["codex", "model"]) ??
          asString(tomlCodex.model) ??
          "",
      },
    },

    channels: {
      telegram,
      telegramPersonas,
    },

    telegramStreaming: buildTelegramStreamingConfig(tomlTelegram),

    // Standing default for interim progress-narration bubbles. An explicit
    // value always wins (env for scripted/test setups, then `chattiness` in
    // config.toml). Absent any explicit value the phantom narrates (ON) — this
    // holds whether or not a config.toml exists, so an existing install with no
    // `chattiness` key or an empty file narrates too. See DEFAULT_CHATTINESS.
    chattiness:
      asBool(process.env.PHANTOMBOT_CHATTINESS) ??
      asBool(toml.chattiness) ??
      DEFAULT_CHATTINESS,

    // Which release ring this host follows. Env wins over TOML wins over
    // the default, same precedence as everything else. An UNRECOGNISED
    // value falls back to "stable" with a warning rather than being treated
    // as opt-in: a typo (`update_channel = "prevew"`) must never leave a
    // box quietly following a ring the operator did not choose, and stable
    // is the fail-closed direction.
    updateChannel: resolveUpdateChannel(globalToml.update_channel),

    embeddings: buildEmbeddingsConfig(tomlEmbeddings, tomlGemini),

    retrieval: buildRetrievalConfig(tomlRetrieval, tomlTurnIndexing),
    durableFacts: buildDurableFactsConfig(
      tomlDurableFacts,
      harnessHardTimeoutMs,
    ),

    voice: buildVoiceConfig(tomlVoice),

    p2p: buildP2PConfig(tomlP2p),
  };
}

/**
 * Resolve the persona a persona-aware command targets, and load THAT persona's
 * effective config (phantombot#439).
 *
 * Every persona-aware entry point used to do this the other way round — load
 * the config first, read `defaultPersona` off it, then act on some other
 * persona while still holding the DEFAULT persona's settings. With per-persona
 * config files that silently runs the wrong Telegram bot, the wrong harness
 * chain, the wrong voice and the wrong retrieval policy for every persona but
 * one. So: resolve the target first, then load its layer.
 *
 * Host-level harness BINARY paths are kept from the host layer — a `bin` names
 * something installed on this machine, not a property of a personality — which
 * is the same rule the daemon applies to its listeners.
 *
 * Costs one extra config read, and only when the target is not the default.
 */
export async function loadConfigForPersona(
  persona?: string,
  base?: Config,
): Promise<{ config: Config; persona: string; host: Config }> {
  const host = base ?? (await loadConfig());
  const target = persona ?? host.defaultPersona;
  // `host` already IS the target's layer when it was loaded for it — or when
  // the caller injected a config that names no layer, in which case there is
  // nothing else to load.
  if (target === (host.personaLayer ?? host.defaultPersona)) {
    return { config: host, persona: target, host };
  }
  const layered = await loadConfig(target);
  // `host` is returned alongside because a non-default persona's layer
  // deliberately does NOT carry the host's default Telegram account (see
  // applyPersonaLayer). Callers that legitimately need the host account —
  // notify, which broadcasts an incident to the owner's bot as well — read it
  // from here rather than reaching back into the file system.
  return { config: withHostHarnessBins(layered, host), persona: target, host };
}

/**
 * Take a persona's config but keep the HOST's harness binary paths.
 *
 * Binaries are a property of the machine, not the personality: `claude` lives
 * at one path on this box for everyone, and the host layer's paths are the
 * ones `doctor`/`run` probed for real. A persona file carrying a stale `bin`
 * must not quietly run a different binary. Everything else the persona
 * overrode — notably `harnesses.chain` — is preserved.
 */
export function withHostHarnessBins(personaConfig: Config, host: Config): Config {
  if (personaConfig === host) return host;
  // A bin the persona DELIBERATELY pinned (stated in its own file and different
  // from the host's) is left alone — that is the per-key rule the whole persona
  // layer runs on. Everything else takes the host's probed path, so the bins
  // migration copied into each persona file cannot freeze a persona on a stale
  // path after a binary moves. See Config.harnesses.ownBins.
  const pinned = new Set(personaConfig.harnesses.ownBins ?? []);
  const bin = (id: string, own: string, hostBin: string | undefined): string =>
    pinned.has(id) ? own : (hostBin ?? own);
  return {
    ...personaConfig,
    harnesses: {
      ...personaConfig.harnesses,
      claude: {
        ...personaConfig.harnesses.claude,
        bin: bin("claude", personaConfig.harnesses.claude.bin, host.harnesses.claude.bin),
      },
      pi: {
        ...personaConfig.harnesses.pi,
        bin: bin("pi", personaConfig.harnesses.pi.bin, host.harnesses.pi.bin),
      },
      ...(personaConfig.harnesses.codex
        ? {
            codex: {
              ...personaConfig.harnesses.codex,
              bin: bin(
                "codex",
                personaConfig.harnesses.codex.bin,
                host.harnesses.codex?.bin,
              ),
            },
          }
        : {}),
    },
  };
}

/**
 * Resolve the host's release ring: `PHANTOMBOT_UPDATE_CHANNEL` env, then
 * `update_channel` in config.toml, then the stable default. Anything that
 * is not exactly "stable" or "preview" is rejected with a warning and
 * treated as stable — see the call site for why we fail closed.
 */
function resolveUpdateChannel(tomlValue: unknown): UpdateChannel {
  const fromEnv = process.env.PHANTOMBOT_UPDATE_CHANNEL;
  if (fromEnv !== undefined && fromEnv !== "") {
    const parsed = asUpdateChannel(fromEnv);
    if (parsed) return parsed;
    log.warn("config: ignoring unrecognized PHANTOMBOT_UPDATE_CHANNEL", {
      value: fromEnv,
      using: DEFAULT_UPDATE_CHANNEL,
    });
    return DEFAULT_UPDATE_CHANNEL;
  }
  if (tomlValue !== undefined) {
    const parsed = asUpdateChannel(tomlValue);
    if (parsed) return parsed;
    log.warn("config: ignoring unrecognized update_channel in config.toml", {
      value: String(tomlValue),
      using: DEFAULT_UPDATE_CHANNEL,
    });
  }
  return DEFAULT_UPDATE_CHANNEL;
}

/**
 * Resolve the relay-free P2P transport settings. Env wins over TOML wins over
 * defaults, same precedence as everything else. DISABLED by default so an
 * unconfigured install is byte-for-byte unchanged. The port is clamped to the
 * unprivileged range; STUN servers fall back to the public reflexive-only set.
 */
function buildP2PConfig(tomlP2p: Record<string, unknown>): P2PSettings {
  const enabled =
    asBool(process.env.PHANTOMBOT_P2P_ENABLED) ??
    asBool(tomlP2p.enabled) ??
    DEFAULT_P2P.enabled;

  // Env is a comma-separated list (like PHANTOMBOT_TELEGRAM_ALLOWED_USERS);
  // TOML is a native array. An explicit empty env value ("") means "no STUN".
  const stunFromEnv = process.env.PHANTOMBOT_P2P_STUN;
  const stunServers =
    stunFromEnv !== undefined
      ? stunFromEnv
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : (asStringArray(tomlP2p.stun_servers) ?? DEFAULT_P2P.stunServers);

  return { enabled, stunServers };
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
    graphExpansion: buildGraphExpansionConfig(
      (tomlRetrieval.graph_expansion ?? {}) as Record<string, unknown>,
    ),
    decay: buildRetrievalDecayConfig(
      (tomlRetrieval.decay ?? {}) as Record<string, unknown>,
    ),
    crossConversation: buildCrossConversationConfig(
      (tomlRetrieval.cross_conversation ?? {}) as Record<string, unknown>,
    ),
  };
}

function buildCrossConversationConfig(
  toml: Record<string, unknown>,
): CrossConversationRetrievalSettings {
  // Absent flag → DEFAULT ON. This is the anti-config-fatigue contract:
  // nobody should have to discover or set this knob to get the right
  // behaviour; it exists so a sensitive setup can opt OUT.
  const enabled =
    asBool(process.env.PHANTOMBOT_RETRIEVAL_CROSS_ENABLED) ??
    asBool(toml.enabled) ??
    DEFAULT_CROSS_CONVERSATION.enabled;
  const limit =
    asInt(process.env.PHANTOMBOT_RETRIEVAL_CROSS_LIMIT) ??
    asInt(toml.limit) ??
    DEFAULT_CROSS_CONVERSATION.limit;
  const minScore =
    asNumber(process.env.PHANTOMBOT_RETRIEVAL_CROSS_MIN_SCORE) ??
    asNumber(toml.min_score) ??
    DEFAULT_CROSS_CONVERSATION.minScore;
  const minVecScore =
    asNumber(process.env.PHANTOMBOT_RETRIEVAL_CROSS_MIN_VEC_SCORE) ??
    asNumber(toml.min_vec_score) ??
    DEFAULT_CROSS_CONVERSATION.minVecScore;
  // Env form is comma-separated ("telegram,phantomchat:group:abc"); TOML is
  // a native string array.
  const envExclude = process.env.PHANTOMBOT_RETRIEVAL_CROSS_EXCLUDE
    ?.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const exclude =
    envExclude ??
    asStringArray(toml.exclude) ??
    DEFAULT_CROSS_CONVERSATION.exclude;
  return {
    enabled,
    // 0 disables tier 2 without touching the flag; cap keeps the per-turn
    // prompt cost bounded even for a fat-fingered value.
    limit: Math.max(0, Math.min(10, limit)),
    // Absolute floors; a negative floor would re-open the "inject anything
    // that matched at all" hole, and cosine lives in [-1, 1].
    minScore: Math.max(0, minScore),
    minVecScore: Math.max(-1, Math.min(1, minVecScore)),
    // Drop blanks so "a,,b" can't accidentally match every conversation.
    exclude: exclude.map((e) => e.trim()).filter((e) => e.length > 0),
  };
}

function buildRetrievalDecayConfig(
  toml: Record<string, unknown>,
): RetrievalDecaySettings {
  const enabled =
    asBool(process.env.PHANTOMBOT_RETRIEVAL_DECAY_ENABLED) ??
    asBool(toml.enabled) ??
    DEFAULT_RETRIEVAL_DECAY.enabled;
  const halfLifeDays =
    asNumber(process.env.PHANTOMBOT_RETRIEVAL_DECAY_HALF_LIFE_DAYS) ??
    asNumber(toml.half_life_days) ??
    DEFAULT_RETRIEVAL_DECAY.halfLifeDays;
  const floor =
    asNumber(process.env.PHANTOMBOT_RETRIEVAL_DECAY_FLOOR) ??
    asNumber(toml.floor) ??
    DEFAULT_RETRIEVAL_DECAY.floor;
  return {
    enabled,
    // Floor at 0 (0 or below disables decay in the index). No hard ceiling —
    // an operator wanting effectively-immortal turns can set this very large.
    halfLifeDays: Math.max(0, halfLifeDays),
    // Clamp to a valid multiplier range so a fat-fingered value can't invert
    // ordering (floor > 1) or push scores negative.
    floor: Math.max(0, Math.min(1, floor)),
  };
}

function buildGraphExpansionConfig(
  toml: Record<string, unknown>,
): GraphExpansionSettings {
  const enabled =
    asBool(process.env.PHANTOMBOT_RETRIEVAL_GRAPH_EXPANSION_ENABLED) ??
    asBool(toml.enabled) ??
    DEFAULT_GRAPH_EXPANSION.enabled;
  const hops =
    asInt(process.env.PHANTOMBOT_RETRIEVAL_GRAPH_HOPS) ??
    asInt(toml.hops) ??
    DEFAULT_GRAPH_EXPANSION.hops;
  const maxAdd =
    asInt(process.env.PHANTOMBOT_RETRIEVAL_GRAPH_MAX_ADD) ??
    asInt(toml.max_add) ??
    DEFAULT_GRAPH_EXPANSION.maxAdd;
  return {
    enabled,
    // 1..3 hops keeps expansion local; beyond that the graph fans out into
    // noise. maxAdd is floored at 0 (disables) and capped to keep token cost
    // bounded.
    hops: Math.max(1, Math.min(3, hops)),
    maxAdd: Math.max(0, Math.min(20, maxAdd)),
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
  // Parsed as a float (not asInt): the default is fractional (0.5h) and
  // Math.floor would round 0.5 down to 0, silently disabling the flush.
  const flushAfterHours =
    asNumber(process.env.PHANTOMBOT_RETRIEVAL_TURN_INDEXING_FLUSH_AFTER_HOURS) ??
    asNumber(tomlTurnIndexing.flush_after_hours) ??
    DEFAULT_TURN_INDEXING.flushAfterHours;
  const repairBatchSize =
    asInt(process.env.PHANTOMBOT_RETRIEVAL_TURN_INDEXING_REPAIR_BATCH_SIZE) ??
    asInt(tomlTurnIndexing.repair_batch_size) ??
    DEFAULT_TURN_INDEXING.repairBatchSize;
  return {
    enabled,
    interval: Math.max(1, Math.min(10_000, interval)),
    batchSize: Math.max(1, Math.min(5_000, batchSize)),
    // 0 disables the time-based flush; otherwise clamp to a sane 0.5h..1yr.
    flushAfterHours: Math.max(0, Math.min(8_760, flushAfterHours)),
    // 0 disables the repair pass. Capped so one sweep can't fire off an
    // unbounded burst of embedding calls at a provider that may be rate-limiting.
    repairBatchSize: Math.max(0, Math.min(1_000, repairBatchSize)),
  };
}

/**
 * Resolve durable-facts settings. Env wins over TOML wins over defaults, and
 * values are clamped so a fat-fingered config can't blow the per-turn prompt
 * budget or the extraction fan-out.
 */
function buildDurableFactsConfig(
  toml: Record<string, unknown>,
  harnessHardTimeoutMs: number,
): DurableFactsSettings {
  const enabled =
    asBool(process.env.PHANTOMBOT_DURABLE_FACTS_ENABLED) ??
    asBool(toml.enabled) ??
    DEFAULT_DURABLE_FACTS.enabled;
  const maxInjected =
    asInt(process.env.PHANTOMBOT_DURABLE_FACTS_MAX_INJECTED) ??
    asInt(toml.max_injected) ??
    DEFAULT_DURABLE_FACTS.maxInjected;
  // Parsed as a float (not asInt): the default (0.5) is fractional and
  // Math.floor would round it to 0, silently removing the confidence floor.
  const minConfidence =
    asNumber(process.env.PHANTOMBOT_DURABLE_FACTS_MIN_CONFIDENCE) ??
    asNumber(toml.min_confidence) ??
    DEFAULT_DURABLE_FACTS.minConfidence;
  const maxExtractPerTurn =
    asInt(process.env.PHANTOMBOT_DURABLE_FACTS_MAX_EXTRACT_PER_TURN) ??
    asInt(toml.max_extract_per_turn) ??
    DEFAULT_DURABLE_FACTS.maxExtractPerTurn;
  const leaseMs =
    asInt(process.env.PHANTOMBOT_DURABLE_FACTS_LEASE_MS) ??
    asInt(toml.lease_ms) ??
    DEFAULT_DURABLE_FACTS.leaseMs;
  const injectFloor =
    asNumber(process.env.PHANTOMBOT_DURABLE_FACTS_INJECT_FLOOR) ??
    asNumber(toml.inject_floor) ??
    DEFAULT_DURABLE_FACTS.injectFloor;
  const debug =
    asBool(process.env.PHANTOMBOT_DURABLE_FACTS_DEBUG) ??
    asBool(toml.debug) ??
    DEFAULT_DURABLE_FACTS.debug;
  return {
    enabled,
    tiers: buildFactTiers(asRecord(toml.tiers)),
    injectFloor: Math.max(0, Math.min(1, injectFloor)),
    debug,
    // 0 disables injection; capped so one turn can't stuff the prompt.
    maxInjected: Math.max(0, Math.min(100, maxInjected)),
    // A probability floor: clamp to 0..1.
    minConfidence: Math.max(0, Math.min(1, minConfidence)),
    // At least 1 evicted turn per pass; capped so a long backfill can't fire
    // an unbounded burst of harness calls in one out-of-band pass.
    maxExtractPerTurn: Math.max(1, Math.min(100, maxExtractPerTurn)),
    // Floor at the harness hard timeout + a commit margin (and never below 1s).
    // A lease that could expire before a slow extraction finishes would let a
    // concurrent pass re-claim the turn and fire a DUPLICATE model call while
    // the original is still running, then have the original's late write land
    // behind it (Kai, PR #320). Flooring above the maximum a single extraction
    // can take means only a genuine crash — which never completes — hits expiry.
    leaseMs: Math.max(
      1000,
      harnessHardTimeoutMs + LEASE_COMMIT_MARGIN_MS,
      Math.floor(leaseMs),
    ),
  };
}

/**
 * Merge per-source tier overrides from TOML on top of DEFAULT_FACT_TIERS.
 * Each field is validated + clamped independently so a partial or malformed
 * `[durable_facts.tiers.self]` block can only tune what it sets, never disable
 * a tier. weight/halfLifeDays/maxAgeDays are all floored positive.
 */
function buildFactTiers(toml: Record<string, unknown>): FactSourceTiers {
  const out = {} as FactSourceTiers;
  for (const source of FACT_SOURCES) {
    const base = DEFAULT_FACT_TIERS[source];
    const o = asRecord(toml[source]);
    const weight = asNumber(o.weight) ?? base.weight;
    const halfLifeDays = asNumber(o.half_life_days) ?? base.halfLifeDays;
    const maxAgeDays = asNumber(o.max_age_days) ?? base.maxAgeDays;
    out[source] = {
      weight: Math.max(0, Math.min(1, weight)),
      // A half-life of 0 would divide-by-zero the decay; floor at a day.
      halfLifeDays: Math.max(1, halfLifeDays),
      // Retirement age must never sit below the half-life or a fact would be
      // pruned before it even finishes its first decay step.
      maxAgeDays: Math.max(1, maxAgeDays),
    };
  }
  return out;
}

/** Coerce an unknown TOML value to a plain record; {} when it isn't one. */
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
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

/**
 * Resolve `[harnesses.pi.routing]` with env-over-TOML precedence (the shared
 * rule, implemented once in resolveRouting). Returns undefined when no routing
 * is configured at all so the field stays genuinely optional on Config — the
 * extension's "no override" path. A bare primary with no image/coding model is
 * still valid (means: route nothing but pin the orchestrator model).
 */
function buildPiRoutingConfig(
  tomlPi: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): PiRoutingConfig | undefined {
  const tomlRouting = (tomlPi.routing ?? {}) as Record<string, unknown>;
  const resolved = resolveRouting(tomlRouting, env);
  // An explicit opt-out is a CONFIGURED state, not an absent one: it must reach
  // the harness so it can withhold the api-key too (undefined here would mean
  // "nothing was said", and the key is read straight from the env). See
  // ROUTING_LOCAL_CONFIG_KEY.
  if (resolved.useLocalConfig) return resolved;
  if (
    resolved.provider === undefined &&
    resolved.primaryModel === undefined &&
    resolved.imageModel === undefined &&
    resolved.codingModel === undefined
  ) {
    return undefined;
  }
  return resolved;
}

/**
 * Parse `[harnesses.personas.<name>]` chain overrides. Empty chains and chains
 * that only name the removed Gemini harness are omitted, so those personas use
 * the global chain. Unknown ids remain intact and are reported by the shared
 * chain builder in the same way as unknown ids in the global chain.
 */
function buildHarnessPersonasConfig(
  tomlPersonas: Record<string, unknown>,
): Record<string, { chain: string[] }> | undefined {
  const personas: Record<string, { chain: string[] }> = {};
  for (const [persona, raw] of Object.entries(tomlPersonas)) {
    const configured = asStringArray(asRecord(raw).chain);
    if (!configured) continue;
    const chain = configured.filter((id) => id !== "gemini");
    if (chain.length > 0) personas[persona] = { chain };
  }
  return Object.keys(personas).length > 0 ? personas : undefined;
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

/**
 * Build the persona layer's own Telegram account.
 *
 * The env overrides are PERSONA-SCOPED. `TELEGRAM_BOT_TOKEN` and the
 * `PHANTOMBOT_TELEGRAM_*` vars describe the DEFAULT persona's bot — on a real
 * host that is exactly where the default token arrives (vault → env). Applying
 * them to a non-default persona would hand it the owner's bot even though
 * `applyPersonaLayer` just rebuilt its TOML account from scratch to prevent
 * precisely that, putting two listeners on one token. So for a NON-DEFAULT
 * persona we read only the suffixed form (`TELEGRAM_BOT_TOKEN_<PERSONA>`, the
 * convention the README already documents for named accounts) and IGNORE the
 * unsuffixed vars entirely — never falling back to them, since a fallback is
 * the same leak by another name.
 *
 * @param envSuffix persona env-var suffix, or undefined for the default
 *                  persona (which keeps the historical unsuffixed vars).
 */
function buildTelegramConfig(
  tomlTelegram: Record<string, unknown>,
  envSuffix?: string,
): Config["channels"]["telegram"] {
  const sfx = envSuffix ? `_${envSuffix}` : "";
  const token =
    process.env[`TELEGRAM_BOT_TOKEN${sfx}`] ?? asString(tomlTelegram.token);
  if (!token) return undefined;

  const pollTimeoutS = clampPollTimeout(
    asInt(process.env[`PHANTOMBOT_TELEGRAM_POLL_S${sfx}`]) ??
      asInt(tomlTelegram.poll_timeout_s) ??
      30,
  );

  const allowedFromEnv = process.env[
    `PHANTOMBOT_TELEGRAM_ALLOWED_USERS${sfx}`
  ]
    ?.split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n));
  const allowedFromToml = asIntArray(tomlTelegram.allowed_user_ids);
  const allowedUserIds = allowedFromEnv ?? allowedFromToml ?? [];

  const groupPersonaNames =
    parseGroupPersonaNames(
      process.env[`PHANTOMBOT_TELEGRAM_GROUP_PERSONAS${sfx}`],
    ) ??
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

/**
 * Read `autostart_personas` from the global config (env override:
 * `PHANTOMBOT_AUTOSTART_PERSONAS`, comma-separated).
 *
 * Unknown shapes resolve to [] rather than throwing: an autostart list is a
 * convenience, and a malformed one must not stop the daemon from starting the
 * default persona. Entries are trimmed, empties dropped, duplicates collapsed,
 * and order preserved (it is the order listeners come up in).
 */
export function parseAutostartPersonas(
  toml: Record<string, unknown>,
): string[] {
  const env = process.env.PHANTOMBOT_AUTOSTART_PERSONAS;
  const raw = env !== undefined ? env.split(",") : toml.autostart_personas;
  if (!Array.isArray(raw)) {
    if (raw !== undefined) {
      log.warn(
        "config: autostart_personas must be an array of persona names — ignoring",
      );
    }
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const name = entry.trim();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
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

/** Read + parse config.toml; a missing file parses as an empty config. */
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
