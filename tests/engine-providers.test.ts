/**
 * engine.providers: the provider catalogue, a key check and the account's
 * model list, for an embedding app's own setup UI. Network calls are replaced
 * through the providers test seam.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngine, type Engine, EngineError } from "../src/engine/index.ts";
import { _setProviderBackendsForTesting } from "../src/engine/providers.ts";
import { probeProviderKey } from "../src/lib/providerKeyProbe.ts";

let root: string;
let engine: Engine;
const calls: Array<{ kind: string; id: string; key: string; baseUrl?: string }> = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "phantombot-engine-providers-"));
  calls.length = 0;
  engine = await createEngine({ root, log: "silent" });
});

afterEach(async () => {
  await engine.close();
  _setProviderBackendsForTesting(undefined);
  rmSync(root, { recursive: true, force: true });
});

function fakeBackends(status: "verified" | "invalid" | "unverified") {
  _setProviderBackendsForTesting({
    probe: async (id, key, opts) => {
      calls.push({ kind: "probe", id, key, ...opts });
      return { status, detail: `HTTP ${status === "invalid" ? 401 : 200}` };
    },
    models: async (id, key, opts) => {
      calls.push({ kind: "models", id, key, ...opts });
      return [
        { provider: id, model: "m-text", supportsImages: false },
        { provider: id, model: "m-vision", supportsImages: true },
      ];
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

describe("engine.providers.list", () => {
  test("returns the native catalogue with custom-provider flags", async () => {
    const list = await engine.providers.list();
    const ids = list.map((p) => p.id);
    expect(ids).toContain("openrouter");
    expect(ids).toContain("anthropic");
    expect(new Set(ids).size).toBe(ids.length);
    const compat = list.find((p) => p.id === "openai-compatible")!;
    expect(compat).toMatchObject({ needsBaseUrl: true, keyOptional: true });
    const ops = list.find((p) => p.id === "phantomops")!;
    expect(ops).toMatchObject({ needsBaseUrl: false, keyOptional: false, defaultModel: "phantomops/auto" });
    expect(list.find((p) => p.id === "openrouter")).toMatchObject({
      label: "OpenRouter",
      needsBaseUrl: false,
      keyOptional: false,
    });
  });
});

describe("engine.providers.list: checkable / autoModel / keyLabel", () => {
  test("checkable matches what the real probe can actually answer", async () => {
    const list = await engine.providers.list();
    for (const id of ["openrouter", "anthropic", "openai", "openai-compatible", "phantomops"]) {
      expect(list.find((p) => p.id === id)!.checkable).toBe(true);
    }
    const unCheckable = list.filter((p) => !p.checkable);
    expect(unCheckable.map((p) => p.id)).toContain("zai");
    expect(unCheckable.map((p) => p.id)).toContain("minimax");
    // Every provider reported uncheckable really has no check (no network:
    // the probe returns before any fetch for these).
    for (const p of unCheckable) {
      const r = await probeProviderKey(p.id, "k");
      expect(r).toEqual({ status: "unverified", detail: `no known check for provider '${p.id}'` });
    }
  });

  test("autoModel and keyLabel come from the wizard's own rules", async () => {
    const list = await engine.providers.list();
    const ops = list.find((p) => p.id === "phantomops")!;
    expect(ops.autoModel).toBe(true);
    expect(ops.keyLabel).toContain("pok_");
    expect(list.find((p) => p.id === "openai-compatible")!.keyLabel).toBeTruthy();
    const or = list.find((p) => p.id === "openrouter")!;
    expect(or.autoModel).toBe(false);
    expect(or.keyLabel).toBeUndefined();
  });
});

describe("engine.providers.check", () => {
  test("no key, where one is required, lists no models even from a public catalogue", async () => {
    fakeBackends("unverified");
    const r = await engine.providers.check("openrouter", "  ");
    expect(r.models).toEqual([]);
    // A keyless-capable provider still lists what its server reports.
    const local = await engine.providers.check("openai-compatible", "", {
      baseUrl: "http://127.0.0.1:11434/v1",
    });
    expect(local.models.length).toBe(2);
  });

  test("baseUrl on a provider that does not take one is rejected, not ignored", async () => {
    fakeBackends("verified");
    await rejectsWith(
      engine.providers.check("anthropic", "k", { baseUrl: "https://my-proxy.example/v1" }),
      "invalid_argument",
    );
    expect(calls).toEqual([]);
    // PhantomOps honours an override (a dev ring).
    await engine.providers.check("phantomops", "pok_x", { baseUrl: "https://dev.example/api/v1/" });
    expect(calls[0]!.baseUrl).toBe("https://dev.example/api/v1");
  });

  test("a malformed baseUrl is reported as malformed, not missing", async () => {
    fakeBackends("verified");
    for (const bad of ["localhost:11434/v1", "ftp://x/v1", "not a url"]) {
      try {
        await engine.providers.check("openai-compatible", "k", { baseUrl: bad });
        throw new Error("expected rejection");
      } catch (e) {
        expect(e).toBeInstanceOf(EngineError);
        expect((e as EngineError).code).toBe("invalid_argument");
        expect((e as EngineError).message).toContain("http://");
      }
    }
    expect(calls).toEqual([]);
    await engine.providers.check("openai-compatible", "k", {
      baseUrl: "http://127.0.0.1:11434/v1/chat/completions",
    });
    expect(calls[0]!.baseUrl).toBe("http://127.0.0.1:11434/v1");
  });

  test("verified key returns the account's models", async () => {
    fakeBackends("verified");
    const r = await engine.providers.check("openrouter", "sk-test");
    expect(r).toEqual({
      status: "verified",
      detail: "HTTP 200",
      models: [
        { id: "m-text", supportsImages: false },
        { id: "m-vision", supportsImages: true },
      ],
    });
    expect(calls.map((c) => [c.kind, c.id, c.key])).toEqual([
      ["probe", "openrouter", "sk-test"],
      ["models", "openrouter", "sk-test"],
    ]);
  });

  test("a rejected key lists no models, even when the catalogue is public", async () => {
    fakeBackends("invalid");
    const r = await engine.providers.check("openrouter", "bad");
    expect(r.status).toBe("invalid");
    expect(r.models).toEqual([]);
  });

  test("an unverifiable key still returns whatever models were readable", async () => {
    fakeBackends("unverified");
    const r = await engine.providers.check("anthropic", "k");
    expect(r.status).toBe("unverified");
    expect(r.models.length).toBe(2);
  });

  test("a failing model fetch is not fatal", async () => {
    _setProviderBackendsForTesting({
      probe: async () => ({ status: "verified", detail: "HTTP 200" }),
      models: async () => {
        throw new Error("boom");
      },
    });
    const r = await engine.providers.check("openai", "k");
    expect(r).toEqual({ status: "verified", detail: "HTTP 200", models: [] });
  });

  test("passes a trimmed baseUrl through, and requires it where needed", async () => {
    fakeBackends("verified");
    await rejectsWith(engine.providers.check("openai-compatible", ""), "invalid_argument");
    await rejectsWith(
      engine.providers.check("openai-compatible", "", { baseUrl: "   " }),
      "invalid_argument",
    );
    expect(calls).toEqual([]);
    await engine.providers.check("openai-compatible", "", { baseUrl: " http://127.0.0.1:11434/v1 " });
    expect(calls[0]).toEqual({
      kind: "probe",
      id: "openai-compatible",
      key: "",
      baseUrl: "http://127.0.0.1:11434/v1",
    });
  });

  test("rejects unknown providers and bad arguments before any network call", async () => {
    fakeBackends("verified");
    await rejectsWith(engine.providers.check("nope", "k"), "invalid_argument");
    await rejectsWith(engine.providers.check("openai", 42 as unknown as string), "invalid_argument");
    await rejectsWith(engine.providers.check("openai", "x".repeat(5000)), "invalid_argument");
    await rejectsWith(
      engine.providers.check("openai", "k", { baseUrl: 7 as unknown as string }),
      "invalid_argument",
    );
    expect(calls).toEqual([]);
  });

  test("never echoes the key in detail", async () => {
    // The real probe builds `detail` from status codes and error text only.
    _setProviderBackendsForTesting(undefined);
    const r = await engine.providers.check("openai-compatible", "sk-secret-123", {
      baseUrl: "http://127.0.0.1:9/v1",
    });
    expect(r.detail).not.toContain("sk-secret-123");
    expect(r.status).toBe("unverified");
  });

  test("never echoes the key in detail on the 200 / 401 / 500 paths either", async () => {
    _setProviderBackendsForTesting(undefined);
    const realFetch = globalThis.fetch;
    try {
      for (const code of [200, 401, 500]) {
        globalThis.fetch = (async () =>
          new Response(code === 200 ? '{"data":[]}' : "no", { status: code })) as unknown as typeof fetch;
        const r = await engine.providers.check("openai-compatible", "sk-secret-123", {
          baseUrl: "http://127.0.0.1:9/v1",
        });
        expect(r.status).toBe(code === 200 ? "verified" : code === 401 ? "invalid" : "unverified");
        expect(r.detail).not.toContain("sk-secret-123");
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("rejects after close", async () => {
    await engine.close();
    expect(() => engine.providers.check("openai", "k")).toThrow(EngineError);
    engine = await createEngine({ root, log: "silent" });
  });
});
