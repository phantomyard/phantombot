/**
 * engine.embeddings.check and persona.memory.refresh: what an embedding app
 * needs to give its personas the semantic memory search the CLI's
 * `phantombot embedding` + heartbeat give a daemon persona.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngine, type Engine, EngineError } from "../src/engine/index.ts";
import { _setEmbeddingsBackendsForTesting } from "../src/engine/embeddings.ts";

let root: string;
let engine: Engine;
const calls: Array<Record<string, unknown>> = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "phantombot-engine-embeddings-"));
  calls.length = 0;
  engine = await createEngine({ root, log: "silent" });
});

afterEach(async () => {
  await engine.close();
  _setEmbeddingsBackendsForTesting(undefined);
  rmSync(root, { recursive: true, force: true });
});

function fakeBackends(embedOk: boolean, listed: string[] = ["text-embedding-3-small"]) {
  const result = embedOk
    ? { ok: true as const, values: new Float32Array(8), dims: 8 }
    : { ok: false as const, error: "API key sk-secret not valid" };
  _setEmbeddingsBackendsForTesting({
    gemini: async (key, model) => {
      calls.push({ kind: "gemini", key, model });
      return result;
    },
    openai: async (o) => {
      calls.push({ kind: "openai", ...o });
      return result;
    },
    models: async (baseUrl, apiKey) => {
      calls.push({ kind: "models", baseUrl, apiKey });
      return listed;
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

describe("engine.embeddings.check", () => {
  test("gemini: a live embed verifies the key and reports dims", async () => {
    fakeBackends(true);
    const r = await engine.embeddings.check({ provider: "gemini", apiKey: "  g-key  " });
    expect(r).toEqual({
      status: "verified",
      detail: "embedded (8 dims)",
      models: ["gemini-embedding-001"],
      dims: 8,
    });
    expect(calls).toEqual([{ kind: "gemini", key: "g-key", model: "gemini-embedding-001" }]);
  });

  test("gemini without a key checks nothing", async () => {
    fakeBackends(true);
    const r = await engine.embeddings.check({ provider: "gemini", apiKey: " " });
    expect(r.status).toBe("unchecked");
    expect(calls).toEqual([]);
  });

  test("a refused embed fails, and the detail never carries the key", async () => {
    fakeBackends(false);
    const r = await engine.embeddings.check({ provider: "gemini", apiKey: "sk-secret" });
    expect(r.status).toBe("failed");
    expect(r.dims).toBeUndefined();
    expect(r.detail).not.toContain("sk-secret");
  });

  test("openai-compatible lists models first, then proves the chosen one", async () => {
    fakeBackends(true, ["bge-m3", "text-embedding-3-small"]);
    const listOnly = await engine.embeddings.check({
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:8082/v1/",
    });
    expect(listOnly).toEqual({
      status: "unchecked",
      detail: "choose a model",
      models: ["bge-m3", "text-embedding-3-small"],
    });
    expect(calls).toEqual([{ kind: "models", baseUrl: "http://127.0.0.1:8082/v1", apiKey: "" }]);

    calls.length = 0;
    const proved = await engine.embeddings.check({
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      model: "bge-m3",
    });
    expect(proved.status).toBe("verified");
    expect(proved.dims).toBe(8);
    expect(calls[1]).toEqual({ kind: "openai", baseUrl: "https://api.example.com/v1", model: "bge-m3", apiKey: "k" });
  });

  test("a keyless local endpoint sends no key", async () => {
    fakeBackends(true);
    await engine.embeddings.check({ provider: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "m" });
    expect(calls[1]).toEqual({ kind: "openai", baseUrl: "http://localhost:11434/v1", model: "m" });
  });

  test("bad input is invalid_argument and reaches no network", async () => {
    fakeBackends(true);
    await rejectsWith(engine.embeddings.check({ provider: "cohere" } as never), "invalid_argument");
    for (const baseUrl of ["ftp://x/v1", "https://u:p@x/v1", "https://x/v1?k=1", "not a url", undefined]) {
      await rejectsWith(
        engine.embeddings.check({ provider: "openai-compatible", baseUrl } as never),
        "invalid_argument",
      );
    }
    await rejectsWith(
      engine.embeddings.check({ provider: "gemini", apiKey: 42 } as never),
      "invalid_argument",
    );
    expect(calls).toEqual([]);
  });
});

describe("persona.memory.refresh", () => {
  test("embeds the persona's notes with the configured provider, so search goes hybrid", async () => {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/v1/embeddings") return new Response("no", { status: 404 });
        const body = (await req.json()) as { input: string | string[] };
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        seen.push(...inputs);
        return Response.json({ data: inputs.map((_, index) => ({ index, embedding: [1, 0, 0, 0] })) });
      },
    });
    try {
      const ana = await engine.personas.create("ana", { identity: "a test agent" });
      const kb = join(root, "data", "phantombot", "personas", "ana", "kb");
      mkdirSync(kb, { recursive: true });
      writeFileSync(
        join(kb, "deploys.md"),
        "---\ntype: norm\ntitle: Deploy day\n---\nDeploys happen on Thursdays.\n",
      );

      // No embeddings provider: keyword index only, nothing embedded.
      const keywordOnly = await ana.memory.refresh();
      expect(keywordOnly.error).toBeUndefined();
      expect(keywordOnly.embedded).toBe(0);
      expect(seen).toEqual([]);

      await ana.configure({
        embeddings: {
          provider: "openai-compatible",
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          model: "fake-embed",
          dims: 4,
        },
      });
      const r = await ana.memory.refresh();
      expect(r.error).toBeUndefined();
      expect(r.embedded).toBeGreaterThan(0);
      expect(seen.some((t) => t.includes("Thursdays"))).toBe(true);

      // Incremental: nothing changed, nothing re-embedded.
      const again = await ana.memory.refresh();
      expect(again.embedded).toBe(0);

      const hits = await ana.memory.search("deploy day", { scope: "kb" });
      expect(hits.some((h) => h.path.endsWith("deploys.md") && typeof h.vecScore === "number")).toBe(true);
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("an unknown persona is persona_not_found", async () => {
    await rejectsWith(engine.persona("ghost").memory.refresh(), "persona_not_found");
  });
});
