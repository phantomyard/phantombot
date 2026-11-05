/**
 * engine.decisionModels: a key check and the decision-model list for an
 * embedding app's own setup UI. Network calls go through the test seam, or
 * through a stubbed global fetch for the real backends.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngine, type Engine, EngineError } from "../src/engine/index.ts";
import { _setDecisionModelBackendsForTesting } from "../src/engine/decisionModels.ts";

let root: string;
let engine: Engine;
const calls: Array<{ kind: string; provider: string; key: string }> = [];
const realFetch = globalThis.fetch;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "phantombot-engine-decision-models-"));
  calls.length = 0;
  engine = await createEngine({ root, log: "silent" });
});

afterEach(async () => {
  await engine.close();
  _setDecisionModelBackendsForTesting(undefined);
  globalThis.fetch = realFetch;
  rmSync(root, { recursive: true, force: true });
});

function fakeBackends(status: "verified" | "invalid" | "unverified") {
  _setDecisionModelBackendsForTesting({
    probe: async (provider, key) => {
      calls.push({ kind: "probe", provider, key });
      return { status, detail: `HTTP ${status === "invalid" ? 401 : 200}` };
    },
    models: async (provider, key) => {
      calls.push({ kind: "models", provider, key });
      return ["typesafe/jev-1.13", "liquid/d1"];
    },
  });
}

async function rejectsWith(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(EngineError);
    expect((e as EngineError).code).toBe(code as EngineError["code"]);
    return;
  }
  throw new Error(`expected rejection with ${code}`);
}

describe("engine.decisionModels.check", () => {
  test("a verified key lists the provider's decision models", async () => {
    fakeBackends("verified");
    const r = await engine.decisionModels.check("openrouter", "  sk-or-good  ");
    expect(r).toEqual({
      status: "verified",
      detail: "HTTP 200",
      models: ["typesafe/jev-1.13", "liquid/d1"],
    });
    // The trimmed key reaches both backends, for the provider asked for.
    expect(calls).toEqual([
      { kind: "probe", provider: "openrouter", key: "sk-or-good" },
      { kind: "models", provider: "openrouter", key: "sk-or-good" },
    ]);
  });

  test("a rejected key lists nothing, so a list never reads as proof the key works", async () => {
    fakeBackends("invalid");
    const r = await engine.decisionModels.check("typesafe", "bad");
    expect(r).toEqual({ status: "invalid", detail: "HTTP 401", models: [] });
  });

  test("an unverifiable key still lists models", async () => {
    fakeBackends("unverified");
    const r = await engine.decisionModels.check("typesafe", "maybe");
    expect(r.status).toBe("unverified");
    expect(r.models).toEqual(["typesafe/jev-1.13", "liquid/d1"]);
  });

  test("a model-list failure degrades to [] and keeps the key verdict", async () => {
    _setDecisionModelBackendsForTesting({
      probe: async () => ({ status: "verified", detail: "ok" }),
      models: async () => {
        throw new Error("boom");
      },
    });
    const r = await engine.decisionModels.check("openrouter", "k");
    expect(r).toEqual({ status: "verified", detail: "ok", models: [] });
  });

  test("no key: unverified, nothing listed, no network call", async () => {
    fakeBackends("verified");
    const r = await engine.decisionModels.check("openrouter", "   ");
    expect(r).toEqual({ status: "unverified", detail: "no key to check", models: [] });
    expect(calls).toEqual([]);
  });

  test("only the built-in transports are accepted", async () => {
    fakeBackends("verified");
    await rejectsWith(engine.decisionModels.check("custom", "k"), "invalid_argument");
    await rejectsWith(engine.decisionModels.check("OpenRouter", "k"), "invalid_argument");
    await rejectsWith(
      engine.decisionModels.check(undefined as unknown as string, "k"),
      "invalid_argument",
    );
    await rejectsWith(
      engine.decisionModels.check("openrouter", 42 as unknown as string),
      "invalid_argument",
    );
    await rejectsWith(engine.decisionModels.check("openrouter", "x".repeat(5000)), "invalid_argument");
    expect(calls).toEqual([]);
  });
});

describe("engine.decisionModels.check, real backends", () => {
  type Seen = { url: string; auth: string | null };
  function stubFetch(statusFor: (url: string) => number, body: unknown = { data: [] }): Seen[] {
    const seen: Seen[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      seen.push({ url, auth: headers.get("authorization") });
      const status = statusFor(url);
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return seen;
  }

  test("openrouter: the key is checked at /key and models come from the decisions catalogue", async () => {
    const seen = stubFetch(() => 200, { data: [{ id: "liquid/d1" }] });
    const r = await engine.decisionModels.check("openrouter", "sk-or-secret");
    expect(r.status).toBe("verified");
    expect(r.models).toEqual(["typesafe/jev-1.13", "liquid/d1"]);
    expect(seen.map((s) => s.url).sort()).toEqual([
      "https://openrouter.ai/api/v1/key",
      "https://openrouter.ai/api/v1/models?output_modalities=decisions",
    ]);
    expect(seen.every((s) => s.auth === "Bearer sk-or-secret")).toBe(true);
    expect(r.detail).not.toContain("sk-or-secret");
  });

  test("openrouter: a 401 from /key is invalid even though the catalogue is public", async () => {
    stubFetch((url) => (url.endsWith("/api/v1/key") ? 401 : 200), { data: [{ id: "liquid/d1" }] });
    const r = await engine.decisionModels.check("openrouter", "sk-or-bad");
    expect(r).toEqual({ status: "invalid", detail: "rejected by the provider (HTTP 401)", models: [] });
  });

  test("typesafe: /v1/models is the key check, and 401 is invalid", async () => {
    const seen = stubFetch(() => 401);
    const r = await engine.decisionModels.check("typesafe", "ts-bad");
    expect(r).toEqual({ status: "invalid", detail: "rejected by the provider (HTTP 401)", models: [] });
    expect(seen.some((s) => s.url === "https://api.typesafe.ai/v1/models")).toBe(true);
    expect(seen.every((s) => s.auth === "Bearer ts-bad")).toBe(true);
  });

  test("typesafe: an accepted token lists its models", async () => {
    stubFetch(() => 200, { data: [{ id: "typesafe/jev-1.13" }, { id: "typesafe/jev-2" }] });
    const r = await engine.decisionModels.check("typesafe", "ts-good");
    expect(r.status).toBe("verified");
    expect(r.models).toEqual(["typesafe/jev-1.13", "typesafe/jev-2"]);
  });

  test("a network failure is unverified, never invalid", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const r = await engine.decisionModels.check("typesafe", "ts-any");
    expect(r.status).toBe("unverified");
    expect(r.models).toEqual(["typesafe/jev-1.13"]);
  });
});
