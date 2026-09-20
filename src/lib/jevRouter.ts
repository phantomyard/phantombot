/**
 * The brain-swap routing decision on a Jev backend (issue #597).
 *
 * Today the `primary | coder` choice in front of every Pi turn is made by
 * coderSwap.ts: a deterministic weighted-keyword score. Free and instant,
 * but blind in both directions — a stack trace pasted with "why is this
 * failing?" scores 0, while a passing mention of "merge" in chat can hard-
 * trigger the coding brain onto a conversational turn. Jev's shape fits the
 * gap exactly: a bounded two-way choice, ~200 ms, ~$0.00004, on a vendor and
 * quota pool independent of the harness chain.
 *
 * THE EXISTING SCORER STAYS THE DEFAULT AND THE FALLBACK — this module never
 * replaces it, it advises or precedes it:
 *
 *   - shadow mode: the scorer decides; Jev is asked ALONGSIDE and the two
 *     answers are logged. Divergences are the evidence for promotion.
 *   - active mode: Jev decides; any error, timeout or missing key degrades
 *     to the scorer with no behaviour change beyond a log line.
 *
 * Two properties keep this safe to sit on the critical path of EVERY turn:
 *
 *   1. HARD LATENCY CAP. The default is 800 ms (JEV_ROUTER_DEFAULT_TIMEOUT_MS),
 *      sized from the live corpus (a 300 ms cap times out on realistic
 *      states). Exceeding the budget degrades to the keyword score — a slow
 *      Jev must never stall a turn.
 *   2. THE MANUAL OVERRIDE ALWAYS WINS. `/coder` / `/nocoder` are the
 *      operator's explicit word; the caller checks them BEFORE consulting
 *      this module, so Jev can never overrule a human.
 *
 * The acceptance bar here is ROUTING QUALITY (a wrong answer is a worse
 * reply), deliberately separate from the threat judge's bar (a wrong answer
 * is an unscreened prompt): separate threshold, separate shadow evidence,
 * separate rollout gate.
 */

import { jevDecide, JEV_DEFAULT_MODEL, type JevFetch } from "./jev.ts";

/**
 * Hard default wall-clock cap for a routing decision. Sized from the live
 * router corpus (2026-09-20): short states return in ~280-300 ms but
 * realistic ones (a pasted trace, a PR description) run 300-600 ms, so the
 * original 300 ms cap timed out 8/10 corpus cases — a cap the endpoint's
 * own p50 exceeds just makes active mode a permanent fallback. 800 ms
 * keeps the guarantee that matters: a DEGRADED endpoint costs one instant
 * scorer fallback, never a stalled turn.
 */
export const JEV_ROUTER_DEFAULT_TIMEOUT_MS = 800;

export type JevRoute = "primary" | "coder";

export interface JevRouterSettings {
  baseUrl: string;
  apiKey: string;
  model?: string;
  timeoutMs?: number;
}

export type JevRouteResult =
  | { ok: true; route: JevRoute; confidence: number; latencyMs: number }
  | { ok: false; error: string; latencyMs: number };

/** How many recent user turns the router shows Jev for context. */
const ROUTER_HISTORY_TURNS = 4;
/** Per-turn cap so one pasted log can't eat the tiny prompt budget. */
const ROUTER_TURN_CAP_CHARS = 1200;

/**
 * The routing choice, as a Jev choice question — the criteria KEYS are the
 * routes. The answer's own calibrated confidence travels with it, so unlike
 * a chat-completions forced tool call there is no need to ASK the model for
 * a confidence number.
 */
const ROUTER_QUESTION = {
  type: "choice" as const,
  instructions: "Which brain answers the NEXT user message?",
  criteria: {
    primary:
      "Conversation, questions, planning, admin, small talk — even if it casually mentions code words without coding work to do",
    coder:
      "A substantial coding job: writing, reviewing, debugging, refactoring or explaining real code; working a pull/merge request; acting on a pasted stack trace, log, diff, or CI/build/test failure",
  },
};

const ROUTER_SYSTEM = `You decide which brain answers the NEXT user message in an ongoing chat with a personal assistant: the PRIMARY brain (a fast, personable general model) or the CODER brain (a heavyweight programming model).

Route to CODER when the message is a substantial coding job: writing, reviewing, debugging, refactoring or explaining real code; working a pull/merge request; reading a pasted stack trace, log or diff with intent to fix; CI, build or test failures to act on.

Route to PRIMARY when the message is conversation, questions, planning, admin, small talk — even if it casually mentions code words ("merge", "a repo", "deploy") without coding work to do.

Recent user messages are shown oldest-first for context. A short natural-language follow-up INSIDE an active coding job ("what about the error handling?") stays CODER; once the topic genuinely moves off code, route PRIMARY. Judge the CURRENT message in that context.`;

/**
 * Ask Jev whether the next turn should run on the primary or the coder.
 * Never throws — { ok: false } means "use the keyword scorer".
 */
export async function jevRoute(opts: {
  settings: JevRouterSettings;
  /** The current user message. */
  text: string;
  /** Recent USER turns, oldest → newest (current message excluded). */
  history?: string[];
  signal?: AbortSignal;
  fetchImpl?: JevFetch;
}): Promise<JevRouteResult> {
  const recent = (opts.history ?? []).slice(-ROUTER_HISTORY_TURNS);
  const lines = recent.map(
    (t, i) => `<turn ${i + 1}>\n${clip(t)}\n</turn ${i + 1}>`,
  );
  const prompt =
    (lines.length > 0 ? `Recent user messages:\n${lines.join("\n")}\n\n` : "") +
    `Current message:\n<current>\n${clip(opts.text)}\n</current>`;

  const decision = await jevDecide({
    baseUrl: opts.settings.baseUrl,
    apiKey: opts.settings.apiKey,
    model: opts.settings.model ?? JEV_DEFAULT_MODEL,
    instructions: ROUTER_SYSTEM,
    state: prompt,
    questions: { route: ROUTER_QUESTION },
    timeoutMs: opts.settings.timeoutMs ?? JEV_ROUTER_DEFAULT_TIMEOUT_MS,
    signal: opts.signal,
    fetchImpl: opts.fetchImpl,
  });
  if (!decision.ok) {
    return { ok: false, error: decision.error, latencyMs: decision.latencyMs };
  }

  const answer = decision.answers.route;
  if (
    answer?.type !== "choice" ||
    (answer.choice !== "primary" && answer.choice !== "coder")
  ) {
    return {
      ok: false,
      error: "jev returned an out-of-schema route",
      latencyMs: decision.latencyMs,
    };
  }
  return {
    ok: true,
    route: answer.choice,
    confidence: Math.max(0, Math.min(1, answer.confidence)),
    latencyMs: decision.latencyMs,
  };
}

function clip(text: string): string {
  return text.length > ROUTER_TURN_CAP_CHARS
    ? text.slice(0, ROUTER_TURN_CAP_CHARS) + "\n[truncated]"
    : text;
}
