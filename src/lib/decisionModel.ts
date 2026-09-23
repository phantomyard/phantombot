/**
 * TypeSafe Jev client — ONE typed decision per call.
 *
 * Jev is not an LLM. It is a "System One" model: unstructured text in, a
 * typed choice with a calibrated probability out — no free-text generation
 * at all. That shape matches two phantombot decision points exactly:
 *
 *   1. the THREAT JUDGE (lib/decisionModelJudge.ts) — screening untrusted input before
 *      a capable turn runs;
 *   2. the BRAIN-SWAP router (lib/decisionModelRouter.ts) — the `primary | coder`
 *      routing choice in front of every Pi turn.
 *
 * This module is the SHARED plumbing for both: one credential resolution
 * contract (the caller hands us a key), one endpoint shape, one timeout /
 * error mapping. The two consumers deliberately keep their own questions,
 * scales and thresholds — a router failure must never leak into the judge
 * and vice versa (issue #597).
 *
 * WIRE CONTRACT — the Jev DECISIONS API, not chat/completions. Jev is a
 * decisions-only model: the chat/completions endpoint rejects it with HTTP
 * 400 ("is a decisions model ... Use the /api/alpha/decisions endpoint
 * instead"), verified live against OpenRouter 2026-09-20. The decisions
 * request is:
 *
 *   POST {base}/api/alpha/decisions
 *   { model, instructions, state, questions: { <qid>: question } }
 *
 *   - instructions: the classifier frame (what the harness judge would carry
 *     as its system prompt);
 *   - state: the untrusted payload the decision is ABOUT;
 *   - questions: a RECORD (not an array) of typed questions. Each carries a
 *     `type` discriminator, a per-question `instructions` line, and
 *     `criteria`:
 *       - { type: "choice", instructions, criteria: { <choice>: <description> } }
 *         — the criteria KEYS are the choice set (max DECISION_MODEL_MAX_CHOICES);
 *       - { type: "score", instructions, criteria: [ <level label>, ... ] }
 *         — an ordinal scale; criteria index IS the level, max
 *         DECISION_MODEL_MAX_SCORE_LEVELS (10) levels.
 *
 * The response is `{ answers: { <qid>: answer }, usage }` where a choice
 * answer is `{ type, choice, probabilities, confidence }` and a score answer
 * is `{ type, score (float expectation over the levels), legend,
 * probabilities, confidence }`. Probabilities are calibrated — the router
 * consumes the answer's own confidence instead of asking for a number.
 *
 * Availability posture: Jev is a DIFFERENT vendor, credential and quota pool
 * to the claude/codex/pi harness chain. That independence is the point — a
 * fleet-wide harness quota outage no longer takes the security control down
 * with it — but it cuts both ways: Jev being down must never take a TURN
 * down. Every caller treats { ok: false } as "fall back to the existing
 * method", never as an error worth surfacing mid-turn.
 *
 * Cost: ~$0.042/Mtok input, output free (OpenRouter listing, 2026-09);
 * measured ~$0.00002 per two-question judge call. A judge call is a few
 * hundred tokens; a router call fewer. Both are effectively free per
 * decision, which is what makes running it in front of EVERY turn
 * affordable.
 */

import { timeoutSignal } from "./fetchTimeout.ts";

/** The model id as listed on OpenRouter (`typesafe/jev-1.13`). */
export const DECISION_MODEL_DEFAULT_MODEL = "typesafe/jev-1.13";

/** OpenRouter's OpenAI-compatible base URL. */
export const DECISION_MODEL_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Default base URL for the DIRECT TypeSafe provider. A starting point for the
 * wizard's prefill, not a verified constant — the direct API is not publicly
 * documented at the path level, so the wizard asks the operator to confirm
 * it against their TypeSafe dashboard, and `base_url` in `[jev]` overrides
 * it. OpenRouter needs no such guesswork.
 */
export const DECISION_MODEL_TYPESAFE_BASE_URL = "https://api.typesafe.ai/v1";

/** The vault/env name a Jev API key lives under by default. */
export const DECISION_MODEL_DEFAULT_KEY_ENV = "PHANTOMBOT_JEV_API_KEY";

/** Vendor cap: a choice question's criteria may not exceed 255 entries. */
export const DECISION_MODEL_MAX_CHOICES = 255;

/** Vendor cap: a score question's ordinal scale may not exceed 10 levels. */
export const DECISION_MODEL_MAX_SCORE_LEVELS = 10;

