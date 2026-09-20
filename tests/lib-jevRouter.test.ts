/**
 * The Jev brain-swap router: choice mapping, calibrated-confidence handling,
 * and the hard rule that every failure is { ok: false } — "use the keyword
 * scorer". Wire shape is the DECISIONS API: one choice question whose
 * criteria keys are the routes.
 */

import { describe, expect, it } from "bun:test";

import { jevRoute } from "../src/lib/jevRouter.ts";

const SETTINGS = {
  baseUrl: "https://jev.test/api/v1",
  apiKey: "test-key",
  model: "typesafe/jev-1.13",
  timeoutMs: 200,
};

function responseWith(choice: string, confidence: number): Response {
  return new Response(
    JSON.stringify({
      answers: {
        route: {
          type: "choice",
          choice,
          probabilities: { primary: 1 - confidence, coder: confidence },
          confidence,
        },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function stubFetch(
  choice: string,
  confidence: number,
): {
  fetchImpl: typeof fetch;
  seen: { body: Record<string, unknown> };
} {
  const seen: { body: Record<string, unknown> } = { body: {} };
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    seen.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return responseWith(choice, confidence);
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

describe("jevRoute", () => {
  it("maps a coder choice with its calibrated confidence", async () => {
    const { fetchImpl } = stubFetch("coder", 0.87);
    const r = await jevRoute({
      settings: SETTINGS,
      text: "review this PR",
      fetchImpl,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.route).toBe("coder");
      expect(r.confidence).toBeCloseTo(0.87);
    }
  });

  it("maps a primary choice", async () => {
    const { fetchImpl } = stubFetch("primary", 0.95);
    const r = await jevRoute({
      settings: SETTINGS,
      text: "what's for dinner?",
      fetchImpl,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.route).toBe("primary");
  });

  it("sends the decisions contract with the routes as choice criteria", async () => {
    const { fetchImpl, seen } = stubFetch("coder", 0.7);
    await jevRoute({
      settings: SETTINGS,
      text: "what about the error handling?",
      history: ["fix the type error in src/config.ts", "looks good"],
      fetchImpl,
    });
    const body = seen.body as {
      instructions?: string;
      state?: string;
      questions?: Record<string, { type: string; criteria: unknown }>;
      messages?: unknown;
    };
    expect(body.messages).toBeUndefined();
    expect(body.instructions).toContain("which brain");
    expect(
      Object.keys(body.questions?.route?.criteria as object).sort(),
    ).toEqual(["coder", "primary"]);
    // The current message is shown in context, recent turns oldest-first.
    const state = String(body.state);
    expect(state.indexOf("fix the type error")).toBeLessThan(
      state.indexOf("looks good"),
    );
    expect(state.indexOf("looks good")).toBeLessThan(
      state.indexOf("<current>"),
    );
    expect(state).toContain("what about the error handling?");
  });

  it("rejects an out-of-criteria route choice", async () => {
    // The CLIENT guards the choice against the question's criteria keys, so
    // a route outside {primary, coder} never reaches the router's own check.
    const { fetchImpl } = stubFetch("vision", 0.5);
    const r = await jevRoute({ settings: SETTINGS, text: "x", fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("'route'");
  });

  it("clamps a wild confidence into [0, 1]", async () => {
    const { fetchImpl } = stubFetch("coder", 4.2);
    const r = await jevRoute({ settings: SETTINGS, text: "x", fetchImpl });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.confidence).toBe(1);
  });

  it("any transport failure means 'use the keyword scorer'", async () => {
    const fetchImpl = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const r = await jevRoute({ settings: SETTINGS, text: "x", fetchImpl });
    expect(r.ok).toBe(false);
  });
});
