/**
 * The Jev client: one typed decision per call over the DECISIONS API
 * (/api/alpha/decisions — Jev rejects chat/completions with HTTP 400,
 * verified live against OpenRouter 2026-09-20), every failure mapped to
 * { ok: false } — never a throw, never a stall past the timeout.
 */

import { describe, expect, it } from "bun:test";

import {
  decisionModelDecide,
  decisionModelDecisionsUrl,
  DECISION_MODEL_MAX_SCORE_LEVELS,
  type DecisionModelQuestion,
} from "../src/lib/decisionModel.ts";

const QUESTIONS: Record<string, DecisionModelQuestion> = {
  verdict: {
    type: "choice",
    instructions: "allow or hold?",
    criteria: { allow: "Safe to act", hold: "Escalate first" },
  },
  score: {
    type: "score",
    instructions: "risk 0-9",
    criteria: ["low", "mid", "high"],
  },
};

const BASE = {
  baseUrl: "https://jev.test/api/v1",
  apiKey: "test-key",
  model: "typesafe/jev-1.13",
  instructions: "You are a test classifier.",
  state: "decide about this",
  questions: QUESTIONS,
  timeoutMs: 200,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function decisionsResponse(): unknown {
  return {
    model: "typesafe/jev-1.13-20260917",
    answers: {
      verdict: {
        type: "choice",
        choice: "allow",
        probabilities: { allow: 0.9, hold: 0.1 },
        confidence: 0.9,
      },
      score: {
        type: "score",
        score: 1.5,
        legend: { "0": "low", "1": "mid", "2": "high" },
        probabilities: { "0": 0.2, "1": 0.5, "2": 0.3 },
        confidence: 0.5,
      },
    },
    usage: { input_tokens: 100, output_tokens: 10, cost: 0.00001 },
  };
}

describe("decisionModelDecisionsUrl", () => {
  it("derives the OpenRouter decisions endpoint from the /api/v1 base", () => {
    expect(decisionModelDecisionsUrl("https://openrouter.ai/api/v1")).toBe(
      "https://openrouter.ai/api/alpha/decisions",
    );
  });
  it("derives a plausible direct-provider endpoint from a bare /v1 base", () => {
    expect(decisionModelDecisionsUrl("https://api.typesafe.ai/v1")).toBe(
      "https://api.typesafe.ai/api/alpha/decisions",
    );
  });
  it("tolerates a trailing slash", () => {
    expect(decisionModelDecisionsUrl("https://openrouter.ai/api/v1/")).toBe(
      "https://openrouter.ai/api/alpha/decisions",
    );
  });
});

describe("decisionModelDecide", () => {
  it("posts model/instructions/state/questions to the decisions endpoint", async () => {
    let seenUrl = "";
    let seenBody = "";
    let seenAuth = "";
    const r = await decisionModelDecide({
      ...BASE,
      fetchImpl: async (url, init) => {
        seenUrl = String(url);
        seenBody = String(init?.body);
        seenAuth = String(
          (init?.headers as Record<string, string>).authorization,
        );
        return jsonResponse(decisionsResponse());
      },
    });
    expect(r.ok).toBe(true);
    expect(seenUrl).toBe("https://jev.test/api/alpha/decisions");
    const body = JSON.parse(seenBody) as Record<string, unknown>;
    // The decisions contract — and NOT chat/completions: no messages, no
    // tools, no tool_choice anywhere in the request.
    expect(body.model).toBe("typesafe/jev-1.13");
    expect(body.instructions).toBe("You are a test classifier.");
    expect(body.state).toBe("decide about this");
    expect(body.questions).toEqual(QUESTIONS);
    expect(body.messages).toBeUndefined();
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(seenAuth).toBe("Bearer test-key");
    expect(seenBody).not.toContain("test-key");
  });

  it("returns typed answers with probabilities, confidence and latency", async () => {
    const r = await decisionModelDecide({
      ...BASE,
      fetchImpl: async () => jsonResponse(decisionsResponse()),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const verdict = r.answers.verdict;
      expect(verdict?.type).toBe("choice");
      if (verdict?.type === "choice") {
        expect(verdict.choice).toBe("allow");
        expect(verdict.confidence).toBe(0.9);
        expect(verdict.probabilities.hold).toBe(0.1);
      }
      const score = r.answers.score;
      expect(score?.type).toBe("score");
      if (score?.type === "score") {
        expect(score.score).toBe(1.5);
        expect(score.legend["1"]).toBe("mid");
      }
      expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("rejects a choice answer naming a choice outside the criteria", async () => {
    const r = await decisionModelDecide({
      ...BASE,
      fetchImpl: async () =>
        jsonResponse({
          answers: {
            verdict: { type: "choice", choice: "maybe", confidence: 1 },
            score: { type: "score", score: 1 },
          },
        }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("'verdict'");
  });

  it("rejects a missing answer for a requested question", async () => {
    const r = await decisionModelDecide({
      ...BASE,
      fetchImpl: async () =>
        jsonResponse({
          answers: {
            verdict: { type: "choice", choice: "allow", confidence: 1 },
          },
        }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("'score'");
  });

  it("rejects a malformed (non-finite) score answer", async () => {
    const r = await decisionModelDecide({
      ...BASE,
      fetchImpl: async () =>
        jsonResponse({
          answers: {
            verdict: { type: "choice", choice: "allow", confidence: 1 },
            score: { type: "score", score: "high" },
          },
        }),
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a null score answer instead of reading it as level 0", async () => {
    // Regression: Number(null) is 0, so a null score used to parse as the
    // most benign level on the scale — in active judge mode that turns a
    // malformed provider response into a silent "benign" verdict.
    for (const bad of [null, "", undefined]) {
      const r = await decisionModelDecide({
        ...BASE,
        fetchImpl: async () =>
          jsonResponse({
            answers: {
              verdict: { type: "choice", choice: "allow", confidence: 1 },
              score: { type: "score", score: bad },
            },
          }),
      });
      expect(r.ok).toBe(false);
    }
  });

  it("rejects a score answer outside the question's ordinal range", async () => {
    for (const bad of [-1, 3, 99]) {
      const r = await decisionModelDecide({
        ...BASE,
        fetchImpl: async () =>
          jsonResponse({
            answers: {
              verdict: { type: "choice", choice: "allow", confidence: 1 },
              score: { type: "score", score: bad },
            },
          }),
      });
      expect(r.ok).toBe(false);
    }
  });

  it("maps an HTTP error to { ok: false } with the status and detail", async () => {
    const r = await decisionModelDecide({
      ...BASE,
      fetchImpl: async () =>
        jsonResponse(
          {
            error: {
              message:
                "typesafe/jev-1.13 is a decisions model and cannot be used with the chat/completions endpoint.",
            },
          },
          400,
        ),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("http 400");
      expect(r.error).toContain("decisions model");
    }
  });

  it("maps a network failure to { ok: false }", async () => {
    const r = await decisionModelDecide({
      ...BASE,
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("connection refused");
  });

  it("maps non-JSON success bodies to { ok: false }", async () => {
    const r = await decisionModelDecide({
      ...BASE,
      fetchImpl: async () => new Response("<html>proxy error</html>"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("non-JSON");
  });

  it("times out rather than stall", async () => {
    const r = await decisionModelDecide({
      ...BASE,
      timeoutMs: 50,
      fetchImpl: (_url, init) =>
        new Promise<Response>((resolve, reject) => {
          const t = setTimeout(() => resolve(jsonResponse(decisionsResponse())), 500);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            const e = new Error("aborted");
            e.name = "TimeoutError";
            reject(e);
          });
        }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("timeout");
  });

  it("rejects a score question with more levels than the vendor cap", async () => {
    const r = await decisionModelDecide({
      ...BASE,
      questions: {
        risk: {
          type: "score",
          instructions: "x",
          criteria: Array.from(
            { length: DECISION_MODEL_MAX_SCORE_LEVELS + 1 },
            (_, i) => String(i),
          ),
        },
      },
      fetchImpl: async () => {
        throw new Error("fetch must not be reached");
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("levels");
  });

  it("rejects an empty question set without hitting the wire", async () => {
    const r = await decisionModelDecide({
      ...BASE,
      questions: {},
      fetchImpl: async () => {
        throw new Error("fetch must not be reached");
      },
    });
    expect(r.ok).toBe(false);
  });
});

/**
 * LIVE opt-in contract gate (review request, #600): the mocked tests above
 * pin OUR understanding of the wire; this one pins the wire itself. Skipped
 * unless JEV_LIVE_KEY names a real OpenRouter key — CI never sets it, a
 * reviewer runs it explicitly:
 *
 *   JEV_LIVE_KEY=sk-or-... bun test tests/lib-decisionModel.test.ts
 */
describe("decisionModelDecide LIVE (opt-in via JEV_LIVE_KEY)", () => {
  const key = process.env.JEV_LIVE_KEY;
  it.skipIf(!key)(
    "the real endpoint answers the decisions contract",
    async () => {
      const r = await decisionModelDecide({
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: key!,
        model: "typesafe/jev-1.13",
        instructions: "Route coding jobs to coder, everything else to primary.",
        state: "Current message: what's on my calendar tomorrow?",
        questions: {
          route: {
            type: "choice",
            instructions: "Which brain answers?",
            criteria: { primary: "Conversation/admin", coder: "Coding job" },
          },
        },
        timeoutMs: 10_000,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const route = r.answers.route;
        expect(route?.type).toBe("choice");
        if (route?.type === "choice") {
          expect(["primary", "coder"]).toContain(route.choice);
          expect(route.confidence).toBeGreaterThanOrEqual(0);
          expect(route.confidence).toBeLessThanOrEqual(1);
        }
      }
    },
    15_000,
  );
});
