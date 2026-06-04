/**
 * Threat-screen wiring for untrusted turns.
 *
 * `makeScreener` builds the `screen` function runTurn calls on every
 * UNTRUSTED turn (trusted turns skip it — the authenticated principal is
 * the gate). It is the side-effecting orchestration around the pure judge
 * in lib/threatJudge.ts, in the same shape as makeRetriever: a factory that
 * closes over config and returns an injectable per-turn function.
 *
 * Flow, all IN CODE so a model can never fake it (the bug that started this
 * whole redesign was a model *claiming* it had notified/recorded):
 *
 *   1. RECALL — semantic-search the decisions drawer for how Andrew has
 *      ruled on similar matters before. Best-effort; failure → no priors.
 *      Priors only ever LOWER scrutiny for things he already blessed; they
 *      never clear it (the judge is told a catastrophic action re-escalates
 *      regardless).
 *   2. JUDGE — run the tool-less harness judge over the content + priors.
 *      It returns a score 0–100. The judge has no tools, so it cannot act
 *      on what it reads; we consume only its number.
 *   3. score <  THREAT_THRESHOLD → {action:"pass"}; the turn proceeds
 *      silently. No notification — quiet when safe (Andrew's "don't nag").
 *   4. score >= THREAT_THRESHOLD → HOLD (fail-closed):
 *        - The untrusted turn does NOTHING. runTurn returns the heldMessage
 *          instead of running the harness. Untrusted entry points are
 *          one-shot, so "held" == the action simply never happened — the
 *          fail-closed default Andrew chose (option b). There is no paused
 *          process to time out; if he wants it done, he says so.
 *        - `phantombot notify` opens a CONVERSATION on Telegram (in CODE):
 *          what arrived, why it tripped, and the concern to weigh —
 *          phrased to be talked through, not answered yes/no.
 *
 * What the screener deliberately does NOT do: write a decision. Decisions
 * are recorded ONLY from a TRUSTED turn — i.e. when Andrew talks it through
 * on Telegram and concludes. The judge writes nothing; the untrusted turn
 * writes nothing. That is the whole point: an attacker can never author
 * "Andrew approved this". His trusted reply is the only thing that records
 * a ruling, and that ruling is what recall reads next time.
 *
 * Fail-OPEN on judge/recall error by design: if screening itself errors
 * (harness down, bad JSON), the screener returns "pass" and logs. A
 * screening outage degrades to "unscreened", never "app down" — chasing
 * fail-closed on infrastructure hiccups would enshittify the assistant.
 * The trusted-source gate remains the real floor regardless. (Note this is
 * distinct from the HOLD fail-closed in step 4, which is about an
 * answered-vs-unanswered escalation, not an infra error.)
 */

import {
  type Config,
  memoryIndexPath,
  personaDir,
} from "../config.ts";
import { geminiEmbed } from "../lib/geminiEmbed.ts";
import type { Harness } from "../harnesses/types.ts";
import { log } from "../lib/logger.ts";
import { MemoryIndex, type SearchHit } from "../lib/memoryIndex.ts";
import {
  judgeThreat,
  makeChainJudgeComplete,
  THREAT_THRESHOLD,
  type JudgeResult,
} from "../lib/threatJudge.ts";
import { runNotify } from "../cli/notify.ts";

export interface ScreenVerdict {
  /** "pass" → run the turn normally; "hold" → already escalated, stop. */
  action: "pass" | "hold";
  /** Threat score (0–100). */
  score: number;
  /** Why — the judge's rationale. */
  reason: string;
  /** The concern put to the principal (hold only). */
  question?: string;
  /** What runTurn shows the untrusted caller in place of a real reply. */
  heldMessage?: string;
}

const PASS_ON_ERROR = (score: number, reason: string): ScreenVerdict => ({
  action: "pass",
  score,
  reason,
});

/** How many prior rulings to recall and feed the judge. */
const RECALL_LIMIT = 5;

export interface ScreenerDeps {
  /** Override recall (tests). Returns prior-rulings text, or "" for none. */
  recall?: (content: string, signal?: AbortSignal) => Promise<string>;
  /** Override the judge (tests). */
  judge?: (
    content: string,
    priors: string,
    signal?: AbortSignal,
  ) => Promise<JudgeResult>;
  /** Override the notify side-effect (tests). Returns 0 on success. */
  notify?: (message: string) => Promise<number>;
}

/**
 * Build the per-turn screen function for `persona` / `conversation`.
 *
 * Unlike the previous Gemini-keyed design, this ALWAYS returns a screener:
 * the judge runs on the harness, which is always present, so there is no
 * "no key ⇒ screening silently off" hole. (Only RECALL degrades without
 * embeddings, and it degrades to FTS / no-priors, never to no-screening.)
 */
