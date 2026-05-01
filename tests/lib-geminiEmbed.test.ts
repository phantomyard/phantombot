/**
 * Tests for the Gemini embedding client (mocked fetch — no network).
 */

import { describe, expect, test } from "bun:test";
import { geminiEmbed } from "../src/lib/geminiEmbed.ts";

function fakeFetch(
  body: unknown,
  status = 200,
): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("geminiEmbed", () => {
  test("ok=true returns Float32Array of the right length", async () => {
    const r = await geminiEmbed("k", "hello", {
      fetchImpl: fakeFetch({
        embedding: { values: Array.from({ length: 1536 }, () => 0.1) },
      }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.values).toBeInstanceOf(Float32Array);
    expect(r.values.length).toBe(1536);
    expect(r.dims).toBe(1536);
    expect(Math.abs(r.values[0]! - 0.1)).toBeLessThan(0.0001);
  });

  test("ok=false returns Gemini's error message on 4xx", async () => {
    const r = await geminiEmbed("badkey", "hello", {
      fetchImpl: fakeFetch(
        { error: { message: "API key not valid. Please pass a valid API key." } },
        400,
      ),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("API key not valid");
  });

  test("ok=false on HTTP error without body.error", async () => {
    const r = await geminiEmbed("k", "x", {
      fetchImpl: fakeFetch({}, 500),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("HTTP 500");
  });

  test("ok=false on network error", async () => {
    const failing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await geminiEmbed("k", "x", { fetchImpl: failing });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("network");
  });

  test("ok=false on missing embedding", async () => {
    const r = await geminiEmbed("k", "x", {
      fetchImpl: fakeFetch({}),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("no embedding");
  });

  test("ok=false on non-numeric values in embedding", async () => {
    const r = await geminiEmbed("k", "x", {
      fetchImpl: fakeFetch({ embedding: { values: ["a", "b"] } }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("non-numeric");
  });
});
