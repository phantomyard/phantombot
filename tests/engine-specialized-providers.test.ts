/**
 * Specialized model providers: the Pi providers that can fill the voice and
 * embeddings slots (fixed endpoints, filtered by model type), and the
 * decision-model providers. A preset never sends a key to a caller-chosen
 * host and is stored as openai-compatible + its own URL.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngine, type Engine, EngineError } from "../src/engine/index.ts";
import { _setEmbeddingsBackendsForTesting } from "../src/engine/embeddings.ts";
import { loadConfig } from "../src/config.ts";
import { PI_PROVIDER_CATALOG } from "../src/lib/piModels.ts";
import { EMBEDDINGS_PRESETS, VOICE_PRESETS } from "../src/lib/specializedProviders.ts";

let root: string;
let engine: Engine;
const realFetch = globalThis.fetch;
let requests: Array<{ url: string; auth: string | null }>;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "phantombot-specialized-"));
  requests = [];
  // Every provider host answers like an OpenAI /models without type metadata.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const auth = new Headers(init?.headers).get("authorization");
    requests.push({ url, auth });
    if (auth === "Bearer bad") return new Response("no", { status: 401 });
    return Response.json({ data: [{ id: "some-chat-model" }] });
  }) as typeof fetch;
  engine = await createEngine({ root, log: "silent" });
  await engine.personas.create("p");
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  _setEmbeddingsBackendsForTesting(undefined);
  await engine.close();
  rmSync(root, { recursive: true, force: true });
});

async function rejects(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(EngineError);
    return (e as EngineError).message;
  }
  throw new Error("expected rejection");
}

const piIds = new Set(PI_PROVIDER_CATALOG.map((p) => p.id));
const configText = async () => {
  const cfg = await engine.run(() => loadConfig("p"));
  return readFileSync(join(cfg.personasDir, "p", "config.toml"), "utf8");
};

describe("voice presets", () => {
  test("every preset is a Pi provider, listed with only the modalities it serves", async () => {
    for (const p of VOICE_PRESETS) expect(piIds.has(p.id)).toBe(true);
    const list = await engine.voiceModels.providers();
    const groq = list.find((p) => p.id === "groq")!;
    expect(groq.modalities).toEqual(["stt"]);
    expect(groq.transport).toEqual({ provider: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1" });
    expect(list.find((p) => p.id === "openai")!.modalities).toEqual(["tts", "stt"]);
    expect(list.map((p) => p.id)).toContain("elevenlabs");
    expect(list.find((p) => p.id === "openai-compatible")!.needsBaseUrl).toBe(true);
  });

  test("check sends the key to the preset's own host, never a caller baseUrl, and falls back to known models", async () => {
    const r = await engine.voiceModels.check({
      modality: "stt", provider: "openai", apiKey: "k", baseUrl: "https://evil.example/v1",
    });
    expect(r.ok).toBe(true);
    expect(r.models.map((m) => m.id)).toEqual(["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"]);
    expect(requests.length).toBeGreaterThan(0);
    for (const q of requests) expect(q.url.startsWith("https://api.openai.com/v1/")).toBe(true);
  });

  test("a rejected key is not ok and lists nothing", async () => {
    const r = await engine.voiceModels.check({ modality: "stt", provider: "groq", apiKey: "bad" });
    expect(r.ok).toBe(false);
    expect(r.models).toEqual([]);
  });

  test("a modality the preset does not serve is refused", async () => {
    expect(await rejects(engine.voiceModels.check({ modality: "tts", provider: "groq", apiKey: "k" }))).toContain("no TTS");
    expect(await rejects(engine.persona("p").configure({
      voice: { tts: { enabled: true, provider: "groq", model: "m", voice: "v", keyEnv: "K_TTS", apiKey: "k" } },
    }))).toContain("no TTS");
  });

  test("configure stores a preset as openai-compatible + its URL, key in the vault", async () => {
    await engine.persona("p").configure({
      voice: { stt: { enabled: true, provider: "mistral", baseUrl: "https://evil.example/v1", model: "voxtral-mini-latest", keyEnv: "K_STT", apiKey: "secret-stt" } },
    });
    const text = await configText();
    expect(text).toContain('provider = "openai-compatible"');
    expect(text).toContain('base_url = "https://api.mistral.ai/v1"');
    expect(text).not.toContain("evil.example");
    expect(text).not.toContain("secret-stt");
  });
});

describe("embeddings presets", () => {
  test("providers: gemini, Pi presets, then bring-your-own", async () => {
    for (const p of EMBEDDINGS_PRESETS) expect(piIds.has(p.id)).toBe(true);
    const list = await engine.embeddings.providers();
    expect(list[0]!.id).toBe("gemini");
    expect(list.at(-1)).toMatchObject({ id: "openai-compatible", needsBaseUrl: true, keyOptional: true });
    expect(list.find((p) => p.id === "openrouter")!.transport!.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  test("check uses the preset URL and its known models when the live list has none", async () => {
    const seen: string[] = [];
    _setEmbeddingsBackendsForTesting({
      gemini: async () => ({ ok: false, error: "unused" }),
      openai: async (o) => {
        seen.push(o.baseUrl);
        return { ok: true, values: new Float32Array(4), dims: 4 };
      },
      models: async (baseUrl) => {
        seen.push(baseUrl);
        return [];
      },
    });
    const listed = await engine.embeddings.check({ provider: "openai", apiKey: "k", baseUrl: "https://evil.example/v1" });
    expect(listed).toMatchObject({ status: "unchecked", models: ["text-embedding-3-small", "text-embedding-3-large"] });
    const proved = await engine.embeddings.check({ provider: "openai", apiKey: "k", model: "text-embedding-3-small" });
    expect(proved).toMatchObject({ status: "verified", dims: 4 });
    expect(seen.every((u) => u === "https://api.openai.com/v1")).toBe(true);
  });

  test("configure stores a preset as openai-compatible + its URL, and needs a key", async () => {
    expect(await rejects(engine.persona("p").configure({
      embeddings: { provider: "mistral", model: "mistral-embed" },
    }))).toContain("apiKey is required");
    await engine.persona("p").configure({
      embeddings: { provider: "mistral", model: "mistral-embed", apiKey: "secret-emb", dims: 1024 },
    });
    const text = await configText();
    expect(text).toContain('provider = "openai-compatible"');
    expect(text).toContain('base_url = "https://api.mistral.ai/v1"');
    expect(text).not.toContain("secret-emb");
  });
});

test("decisionModels.providers: only the providers with a decisions API", async () => {
  expect(await engine.decisionModels.providers()).toEqual([
    { id: "openrouter", label: "OpenRouter" },
    { id: "typesafe", label: "TypeSafe", defaultModel: "typesafe/jev-1.13" },
  ]);
});

test("persona.brain(): provider and model as configured, key presence only", async () => {
  const p = engine.persona("p");
  expect(await p.brain()).toEqual({ hasKey: false });
  await p.configure({ brain: { native: { provider: "openrouter", model: "a/b", apiKey: "secret-brain" } } });
  const info = await p.brain();
  expect(info).toEqual({ provider: "openrouter", model: "a/b", hasKey: true });
  expect(JSON.stringify(info)).not.toContain("secret-brain");
  expect(await rejects(engine.persona("nobody").brain())).toBeTruthy();
});

test("persona.brainCheck(): checks the stored key with its own provider only", async () => {
  const p = engine.persona("p");
  expect(await p.brainCheck()).toEqual({ status: "unverified", detail: "no stored key", models: [] });
  await p.configure({ brain: { native: { provider: "openai", model: "gpt-x", apiKey: "stored-key" } } });
  requests = [];
  const r = await p.brainCheck();
  expect(r.status).toBe("verified");
  expect(requests.length).toBeGreaterThan(0);
  for (const q of requests) {
    expect(q.url.startsWith("https://api.openai.com/")).toBe(true);
    expect(q.auth).toBe("Bearer stored-key");
  }
  expect(JSON.stringify(r)).not.toContain("stored-key");
});

test("persona.brainCheck(): a bring-your-own endpoint is checked at its stored base_url", async () => {
  const p = engine.persona("p");
  await p.configure({ brain: { native: { provider: "openai-compatible", model: "m", apiKey: "byo-key" } } });
  const cfg = await engine.run(() => loadConfig("p"));
  const path = join(cfg.personasDir, "p", "config.toml");
  const text = readFileSync(path, "utf8").replace(/(\[harnesses\.pi\.routing\]\n)/, '$1base_url = "https://llm.example.test/v1"\n');
  writeFileSync(path, text);
  expect(await p.brain()).toEqual({
    provider: "openai-compatible",
    model: "m",
    baseUrl: "https://llm.example.test/v1",
    hasKey: true,
  });
  requests = [];
  const r = await p.brainCheck();
  expect(r.status).not.toBe("invalid");
  expect(requests.length).toBeGreaterThan(0);
  for (const q of requests) expect(q.url.startsWith("https://llm.example.test/v1/")).toBe(true);
  expect(JSON.stringify(r)).not.toContain("byo-key");
});