export function makeScreener(
  config: Config,
  persona: string,
  // Decisions/recall are global to the persona, not conversation-scoped, so
  // this is unused today — kept for call-site symmetry with makeRetriever and
  // so a future conversation-scoped recall needs no signature change.
  _conversation: string,
  // The turn's harness chain — the judge runs on the claude harness in it.
  // No claude in the chain (e.g. a test fake chain) → screening fails open
  // and spawns nothing.
  harnesses: Harness[],
  deps: ScreenerDeps = {},
): (content: string, signal?: AbortSignal) => Promise<ScreenVerdict> {
  const recall = deps.recall ?? makeDecisionRecall(config, persona);

  const judge =
    deps.judge ??
    (() => {
      const complete = makeChainJudgeComplete(harnesses, config);
      if (!complete) {
        // No claude harness available to screen with — fail open.
        return async (): Promise<JudgeResult> => ({
          ok: false,
          error: "no claude harness in chain for screening",
        });
      }
      return (content: string, priors: string, signal?: AbortSignal) =>
        judgeThreat(content, { complete, priors, signal });
    })();

  const notify =
    deps.notify ?? ((message: string) => runNotify({ config, message }));

  return async (content: string, signal?: AbortSignal): Promise<ScreenVerdict> => {
    // 1. Recall prior rulings (best-effort; never throws → "").
    let priors = "";
    try {
      priors = await recall(content, signal);
    } catch (e) {
      log.warn(`screen: recall failed, judging without priors: ${(e as Error).message}`);
    }

    // 2. Judge (fail-open on any judge error).
    let result: JudgeResult;
    try {
      result = await judge(content, priors, signal);
    } catch (e) {
      log.warn(`screen: judge threw, failing open: ${(e as Error).message}`);
      return PASS_ON_ERROR(0, "screen error (failed open)");
    }
    if (!result.ok) {
      log.warn(`screen: judge unavailable, failing open: ${result.error}`);
      return PASS_ON_ERROR(0, `screen unavailable (failed open): ${result.error}`);
    }

    const v = result.verdict;
    if (v.score < THREAT_THRESHOLD) {
      return { action: "pass", score: v.score, reason: v.reason };
    }

    // 3. HOLD — fail-closed (the turn does nothing) + notify conversationally.
    const concern =
      v.question && v.question.trim().length > 0
        ? v.question.trim()
        : "I'm not sure this is safe to act on — can we talk it through?";
    const preview = content.replace(/\s+/g, " ").trim().slice(0, 280);
    const notifyMessage =
      `🔒 I held an untrusted request (threat ${v.score}/100) — nothing was done.\n` +
      `Why: ${v.reason}\n` +
      `What it asked: "${preview}"\n` +
      `${concern}`;

    try {
      const code = await notify(notifyMessage);
      if (code !== 0) log.warn(`screen: notify exited ${code} for held request`);
    } catch (e) {
      log.warn(`screen: notify failed for held request: ${(e as Error).message}`);
    }

    return {
      action: "hold",
      score: v.score,
      reason: v.reason,
      question: concern,
      heldMessage:
        "🔒 That request touched something sensitive, so I've paused it and " +
        "pinged Andrew to talk it through before doing anything. Nothing was done.",
    };
  };
}

/**
 * Production recall: semantic-search the persona's decisions drawer for
 * rulings relevant to the incoming content, rendered as a priors block for
 * the judge. Hybrid (FTS + vector) when embeddings are configured and
 * populated, FTS-only otherwise. Never throws — any failure resolves to ""
 * (judge without priors), mirroring retrieval.ts's hot-path guarantee.
 */
export function makeDecisionRecall(
  config: Config,
  persona: string,
): (content: string, signal?: AbortSignal) => Promise<string> {
  return async (content: string, signal?: AbortSignal): Promise<string> => {
    const query = content.trim();
    if (query.length === 0) return "";

    let ix: MemoryIndex | undefined;
    try {
      // Resolve paths lazily inside the guard: a degenerate config must
      // degrade to "no priors", never throw on the screening hot path.
      const indexPath = memoryIndexPath(persona);
      const dir = personaDir(config, persona);
      ix = await MemoryIndex.open(indexPath);
      await ix.refreshStale(dir);

      let queryVec: Float32Array | undefined;
      if (
        config.embeddings.provider === "gemini" &&
        config.embeddings.gemini?.apiKey &&
        ix.embeddingCount() > 0
      ) {
        const r = await geminiEmbed(config.embeddings.gemini.apiKey, query, {
          model: config.embeddings.gemini.model,
          dims: config.embeddings.gemini.dims,
          signal,
        });
        if (r.ok) queryVec = r.values;
        else log.warn(`screen recall: query embed failed; FTS-only (${r.error})`);
      }

      // Scope to memory/ — that's where the decisions drawer lives. kb/ and
      // conversation turns are noise for "have we ruled on this before".
      const hits = queryVec
        ? ix.hybridSearch(query, queryVec, { scope: "memory", limit: RECALL_LIMIT })
        : ix.search(query, { scope: "memory", limit: RECALL_LIMIT });

      return renderPriors(hits);
    } catch (e) {
      log.warn(`screen recall: failed; judging without priors (${(e as Error).message})`);
      return "";
    } finally {
      ix?.close();
    }
  };
}

/** Render recalled hits into the priors text the judge sees. */
function renderPriors(hits: SearchHit[]): string {
  const lines = hits
    .map((h) => h.snippet.replace(/[«»]/g, "").replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
  if (lines.length === 0) return "";
  return lines.map((l) => `- ${l}`).join("\n");
}
