/**
 * Coding-brain auto-swap: a CRS-style weighted scorer that decides, per turn,
 * whether the incoming user message is a "probable coding job" and the Pi
 * harness should swap its PRIMARY model to the configured CODING model for that
 * single turn.
 *
 * WHY a brain-swap instead of the `coder` tool?
 *   The `coder` tool spawns a fresh, isolated child with NO memory, NO
 *   conversation history, and NO images — the primary has to hand-relay all
 *   context into the task string, which is lossy and fragile. By contrast the
 *   Pi harness runs `pi --print --no-session` and phantombot rebuilds the FULL
 *   context (system prompt + history + retrieved memory) on EVERY turn, so
 *   swapping only the `--model` string makes the coding model inherit memory,
 *   history, and images natively — for free. The swap is cheap; delegation is
 *   not. So for substantial code work we swap the brain rather than delegate.
 *
 * WHY a score, not an LLM gate?
 *   An LLM classifier on every turn is expensive and slow for a chat-first
 *   daily driver. A pure-function scorer is free and instant, so it can run
 *   inline on every turn — which makes the swap STATELESS and self-correcting:
 *   a review keeps tripping "yes" turn after turn, and the moment the topic
 *   moves off code the score drops below threshold and the brain flips straight
 *   back to the primary. No sticky latch, no stuck-mode, no manual reset.
 *
 * THE MODEL (ModSecurity CRS-style anomaly scoring):
 *   - Each distinct SIGNAL that matches contributes its weight ONCE (a signal
 *     that matches three times still scores once — no spam-gaming).
 *   - Weights: HARD signals (PR/MR URLs + explicit pull/merge-request phrases)
 *     trip the threshold on their own; STRONG signals are 2; WEAK signals are
 *     1. A lone weak word is noise; it needs partners to trip.
 *   - Sum the distinct weights, compare to one tunable threshold (default 3).
 *     That threshold is the single "paranoia level" dial.
 *
 * MULTILINGUAL: coding vocabulary is mostly English loanwords everywhere
 * (commit, push, merge, deploy, repo, refactor), so the dictionary is small.
 * The divergence is only in the natural-language verbs that wrap code, so we
 * carry the EN/ES/NL forms of review / merge / branch / source.
 *
 * MANUAL OVERRIDE: `/coder` forces the coding brain on for a conversation,
 * `/nocoder` forces it off, `/coder default` clears back to scoring. The
 * override is persistent (no TTL) and wins over the score, mirroring the
 * `/viewcoder` store shape (see viewCoder.ts).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { xdgStateHome } from "../config.ts";

/** The single paranoia-level dial: distinct-weight sum at/above which we swap. */
export const CODER_SWAP_THRESHOLD = 3;

/**
 * Weight that, on its own, meets any reasonable threshold. Used for HARD
 * signals (an unambiguous PR/MR URL or "pull request"/"merge request" phrase)
 * so a single one trips the swap regardless of threshold tuning.
 */
const HARD = 100;

interface Signal {
  id: string;
  weight: number;
  pattern: RegExp;
}

/**
 * Wrap an alternation in Unicode-aware word boundaries. JS `\b` is ASCII-only
 * and silently fails to bound accented characters (e.g. `código`), so we use
 * explicit lookarounds over the Unicode letter/number/underscore class. Flags:
 * `i` (case-insensitive), `u` (Unicode).
 */
