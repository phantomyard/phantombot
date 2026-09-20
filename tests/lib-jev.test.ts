/**
 * The Jev client: one typed decision per call, every failure mapped to
 * { ok: false } — never a throw, never a stall past the timeout.
 */

import { describe, expect, it } from "bun:test";

import { jevDecide } from "../src/lib/jev.ts";

const BASE = {
  baseUrl: "https://jev.test/v1",
  apiKey: "test-key",
  model: "typesafe/jev-1.13",
  prompt: "decide",
  tool: "record_verdict",
  description: "test",
  parameters: { type: "object" },
  timeoutMs: 200,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function toolCallResponse(args: unknown): unknown {
  return {
    choices: [
      {
        message: {
          tool_calls: [
            { function: { name: "record_verdict", arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  };
}

describe("jevDecide", () => {
  it("returns the tool-call arguments and the latency", async () => {
    let seenBody = "";
    let seenAuth = "";
    const r = await jevDecide({
      ...BASE,
      fetchImpl: async (_url, init) => {
        seenBody = String(init?.body);
        seenAuth = String((init?.headers as Record<string, string>).authorization);
        return jsonResponse(toolCallResponse({ verdict: "allow", score: 5 }));
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args).toEqual({ verdict: "allow", score: 5 });
      expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    }
    // The decision is FORCED through the schema, and the key travels as a
    // bearer token — never in the URL or the body.
    const body = JSON.parse(seenBody);
    expect(body.tool_choice).toEqual({
      type: "function",
      function: { name: "record_verdict" },
    });
    expect(body.model).toBe("typesafe/jev-1.13");
    expect(seenAuth).toBe("Bearer test-key");
    expect(seenBody).not.toContain("test-key");
  });

  it("accepts arguments already materialised as an object", async () => {
    const r = await jevDecide({
      ...BASE,
      fetchImpl: async () =>
        jsonResponse({
          choices: [
            {
              message: {
                tool_calls: [
                  { function: { name: "record_verdict", arguments: { score: 1 } } },
                ],
              },
            },
          ],
        }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args).toEqual({ score: 1 });
  });

  it("falls back to parsing content when the tool call is absent", async () => {
    const r = await jevDecide({
      ...BASE,
      fetchImpl: async () =>
        jsonResponse({
          choices: [{ message: { content: '{"score": 12, "verdict": "allow"}' } }],
        }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.score).toBe(12);
  });

  it("maps an HTTP error to { ok: false } with the status", async () => {
    const r = await jevDecide({
      ...BASE,
      fetchImpl: async () => new Response("unauthorized", { status: 401 }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("401");
  });

  it("maps an API-level error body to { ok: false }", async () => {
    const r = await jevDecide({
      ...BASE,
      fetchImpl: async () =>
        jsonResponse({ error: { message: "model not found" } }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("model not found");
  });

  it("times out inside the budget instead of stalling", async () => {
    const started = Date.now();
    const r = await jevDecide({
      ...BASE,
      timeoutMs: 50,
      fetchImpl: ((_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(jsonResponse(toolCallResponse({}))), 5000);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("The operation timed out.", "TimeoutError"));
          });
        })) as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("timeout");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("rejects a non-JSON decision payload", async () => {
    const r = await jevDecide({
      ...BASE,
      fetchImpl: (async () =>
        jsonResponse({
          choices: [{ message: { content: "sure, I'd score that about a five" } }],
        })) as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not valid JSON");
  });

  it("rejects an empty decision", async () => {
    const r = await jevDecide({
      ...BASE,
      fetchImpl: (async () =>
        jsonResponse({ choices: [{ message: {} }] })) as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("no decision");
  });
});
