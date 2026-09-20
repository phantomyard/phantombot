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
 *   1. HARD LATENCY CAP. The default is 300 ms (JEV_ROUTER_DEFAULT_TIMEOUT_MS).
 *      Exceeding the budget degrades to the keyword score — a slow Jev must
 *      never stall a turn.
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
 * Hard default wall-clock cap for a routing decision. Jev's own p50 is far
 * below this; the cap exists so a degraded endpoint costs one scorer
 * fallback, not a stalled turn.
 */
export const JEV_ROUTER_DEFAULT_TIMEOUT_MS = 300;

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

const ROUTER_TOOL = "route_turn";
const ROUTER_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    route: {
      type: "string",
      enum: ["primary", "coder"],
      description:
        "coder = a substantial coding job (write/review/debug/refactor code, work a PR); primary = everything else.",
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "Calibrated confidence in the chosen route.",
    },
  },
  required: ["route", "confidence"],
  additionalProperties: false,
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
    system: ROUTER_SYSTEM,
    prompt,
    tool: ROUTER_TOOL,
    description: "Route the next turn to the primary or coder brain.",
    parameters: ROUTER_PARAMETERS,
    timeoutMs: opts.settings.timeoutMs ?? JEV_ROUTER_DEFAULT_TIMEOUT_MS,
    signal: opts.signal,
    fetchImpl: opts.fetchImpl,
  });
  if (!decision.ok) {
    return { ok: false, error: decision.error, latencyMs: decision.latencyMs };
  }

  const route = decision.args.route;
  if (route !== "primary" && route !== "coder") {
    return {
      ok: false,
      error: `jev returned out-of-schema route ${JSON.stringify(route)}`,
      latencyMs: decision.latencyMs,
    };
  }
  const rawConfidence = Number(decision.args.confidence);
  return {
    ok: true,
    route,
    confidence: Number.isFinite(rawConfidence)
      ? Math.max(0, Math.min(1, rawConfidence))
      : 0.5,
    latencyMs: decision.latencyMs,
  };
}

function clip(text: string): string {
  return text.length > ROUTER_TURN_CAP_CHARS
    ? text.slice(0, ROUTER_TURN_CAP_CHARS) + "\n[truncated]"
    : text;
}
