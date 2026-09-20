/**
 * The Jev brain-swap router: choice mapping, confidence clamping, and the
 * hard rule that every failure is { ok: false } — "use the keyword scorer".
 */

import { describe, expect, it } from "bun:test";

import { jevRoute } from "../src/lib/jevRouter.ts";

const SETTINGS = {
  baseUrl: "https://jev.test/v1",
  apiKey: "test-key",
  model: "typesafe/jev-1.13",
  timeoutMs: 200,
};

function responseWith(args: unknown): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            tool_calls: [
              { function: { name: "route_turn", arguments: JSON.stringify(args) } },
            ],
          },
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function stubFetch(args: unknown): {
  fetchImpl: typeof fetch;
  seen: { body: unknown };
} {
  const seen: { body: unknown } = { body: {} };
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    seen.body = JSON.parse(String(init?.body));
    return responseWith(args);
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

describe("jevRoute", () => {
  it("maps a coder choice with its confidence", async () => {
    const { fetchImpl } = stubFetch({ route: "coder", confidence: 0.87 });
    const r = await jevRoute({ settings: SETTINGS, text: "review this PR", fetchImpl });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.route).toBe("coder");
      expect(r.confidence).toBeCloseTo(0.87);
    }
  });

  it("maps a primary choice", async () => {
    const { fetchImpl } = stubFetch({ route: "primary", confidence: 0.95 });
    const r = await jevRoute({ settings: SETTINGS, text: "what's for dinner?", fetchImpl });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.route).toBe("primary");
  });

  it("shows the current message in context, recent turns oldest-first", async () => {
    const { fetchImpl, seen } = stubFetch({ route: "coder", confidence: 0.7 });
    await jevRoute({
      settings: SETTINGS,
      text: "what about the error handling?",
      history: ["fix the type error in src/config.ts", "looks good"],
      fetchImpl,
    });
    const messages = (seen.body as unknown as { messages: Array<{ role: string; content: string }> }).messages;
    const prompt = messages.find((m) => m.role === "user")!.content;
    expect(prompt.indexOf("fix the type error")).toBeLessThan(
      prompt.indexOf("looks good"),
    );
    expect(prompt.indexOf("looks good")).toBeLessThan(
      prompt.indexOf("<current>"),
    );
    expect(prompt).toContain("what about the error handling?");
  });

  it("rejects an out-of-schema route", async () => {
    const { fetchImpl } = stubFetch({ route: "vision", confidence: 0.5 });
    const r = await jevRoute({ settings: SETTINGS, text: "x", fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("out-of-schema");
  });

  it("clamps a wild confidence into [0, 1]", async () => {
    const { fetchImpl } = stubFetch({ route: "coder", confidence: 4.2 });
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
