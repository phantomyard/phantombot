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

describe("engine.providers.check", () => {
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

  test("rejects after close", async () => {
    await engine.close();
    expect(() => engine.providers.check("openai", "k")).toThrow(EngineError);
    engine = await createEngine({ root, log: "silent" });
  });
});