/** A choice question: the criteria KEYS are the choice set. */
export interface DecisionModelChoiceQuestion {
  type: "choice";
  /** What this question asks, in one line. */
  instructions: string;
  /** choice id → one-line description of when it applies. */
  criteria: Record<string, string>;
}

/** A score question: an ordinal scale, criteria index IS the level. */
export interface DecisionModelScoreQuestion {
  type: "score";
  /** What this question asks, in one line. */
  instructions: string;
  /** Level labels, lowest first; at most DECISION_MODEL_MAX_SCORE_LEVELS entries. */
  criteria: string[];
}

export type DecisionModelQuestion = DecisionModelChoiceQuestion | DecisionModelScoreQuestion;

export interface DecisionModelDecisionRequest {
  /** OpenAI-compatible base URL (no trailing slash), e.g. OpenRouter's. */
  baseUrl: string;
  /** Bearer token for the endpoint. */
  apiKey: string;
  /** Model id, e.g. `typesafe/jev-1.13`. */
  model: string;
  /** The classifier frame — what an LLM judge would carry as its system prompt. */
  instructions: string;
  /** The payload the decision is ABOUT (untrusted content for the judge). */
  state: string;
  /** The typed questions, keyed by caller-chosen id. */
  questions: Record<string, DecisionModelQuestion>;
  /** Hard wall-clock cap. Exceeding it is an { ok: false }, never a stall. */
  timeoutMs: number;
  /** Optional caller cancellation, composed with the timeout. */
  signal?: AbortSignal;
  /**
   * Test seam — production omits this and gets the global fetch. Typed as a
   * plain function (not `typeof fetch`) so tests can pass a bare arrow
   * without Bun's `preconnect` property getting in the way.
   */
  fetchImpl?: DecisionModelFetch;
}

/** The minimal slice of fetch this module uses. */
export type DecisionModelFetch = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type DecisionModelAnswer =
  | {
      type: "choice";
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
    }
  | {
      type: "score";
      /** Float expectation over the ordinal levels (0 .. levels-1). */
      score: number;
      legend: Record<string, unknown>;
      probabilities: Record<string, number>;
      confidence: number;
    };

export type DecisionModelDecision =
  | { ok: true; answers: Record<string, DecisionModelAnswer>; latencyMs: number }
  | { ok: false; error: string; latencyMs: number };

/**
 * Derive the decisions endpoint from an OpenAI-compatible base URL.
 * OpenRouter keeps it next to /api/v1 at /api/alpha/decisions; the same
 * derivation is the best available guess for a direct TypeSafe base URL
 * (operator-confirmed at configure time — see DECISION_MODEL_TYPESAFE_BASE_URL).
 */
export function decisionModelDecisionsUrl(baseUrl: string): string {
  let base = baseUrl.replace(/\/+$/, "");
  if (base.endsWith("/v1")) base = base.slice(0, -"/v1".length);
  return base.endsWith("/api")
    ? `${base}/alpha/decisions`
    : `${base}/api/alpha/decisions`;
}

interface DecisionsResponse {
  answers?: Record<string, unknown>;
  error?: { message?: string };
}

/** Validate the caller's question set against the vendor's caps. */
function questionsError(
  questions: Record<string, DecisionModelQuestion>,
): string | undefined {
  const ids = Object.keys(questions);
  if (ids.length === 0) return "jev: at least one question is required";
  for (const id of ids) {
    const q = questions[id]!;
    if (q.type === "choice") {
      const n = Object.keys(q.criteria).length;
      if (n === 0) return `jev: choice question '${id}' has no choices`;
      if (n > DECISION_MODEL_MAX_CHOICES)
        return `jev: choice question '${id}' has ${n} choices (max ${DECISION_MODEL_MAX_CHOICES})`;
    } else if (q.type === "score") {
      if (q.criteria.length === 0)
        return `jev: score question '${id}' has no levels`;
      if (q.criteria.length > DECISION_MODEL_MAX_SCORE_LEVELS)
        return (
          `jev: score question '${id}' has ${q.criteria.length} levels ` +
          `(max ${DECISION_MODEL_MAX_SCORE_LEVELS})`
        );
    } else {
      return `jev: question '${id}' has unknown type`;
    }
  }
  return undefined;
}

function asNumberRecord(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = n;
    }
  }
  return out;
}

/**
 * Parse one answer against the QUESTION that produced it — a choice answer
 * must name one of the criteria keys, a score answer a finite number
 * inside the question's ordinal range. The
 * wire is trusted to be JSON, nothing more.
 */
