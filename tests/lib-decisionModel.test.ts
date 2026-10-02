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
  fetchDecisionModels,
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

  it("names a gateway-firewall block instead of logging HTML (observed live on OpenRouter)", async () => {
    const html = '<!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->';
    for (const body of [
      JSON.stringify({ error: { message: `HTTP 403: ${html}` } }), // OpenRouter envelope
      html, // bare Cloudflare page
    ]) {
      const r = await decisionModelDecide({
        ...BASE,
        fetchImpl: async () => new Response(body, { status: 403 }),
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain("http 403");
        expect(r.error).toContain("web firewall");
        expect(r.error).not.toContain("<");
      }
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

  it("rejects a single-option choice without hitting the wire (vendor floor)", async () => {
    // The decisions gateway 422s a 1-option choice ("A Choice needs at least 2
    // options") — the wizard's validation ping shipped exactly that and every
    // OpenRouter decide model rejected it identically (verified live
    // 2026-10-02). The local check must catch it before the wire, so no call
    // site can regress this again.
    for (const criteria of [
      { ok: "only one option" }, // 1 option — the 422 shape
      {}, // 0 options
    ] as Record<string, string>[]) {
      const r = await decisionModelDecide({
        ...BASE,
        questions: {
          pong: { type: "choice", instructions: "x", criteria },
        },
        fetchImpl: async () => {
          throw new Error("fetch must not be reached");
        },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("at least 2 options");
    }
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

describe("fetchDecisionModels", () => {
  it("queries the OpenRouter DECISIONS catalog, never the chat catalog", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const models = await fetchDecisionModels(
      "openrouter",
      "sk-test",
      undefined,
      async (url, init) => {
        seenUrl = String(url);
        seenAuth = String(
          init?.headers instanceof Headers
            ? init.headers.get("authorization")
            : (init?.headers as Record<string, string>).Authorization ??
              (init?.headers as Record<string, string>).authorization,
        );
        return jsonResponse({
          data: [
            { id: "liquid/d1" },
            { id: "togethercomputer/tev1-4b-experimental" },
            { id: "inception/mercury-decide:free" },
            { id: "~typesafe/jev-latest" },
            { id: "typesafe/jev-1.13" },
          ],
        });
      },
    );
    // The pinned modality filter IS the filter: the decisions catalog is a
    // different list from the chat catalog, so the endpoint must be asked
    // for it directly (verified live 2026-10-02 — the unfiltered /models
    // carries none of the decide models).
    expect(seenUrl).toBe(
      "https://openrouter.ai/api/v1/models?output_modalities=decisions",
    );
    expect(seenAuth).toBe("Bearer sk-test");
    // The default model is always present, first, exactly once.
    expect(models[0]).toBe("typesafe/jev-1.13");
    expect(models.filter((m) => m === "typesafe/jev-1.13")).toHaveLength(1);
    // The decisions catalog arrives — every decide id the operator sees on
    // OpenRouter, including the tilde-prefixed one and free-tier ids.
    expect(models).toContain("liquid/d1");
    expect(models).toContain("togethercomputer/tev1-4b-experimental");
    expect(models).toContain("inception/mercury-decide:free");
    expect(models).toContain("~typesafe/jev-latest");
    // Catalog ids are sorted deterministically after the pinned default.
    expect(models.slice(1)).toEqual([...models.slice(1)].sort());
    expect(models).toHaveLength(5);
  });

  it("probes {base_url}/models for a direct provider and dedupes the default", async () => {
    let seenUrl = "";
    const models = await fetchDecisionModels(
      "typesafe",
      "ts-key",
      "https://api.typesafe.ai/v1/",
      async (url) => {
        seenUrl = String(url);
        return jsonResponse({
          data: [{ id: "typesafe/jev-1.13" }, { id: "typesafe/jev-2.0" }],
        });
      },
    );
    expect(seenUrl).toBe("https://api.typesafe.ai/v1/models");
    // One entry, not two — the provider's own listing must not duplicate it.
    expect(models.filter((m) => m === "typesafe/jev-1.13")).toHaveLength(1);
    expect(models).toContain("typesafe/jev-2.0");
  });

  it("degrades to the default list on network failure — never throws", async () => {
    const models = await fetchDecisionModels(
      "openrouter",
      "sk-test",
      undefined,
      async () => {
        throw new Error("offline");
      },
    );
    expect(models).toEqual(["typesafe/jev-1.13"]);
  });

  it("falls back to the default when the catalog response is unusable", async () => {
    const models = await fetchDecisionModels(
      "typesafe",
      "ts-key",
      "https://api.typesafe.ai/v1",
      async () => jsonResponse({ nope: true }),
    );
    expect(models).toEqual(["typesafe/jev-1.13"]);
  });
});