function word(...alts: string[]): RegExp {
  const body = alts.join("|");
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])`, "iu");
}

/**
 * The signal table. Order is irrelevant (we sum distinct hits). Keep weights in
 * three tiers — HARD (trip alone), 2 (strong), 1 (weak). Add languages by
 * extending the alternations, not by adding new tiers.
 */
const SIGNALS: Signal[] = [
  // ── HARD: unambiguous PR/MR signals (trip on their own) ──────────────────
  {
    id: "pr_mr_url",
    weight: HARD,
    // GitHub /pull/123, GitLab /-/merge_requests/12 and /merge_requests/12,
    // Bitbucket /pull-requests/7.
    pattern: /\/(?:pull|pull-requests|merge_requests)\/\d+|\/-\/merge_requests\/\d+/iu,
  },
  {
    id: "pull_merge_request_phrase",
    weight: HARD,
    pattern: word("pull request", "pull-request", "merge request", "merge-request"),
  },
  {
    id: "code_review_phrase",
    weight: HARD,
    pattern: word("code review", "review this pr", "review this mr", "review the pr", "review the mr"),
  },

  // ── STRONG (2) ───────────────────────────────────────────────────────────
  { id: "refactor", weight: 2, pattern: word("refactor", "refactors", "refactoring", "refactorizar", "refactorización") },
  { id: "codebase", weight: 2, pattern: word("codebase", "code base", "repository", "repositories", "repositorio", "repositorios") },
  { id: "repo", weight: 2, pattern: word("repo", "repos") },
  { id: "forge", weight: 2, pattern: word("github", "gitlab", "bitbucket") },
  { id: "diff", weight: 2, pattern: word("diff", "diffs", "merge conflict", "merge conflicts") },
  { id: "pr_mr_token", weight: 2, pattern: word("pr", "mr") },
  // src/ or a path containing a code-file extension.
  {
    id: "code_path",
    weight: 2,
    pattern: /(?<![\p{L}\p{N}_])src\/|[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|rb|c|cpp|cc|h|hpp|sh|sql|json|ya?ml|toml)(?![\p{L}\p{N}_])/iu,
  },
  // review / merge verbs (ES/NL); EN "review" kept weak below.
  { id: "review_merge_verb", weight: 2, pattern: word("revisar", "revisión", "fusionar", "nakijken", "samenvoegen") },

  // ── WEAK (1) ─────────────────────────────────────────────────────────────
  { id: "code", weight: 1, pattern: word("code", "coding", "código", "source code") },
  { id: "source", weight: 1, pattern: word("src", "source", "fuente", "bron") },
  { id: "git", weight: 1, pattern: word("git") },
  { id: "vcs_verb", weight: 1, pattern: word("commit", "commits", "push", "pushed", "merge", "merged", "rebase", "cherry-pick") },
  { id: "branch", weight: 1, pattern: word("branch", "branches", "rama", "ramas", "tak", "takken") },
  { id: "review_en", weight: 1, pattern: word("review", "reviews", "reviewing") },
  { id: "deploy_build", weight: 1, pattern: word("deploy", "deployment", "desplegar", "build", "builds", "compile", "compilar") },
  { id: "code_unit", weight: 1, pattern: word("function", "functions", "función", "class", "classes", "module", "modules", "método", "method", "methods") },
  { id: "bugfix", weight: 1, pattern: word("bug", "bugs", "bugfix", "fix", "fixes", "patch", "patches", "hotfix") },
  { id: "ci", weight: 1, pattern: word("ci", "cd", "pipeline", "pipelines", "lint", "linter", "typecheck", "unit test", "unit tests") },
];

export interface CodingScore {
  /** Sum of distinct signal weights. */
  score: number;
  /** Ids of the signals that matched (each once), for logging/debug. */
  hits: string[];
}

/**
 * One turn's coding intent, with the HARD lane split out from the soft weights.
 *
 * The context scorer (scoreCodingContext) needs these two facets *separately*:
 *   - `soft` (the 1s and 2s) feeds the recency-decayed RATIO that answers "how
 *     code-focused is the recent conversation, as a proportion?".
 *   - `hard` (a PR/MR URL or "pull request" phrase) must NOT be folded into that
 *     ratio — a 100-weight signal would peg the ratio at ~100% and defeat it.
 *     Instead HARD rides its own decay lane so an unambiguous "review this PR"
 *     carries the swap through a few natural-language follow-ups, then releases.
 */
export interface TurnIntent {
  /** Sum of distinct SOFT (non-HARD) signal weights. */
  soft: number;
  /** True if any HARD signal (PR/MR URL or phrase) matched. */
  hard: boolean;
  /** Ids of every signal that matched (each once), for logging/debug. */
  hits: string[];
}

/**
 * Analyze a single piece of text, separating the HARD lane from soft weights.
 * Pure, allocation-light, no I/O. Each distinct signal contributes once.
 */
export function analyzeTurn(text: string): TurnIntent {
  if (!text) return { soft: 0, hard: false, hits: [] };
  let soft = 0;
  let hard = false;
  const hits: string[] = [];
  for (const sig of SIGNALS) {
    if (sig.pattern.test(text)) {
      hits.push(sig.id);
      if (sig.weight >= HARD) hard = true;
      else soft += sig.weight;
    }
  }
  return { soft, hard, hits };
}

/**
 * Score a piece of text for "probable coding job" intent. Pure, allocation-
 * light, no I/O. Each distinct signal contributes its weight at most once.
 *
 * Retained for the single-message (history-free) path and for callers that want
 * the flat CRS sum. The combined score folds a HARD hit back in as `HARD`.
 */
export function scoreCodingIntent(text: string): CodingScore {
  const t = analyzeTurn(text);
  return { score: t.soft + (t.hard ? HARD : 0), hits: t.hits };
}

// ───────────────────────────────────────────────────────────────────────────
// Context-window scoring (decayed ratio with a smoothing prior)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Why a context window at all?
 *   The flat per-message scorer flips back to the primary the moment a turn
 *   reads like chat — even mid-review. Real follow-ups ("what about the error
 *   handling in the second commit?") are natural language with few code tokens,
 *   so scored in isolation they fall under threshold and yank the coding brain
 *   away while you're plainly still in a coding job. We want the LAST message
 *   judged IN CONTEXT of the recent turns, not alone.
 *
 * Why NOT a flat sum over the last N turns?
 *   A flat window re-introduces stuck-mode: after a long coding session "what's
 *   for dinner?" still sees a window stuffed with code signals and stays pinned.
 *   The whole virtue of the original design is self-correction; we must keep it.
 *
 * The model (one gate + three lanes, all recency-decayed):
 *   RECENCY DECAY — a turn at `age` (0 = current message) is weighted
 *   `decay^age`. Recent turns dominate; old ones fade. This is what keeps
 *   self-correction alive instead of the stuck-mode a flat window would cause.
 *
 *   ELIGIBILITY GATE (the key to flip-back) — the soft lanes only fire when the
 *   CURRENT message itself has SOME coding flavor (`soft > 0` or `hard`). A
 *   pure-chat message ("what's for dinner?") is ineligible, so a window stuffed
 *   with old coding turns can't pin the brain — you flip back the instant the
 *   topic genuinely moves off code. Context only ever helps a message that is
 *   itself at least a little code-shaped (a real follow-up), never pure chat.
 *
 *   Lane 1 — HARD carry: an in-window HARD hit (PR/MR URL or phrase) carries
 *   `decay^age` and trips the swap until it decays below `hardReleaseFloor`, so
 *   an unambiguous "review this PR" survives a few code-ish follow-ups, then
 *   releases. (Lowest floor → longest carry; PR review is the headline case.)
 *
 *   Lane 2 — ANCHOR carry: a recent CLEARLY-coding turn (`soft >= saturation`,
 *   e.g. "refactor the auth code in src") carries `decay^age` until below
 *   `carryFloor`, so a non-PR coding turn still holds the brain across an
 *   immediate follow-up.
 *
 *   Lane 3 — RATIO (Andrew's "percentage, not a fixed number"): the PROPORTION
 *   of recent decayed attention that is coding. Each turn's soft score is
 *   normalized to [0,1] (`>= saturation` counts as a fully-coding turn = 1.0),
 *   and `intensity = Σ(decay^age · norm) / (Σ decay^age + k)`. The SMOOTHING
 *   PRIOR `k` is what makes "1 turn ≠ 20 turns": early on `k` dominates the
 *   denominator so noise can't clear the bar; deep into a sustained session `k`
 *   is small relative to accumulated weight and the true ratio shows through.
 *   Not a different threshold — confidence that scales with evidence.
 *
 * SWAP iff the current turn is eligible AND any lane fires. (`current.hard` is
 * covered by lane 1 with carry = 1.)
 *
 * Equivalence to the old behavior on a SINGLE turn: with the defaults a lone
 * message swaps iff it's a HARD hit or its soft score >= saturation (3) — i.e.
 * the legacy "trip at 3" line. A lone borderline turn (soft 2, e.g. "show me
 * the repo") stays on the primary, exactly as before. The window only ever
 * *adds* carry/ratio context; it never makes a strong single message score
 * lower.
 */
export interface ContextConfig {
  /** Per-turn recency multiplier; weight at age a is decay^a. 0 < decay < 1. */
  decay: number;
  /** Max recent USER turns to consider (current message included). */
  window: number;
  /** Soft score at which a turn counts as "fully coding" (normalized to 1.0). */
  saturation: number;
  /** Decayed coding proportion at/above which the ratio lane swaps. */
  ratioThreshold: number;
  /** Smoothing pseudo-count `k` added to the denominator (evidence prior). */
  prior: number;
  /** Decayed presence below which the soft-ANCHOR carry lane releases. */
  carryFloor: number;
  /** Decayed presence below which the HARD carry lane releases. */
  hardReleaseFloor: number;
}

/**
 * Defaults chosen so a lone coding message still swaps at soft ≥ 3 (legacy
 * parity); a soft anchor carries through ~1 follow-up (0.5^1 ≥ 0.3 > 0.5^2); a
 * PR link carries ~3 follow-ups before releasing (0.5^3 ≥ 0.1 > 0.5^4); and the
 * window is short enough that 0.5^window ≈ 0 (turns past ~6 are noise).
 */
export const CONTEXT_DEFAULTS: ContextConfig = {
  decay: 0.5,
  window: 6,
  saturation: 3,
  ratioThreshold: 0.3,
  prior: 2,
  carryFloor: 0.3,
  hardReleaseFloor: 0.1,
};

export interface ContextScore {
  /** Final decision: swap to the coding brain this turn. */
  swap: boolean;
  /** Which lane decided (eligibility / hard-carry / anchor-carry / ratio). */
  reason: string;
  /** True when the CURRENT message has coding flavor (gate for the soft lanes). */
  eligible: boolean;
  /** Ratio-lane decayed coding proportion in [0, 1). */
  intensity: number;
  /** Ratio-lane bar that `intensity` is compared against. */
  ratioThreshold: number;
  /** Decayed HARD presence (max decay^age over in-window HARD hits). */
  hardCarry: number;
  /** Decayed soft-anchor presence (max decay^age over `soft >= saturation` turns). */
  anchorCarry: number;
  /** Per-turn breakdown (age 0 = current message), newest last. */
  perTurn: Array<{
    age: number;
    soft: number;
    hard: boolean;
    weight: number;
    norm: number;
  }>;
}

/**
 * Score recent USER turns for a coding-brain swap. `userTexts` is oldest→newest
 * with the current message LAST; assistant turns are excluded by the caller (the
 * coding model emits code-heavy prose, so scoring its replies would bias the
 * ratio toward staying swapped — stuck-mode by the back door).
 */
export function scoreCodingContext(
  userTexts: string[],
  cfg: ContextConfig = CONTEXT_DEFAULTS,
): ContextScore {
  const win = userTexts.slice(-cfg.window);
  const n = win.length;
  let codingSum = 0;
  let totalWeight = 0;
  let hardCarry = 0;
  let anchorCarry = 0;
  let current: TurnIntent = { soft: 0, hard: false, hits: [] };
  const perTurn: ContextScore["perTurn"] = [];
  for (let i = 0; i < n; i++) {
    const age = n - 1 - i; // last element is the current message (age 0)
    const weight = cfg.decay ** age;
    const t = analyzeTurn(win[i] ?? "");
    if (age === 0) current = t;
    const norm = cfg.saturation > 0 ? Math.min(1, t.soft / cfg.saturation) : 0;
    codingSum += weight * norm;
    totalWeight += weight;
    if (t.hard) hardCarry = Math.max(hardCarry, weight);
    if (t.hard || t.soft >= cfg.saturation) anchorCarry = Math.max(anchorCarry, weight);
    perTurn.push({ age, soft: t.soft, hard: t.hard, weight, norm });
  }
  const intensity = totalWeight > 0 ? codingSum / (totalWeight + cfg.prior) : 0;

  // The current message must itself be at least a little code-shaped, else we
  // flip back to the primary no matter how coding-heavy the recent history was.
  const eligible = current.soft > 0 || current.hard;
  const hardSwap = hardCarry >= cfg.hardReleaseFloor;
  const anchorSwap = anchorCarry >= cfg.carryFloor;
  const ratioSwap = intensity >= cfg.ratioThreshold;
  const swap = eligible && (hardSwap || anchorSwap || ratioSwap);

  let reason: string;
  if (!eligible) {
    reason = "ineligible:current-not-code";
  } else if (hardSwap) {
    reason = `hard-carry:${hardCarry.toFixed(2)}>=${cfg.hardReleaseFloor}`;
  } else if (anchorSwap) {
    reason = `anchor-carry:${anchorCarry.toFixed(2)}>=${cfg.carryFloor}`;
  } else {
    reason = `intensity:${intensity.toFixed(2)}${ratioSwap ? ">=" : "<"}${cfg.ratioThreshold}`;
  }

  return {
    swap,
    reason,
    eligible,
    intensity,
    ratioThreshold: cfg.ratioThreshold,
    hardCarry,
    anchorCarry,
    perTurn,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Decision
// ───────────────────────────────────────────────────────────────────────────

export interface SwapDecision {
  /** The model id to pin with `--model`, or undefined to use Pi's default. */
  model?: string;
  /** True when the coding brain was selected for this turn. */
  swapped: boolean;
  /** Why we decided as we did (override:on/off, score, no-coding-model). */
  reason: string;
  /** The computed score (0 when an override or missing coding model short-circuits). */
  score: number;
}

/** Minimal structural shape of a prior turn (decoupled from harness types). */
export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
}

/**
 * Decide which model the Pi harness should pin for this turn.
 *
 * Precedence: a manual `/coder`/`/nocoder` override always wins; otherwise the
 * scorer decides. With NO coding model configured there is nothing to swap to,
 * so we always return the primary (and never claim a swap).
 *
 * Two scoring paths:
 *   - `history` PROVIDED ⇒ context-window scoring (scoreCodingContext): the
 *     current message is judged alongside recent USER turns, recency-decayed,
 *     as a ratio with a smoothing prior. This is the production path (pi.ts
 *     always has history) — it fixes the "follow-up loses the brain" failure.
 *   - `history` ABSENT ⇒ legacy flat per-message scorer vs an absolute
 *     `threshold`. Kept for history-free callers and back-compat.
 *
 * `score` in the returned decision is the legacy flat sum for the *current*
 * message either way (handy for logs); the context path's real numbers live in
 * `reason` (intensity / hard-carry).
 */
export function resolveSwapModel(input: {
  text: string;
  override?: CoderSwapMode;
  primaryModel?: string;
  codingModel?: string;
  /** Absolute threshold for the legacy (history-free) path. */
  threshold?: number;
  /** Prior turns oldest→newest; presence selects the context-window path. */
  history?: ConversationTurn[];
  /** Optional overrides for the context-window dials. */
  context?: Partial<ContextConfig>;
}): SwapDecision {
  const { text, override, primaryModel, codingModel, history } = input;

  if (!codingModel) {
    return { model: primaryModel, swapped: false, reason: "no-coding-model", score: 0 };
  }
  if (override === "off") {
    return { model: primaryModel, swapped: false, reason: "override:off", score: 0 };
  }
  if (override === "on") {
    return { model: codingModel, swapped: true, reason: "override:on", score: 0 };
  }

  // Legacy flat-sum path: no history available.
  if (history === undefined) {
    const threshold = input.threshold ?? CODER_SWAP_THRESHOLD;
    const { score } = scoreCodingIntent(text);
    const swapped = score >= threshold;
    return {
      model: swapped ? codingModel : primaryModel,
      swapped,
      reason: `score:${score}/${threshold}`,
      score,
    };
  }

  // Context-window path: judge the current message alongside recent USER turns.
  const cfg = { ...CONTEXT_DEFAULTS, ...input.context };
  const userTexts = [
    ...history.filter((t) => t.role === "user").map((t) => t.text),
    text,
  ];
  const ctx = scoreCodingContext(userTexts, cfg);
  return {
    model: ctx.swap ? codingModel : primaryModel,
    swapped: ctx.swap,
    reason: ctx.reason,
    score: scoreCodingIntent(text).score,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Per-conversation manual override store (mirrors viewCoder.ts)
// ───────────────────────────────────────────────────────────────────────────

/** Persisted override. "default" is represented as the absence of an entry. */
export type CoderSwapMode = "on" | "off";
export type CoderSwapRequest = CoderSwapMode | "default";

export function normalizeCoderSwapRequest(
  value: unknown,
): CoderSwapRequest | undefined {
  if (value === "on" || value === "enable" || value === "enabled" || value === "force")
    return "on";
  if (value === "off" || value === "disable" || value === "disabled" || value === "no")
    return "off";
  if (value === "default" || value === "clear" || value === "auto" || value === "")
    return "default";
  return undefined;
}

interface StoredOverride {
  mode: CoderSwapMode;
  touchedAt: string;
}

type StoredOverrides = Record<string, StoredOverride>;

export function coderSwapStatePath(): string {
  return (
    process.env.PHANTOMBOT_CODER_SWAP_STATE ??
    join(xdgStateHome(), "phantombot", "coder-swap-overrides.json")
  );
}

function key(persona: string, conversation: string): string {
  return `${persona} ${conversation}`;
}

async function load(path = coderSwapStatePath()): Promise<StoredOverrides> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as StoredOverrides)
      : {};
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
}

async function save(state: StoredOverrides, path = coderSwapStatePath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + "\n", "utf8");
}

/** Read the persistent override for a conversation, or undefined (defer to score). */
export async function getCoderSwapOverride(input: {
  persona: string;
  conversation: string;
}): Promise<CoderSwapMode | undefined> {
  const state = await load();
  return state[key(input.persona, input.conversation)]?.mode;
}

/** Force the override to "on" or "off" for a conversation. */
export async function setCoderSwapOverride(input: {
  persona: string;
  conversation: string;
  mode: CoderSwapMode;
  now?: Date;
}): Promise<void> {
  const path = coderSwapStatePath();
  const state = await load(path);
  state[key(input.persona, input.conversation)] = {
    mode: input.mode,
    touchedAt: (input.now ?? new Date()).toISOString(),
  };
  await save(state, path);
}

/** Clear the override → conversation defers to the scorer. */
export async function clearCoderSwapOverride(input: {
  persona: string;
  conversation: string;
}): Promise<void> {
  const path = coderSwapStatePath();
  const state = await load(path);
  delete state[key(input.persona, input.conversation)];
  await save(state, path);
}

/** Apply a normalized request: "on"/"off" persist; "default" clears. */
export async function applyCoderSwapRequest(input: {
  persona: string;
  conversation: string;
  request: CoderSwapRequest;
  now?: Date;
}): Promise<void> {
  if (input.request === "default") {
    await clearCoderSwapOverride(input);
    return;
  }
  await setCoderSwapOverride({
    persona: input.persona,
    conversation: input.conversation,
    mode: input.request,
    now: input.now,
  });
}