function parseAnswer(q: DecisionModelQuestion, raw: unknown): DecisionModelAnswer | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const a = raw as Record<string, unknown>;
  if (q.type === "choice") {
    if (a.type !== "choice" || typeof a.choice !== "string") return undefined;
    if (!(a.choice in q.criteria)) return undefined;
    return {
      type: "choice",
      choice: a.choice,
      probabilities: asNumberRecord(a.probabilities),
      confidence: Number.isFinite(Number(a.confidence)) ? Number(a.confidence) : 0,
    };
  }
  if (a.type !== "score") return undefined;
  // Number(null) and Number("") are both 0, so a malformed provider answer
  // would otherwise read as the most benign level on the scale. Demand an
  // actual finite number, inside the ordinal range this question defines.
  if (typeof a.score !== "number" || !Number.isFinite(a.score)) return undefined;
  const score = a.score;
  if (score < 0 || score > q.criteria.length - 1) return undefined;
  return {
    type: "score",
    score,
    legend:
      a.legend && typeof a.legend === "object" && !Array.isArray(a.legend)
        ? (a.legend as Record<string, unknown>)
        : {},
    probabilities: asNumberRecord(a.probabilities),
    confidence: Number.isFinite(Number(a.confidence)) ? Number(a.confidence) : 0,
  };
}

/**
 * Ask Jev for one typed decision. Never throws: every failure — network,
 * timeout, HTTP error, malformed or missing answers — comes back as
 * { ok: false, error } so the caller can fall back to its existing method.
 */
export async function decisionModelDecide(
  req: DecisionModelDecisionRequest,
): Promise<DecisionModelDecision> {
  const started = Date.now();
  const latencyMs = () => Date.now() - started;

  const contractError = questionsError(req.questions);
  if (contractError) {
    return { ok: false, error: contractError, latencyMs: latencyMs() };
  }

  const doFetch: DecisionModelFetch = req.fetchImpl ?? fetch;
  const body = {
    model: req.model,
    instructions: req.instructions,
    state: req.state,
    questions: req.questions,
  };

  let res: Response;
  try {
    res = await doFetch(decisionModelDecisionsUrl(req.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${req.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: timeoutSignal(req.timeoutMs, req.signal),
    });
  } catch (e) {
    const err = e as Error;
    const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
    return {
      ok: false,
      error: timedOut
        ? `jev timeout after ${req.timeoutMs}ms`
        : `jev request failed: ${err.message}`,
      latencyMs: latencyMs(),
    };
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    // A gateway firewall (Cloudflare in front of OpenRouter) answers with an
    // HTML page — sometimes wrapped in OpenRouter's JSON error envelope. It
    // blocks request BODIES that match attack signatures (e.g. a
    // `curl … | sh` line), which for the threat judge is exactly the content
    // it exists to see. Say so instead of logging the first 200 characters
    // of markup; the caller's fallback (harness judge / keyword scorer) is
    // unchanged.
    if (/<!DOCTYPE html|<html[\s>]/i.test(text)) {
      return {
        ok: false,
        error:
          `jev http ${res.status}: blocked by the provider's web firewall (HTML error page) — ` +
          "the request content likely matched an attack signature",
        latencyMs: latencyMs(),
      };
    }
    const detail = text.replace(/\s+/g, " ").trim().slice(0, 200);
    return {
      ok: false,
      error: `jev http ${res.status}${detail ? `: ${detail}` : ""}`,
      latencyMs: latencyMs(),
    };
  }

  let parsed: DecisionsResponse;
  try {
    parsed = JSON.parse(text) as DecisionsResponse;
  } catch {
    return { ok: false, error: "jev returned non-JSON", latencyMs: latencyMs() };
  }
  if (parsed.error?.message) {
    return {
      ok: false,
      error: `jev error: ${parsed.error.message.slice(0, 200)}`,
      latencyMs: latencyMs(),
    };
  }
  if (!parsed.answers || typeof parsed.answers !== "object") {
    return {
      ok: false,
      error: "jev returned no answers",
      latencyMs: latencyMs(),
    };
  }

  const answers: Record<string, DecisionModelAnswer> = {};
  for (const [qid, q] of Object.entries(req.questions)) {
    const answer = parseAnswer(q, parsed.answers[qid]);
    if (!answer) {
      return {
        ok: false,
        error: `jev answer for '${qid}' was missing or malformed`,
        latencyMs: latencyMs(),
      };
    }
    answers[qid] = answer;
  }
  return { ok: true, answers, latencyMs: latencyMs() };
}
