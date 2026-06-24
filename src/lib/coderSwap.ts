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
 * Score a piece of text for "probable coding job" intent. Pure, allocation-
 * light, no I/O. Each distinct signal contributes its weight at most once.
 */
export function scoreCodingIntent(text: string): CodingScore {
  if (!text) return { score: 0, hits: [] };
  let score = 0;
  const hits: string[] = [];
  for (const sig of SIGNALS) {
    if (sig.pattern.test(text)) {
      score += sig.weight;
      hits.push(sig.id);
    }
  }
  return { score, hits };
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

/**
 * Decide which model the Pi harness should pin for this turn.
 *
 * Precedence: a manual `/coder`/`/nocoder` override always wins; otherwise the
 * scorer decides. With NO coding model configured there is nothing to swap to,
 * so we always return the primary (and never claim a swap).
 */
export function resolveSwapModel(input: {
  text: string;
  override?: CoderSwapMode;
  primaryModel?: string;
  codingModel?: string;
  threshold?: number;
}): SwapDecision {
  const { text, override, primaryModel, codingModel } = input;
  const threshold = input.threshold ?? CODER_SWAP_THRESHOLD;

  if (!codingModel) {
    return { model: primaryModel, swapped: false, reason: "no-coding-model", score: 0 };
  }
  if (override === "off") {
    return { model: primaryModel, swapped: false, reason: "override:off", score: 0 };
  }
  if (override === "on") {
    return { model: codingModel, swapped: true, reason: "override:on", score: 0 };
  }
  const { score } = scoreCodingIntent(text);
  const swapped = score >= threshold;
  return {
    model: swapped ? codingModel : primaryModel,
    swapped,
    reason: `score:${score}/${threshold}`,
    score,
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
