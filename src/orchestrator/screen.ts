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
 *   1. BRIEFING — semantic-search the threat-relevant drawers (decisions =
 *      prior rulings, people = known senders, norms = what's routine in
 *      Andrew's world) so the judge isn't an amnesiac that cry-wolfs on
 *      normal operations. DELIBERATELY scoped to those three drawers, NOT a
 *      raw memory dump: the judge does not need Andrew's finances/inbox to
 *      score a threat, and keeping them out means they never land in a judge
 *      log either. Best-effort; failure → no priors. Prior rulings only ever
 *      LOWER scrutiny for things he already blessed; they never clear it (the
 *      judge is told a catastrophic action re-escalates regardless).
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
  // The turn's harness chain — the judge runs on the PRIMARY harness in it
  // (chain[0], whichever binary the user configured). An empty chain (e.g. a
  // test fake chain with no harness) → screening fails open and spawns nothing.
  harnesses: Harness[],
  deps: ScreenerDeps = {},
): (content: string, signal?: AbortSignal) => Promise<ScreenVerdict> {
  const recall = deps.recall ?? makeJudgeBriefing(config, persona);

  const judge =
    deps.judge ??
    (() => {
      // Spawn the judge in the persona's own dir, never the ambient cwd — an
      // inaccessible cwd makes the harness spawn EACCES, which would fail the
      // screen OPEN (silently unscreened). personaDir is owned by the running
      // persona user; threatJudge floors it at homedir() as a backstop. Resolve
      // defensively: a degenerate config must degrade to that floor, not throw
      // on the screening path.
      let judgeCwd: string | undefined;
      try {
        judgeCwd = personaDir(config, persona);
      } catch {
        judgeCwd = undefined; // → threatJudge floors at homedir()
      }
      const complete = makeChainJudgeComplete(harnesses, config, judgeCwd);
      if (!complete) {
        // No harness available to screen with (empty chain) — fail open.
        return async (): Promise<JudgeResult> => ({
          ok: false,
          error: "no harness in chain for screening",
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
 * The threat judge's briefing drawers — and ONLY these. Decisions (prior
 * rulings), people (known senders), norms (what's routine in Andrew's world).
 * Scoping the briefing to these three keeps it threat-relevant and keeps
 * sensitive operational memory (finances, inbox, daily dumps, commitments)
 * out of the judge entirely — both for signal-to-noise and so they never
 * appear in a judge log. Paths are relative to the persona dir.
 */
const BRIEFING_DRAWERS: readonly string[] = [
  "memory/decisions.md",
  "memory/people.md",
  "memory/norms.md",
];

/**
 * Production briefing: semantic-search the persona's threat-relevant drawers
 * (decisions + people + norms) for context relevant to the incoming content,
 * rendered as a priors block for the judge. Hybrid (FTS + vector) when
 * embeddings are configured and populated, FTS-only otherwise. Filters hits
 * to BRIEFING_DRAWERS so the judge is briefed, not handed the whole memory
 * store. Never throws — any failure resolves to "" (judge without priors),
 * mirroring retrieval.ts's hot-path guarantee.
 */
export function makeJudgeBriefing(
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
        else log.warn(`screen briefing: query embed failed; FTS-only (${r.error})`);
      }

      // Scope to memory/ at the index layer, then narrow to the briefing
      // drawers in code (the index has no per-file filter). Over-fetch so the
      // post-filter still has RECALL_LIMIT briefing-drawer hits to choose from.
      const raw = queryVec
        ? ix.hybridSearch(query, queryVec, { scope: "memory", limit: RECALL_LIMIT * 4 })
        : ix.search(query, { scope: "memory", limit: RECALL_LIMIT * 4 });
      const hits = raw
        .filter((h) => BRIEFING_DRAWERS.includes(h.path))
        .slice(0, RECALL_LIMIT);

      return renderPriors(hits);
    } catch (e) {
      log.warn(`screen briefing: failed; judging without priors (${(e as Error).message})`);
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
