/**
 * TypeSafe Jev client — ONE typed decision per call.
 *
 * Jev is not an LLM. It is a "System One" model: unstructured text in, a
 * typed choice with a calibrated probability out — no free-text generation
 * at all. That shape matches two phantombot decision points exactly:
 *
 *   1. the THREAT JUDGE (lib/jevJudge.ts) — screening untrusted input before
 *      a capable turn runs;
 *   2. the BRAIN-SWAP router (lib/jevRouter.ts) — the `primary | coder`
 *      routing choice in front of every Pi turn.
 *
 * This module is the SHARED plumbing for both: one credential resolution
 * contract (the caller hands us a key), one endpoint shape, one timeout /
 * error mapping. The two consumers deliberately keep their own prompts,
 * schemas and thresholds — a router failure must never leak into the judge
 * and vice versa (issue #597).
 *
 * API shape: Jev is reached through an OpenAI-compatible chat-completions
 * endpoint (OpenRouter, or TypeSafe direct). The typed decision is requested
 * as a single function tool with `tool_choice` FORCED, so the response is a
 * schema-validated tool call, not prose: the vendor's "0% type errors" claim
 * is exactly that the arguments match the supplied JSON schema. We still
 * parse defensively — a proxy or a non-Jev model behind the same endpoint
 * can answer with plain content, which we attempt to parse as JSON before
 * giving up.
 *
 * Availability posture: Jev is a DIFFERENT vendor, credential and quota pool
 * to the claude/codex/pi harness chain. That independence is the point — a
 * fleet-wide harness quota outage no longer takes the security control down
 * with it — but it cuts both ways: Jev being down must never take a TURN
 * down. Every caller treats { ok: false } as "fall back to the existing
 * method", never as an error worth surfacing mid-turn.
 *
 * Cost: ~$0.042/Mtok input, output free (OpenRouter listing, 2026-09). A
 * judge call is a few hundred tokens; a router call fewer. Both are
 * effectively free per decision, which is what makes running it in front of
 * EVERY turn affordable.
 */

import { timeoutSignal } from "./fetchTimeout.ts";

/** The model id as listed on OpenRouter (`typesafe/jev-1.13`). */
export const JEV_DEFAULT_MODEL = "typesafe/jev-1.13";

/** OpenRouter's OpenAI-compatible base URL. */
export const JEV_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Default base URL for the DIRECT TypeSafe provider. A starting point for the
 * wizard's prefill, not a verified constant — the direct API is not publicly
 * documented at the path level, so the wizard asks the operator to confirm
 * it against their TypeSafe dashboard, and `base_url` in `[jev]` overrides
 * it. OpenRouter needs no such guesswork.
 */
export const JEV_TYPESAFE_BASE_URL = "https://api.typesafe.ai/v1";

/** The vault/env name a Jev API key lives under by default. */
export const JEV_DEFAULT_KEY_ENV = "PHANTOMBOT_JEV_API_KEY";

/** Vendor cap: a decision's choice cardinality may not exceed 255. */
export const JEV_MAX_CHOICES = 255;

export interface JevDecisionRequest {
  /** OpenAI-compatible base URL (no trailing slash), e.g. OpenRouter's. */
  baseUrl: string;
  /** Bearer token for the endpoint. */
  apiKey: string;
  /** Model id, e.g. `typesafe/jev-1.13`. */
  model: string;
  /** Optional system prompt (the judge passes its classifier briefing). */
  system?: string;
  /** The user-message payload the decision is about. */
  prompt: string;
  /** Function-tool name the decision is returned through. */
  tool: string;
  /** One-line description of the decision, for the tool schema. */
  description: string;
  /**
   * JSON Schema for the decision's arguments. Enum arrays inside it ARE the
   * choice set; the vendor caps their cardinality at JEV_MAX_CHOICES.
   */
  parameters: Record<string, unknown>;
  /** Hard wall-clock cap. Exceeding it is an { ok: false }, never a stall. */
  timeoutMs: number;
  /** Optional caller cancellation, composed with the timeout. */
  signal?: AbortSignal;
  /**
   * Test seam — production omits this and gets the global fetch. Typed as a
   * plain function (not `typeof fetch`) so tests can pass a bare arrow
   * without Bun's `preconnect` property getting in the way.
   */
  fetchImpl?: JevFetch;
}

/** The minimal slice of fetch this module uses. */
export type JevFetch = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type JevDecision =
  | { ok: true; args: Record<string, unknown>; latencyMs: number }
  | { ok: false; error: string; latencyMs: number };

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        function?: { name?: string; arguments?: unknown };
      }>;
    };
  }>;
  error?: { message?: string };
}

/**
 * Ask Jev for one typed decision. Never throws: every failure — network,
 * timeout, HTTP error, malformed or missing tool call — comes back as
 * { ok: false, error } so the caller can fall back to its existing method.
 */
export async function jevDecide(
  req: JevDecisionRequest,
): Promise<JevDecision> {
  const started = Date.now();
  const latencyMs = () => Date.now() - started;
  const doFetch: JevFetch = req.fetchImpl ?? fetch;

  const body = {
    model: req.model,
    messages: [
      ...(req.system ? [{ role: "system", content: req.system }] : []),
      { role: "user", content: req.prompt },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: req.tool,
          description: req.description,
          parameters: req.parameters,
        },
      },
    ],
    // Force the decision through the schema. `required` is what makes the
    // output a typed choice rather than prose the caller must parse.
    tool_choice: { type: "function", function: { name: req.tool } },
    temperature: 0,
  };

  let res: Response;
  try {
    res = await doFetch(`${req.baseUrl}/chat/completions`, {
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
    const detail = text.replace(/\s+/g, " ").trim().slice(0, 200);
    return {
      ok: false,
      error: `jev http ${res.status}${detail ? `: ${detail}` : ""}`,
      latencyMs: latencyMs(),
    };
  }

  let parsed: ChatCompletionResponse;
  try {
    parsed = JSON.parse(text) as ChatCompletionResponse;
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

  const message = parsed.choices?.[0]?.message;
  const rawArgs = message?.tool_calls?.[0]?.function?.arguments;
  const candidate =
    typeof rawArgs === "string"
      ? rawArgs
      : rawArgs !== undefined
        ? JSON.stringify(rawArgs)
        : // Fallback for a non-Jev model behind the same endpoint that ignored
          // the forced tool call and answered in content instead.
          message?.content;

  if (typeof candidate !== "string" || candidate.trim() === "") {
    return {
      ok: false,
      error: "jev returned no decision (no tool call, no content)",
      latencyMs: latencyMs(),
    };
  }

  let args: unknown;
  try {
    args = JSON.parse(candidate);
  } catch {
    return {
      ok: false,
      error: "jev decision was not valid JSON",
      latencyMs: latencyMs(),
    };
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return {
      ok: false,
      error: "jev decision was not a JSON object",
      latencyMs: latencyMs(),
    };
  }
  return {
    ok: true,
    args: args as Record<string, unknown>,
    latencyMs: latencyMs(),
  };
}
