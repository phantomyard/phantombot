/**
 * The live model catalogue — the fallback that keeps the wizard's model
 * pickers SEARCHABLE when `pi --list-models` knows nothing about the provider
 * the operator just picked. Before it, that case dropped to a free-text row
 * and asked the user to type a model id from memory.
 */

import { describe, expect, test } from "bun:test";
import { fetchProviderModels } from "../src/lib/providerModelCatalog.ts";

/** A fetch stub that records the request and answers with one JSON body. */
function stubFetch(body: unknown, init: { ok?: boolean } = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (url: string | URL | Request, opts?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (opts?.headers ?? {}) as Record<string, string>,
    });
    return {
      ok: init.ok ?? true,
      status: init.ok === false ? 500 : 200,
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("fetchProviderModels", () => {
  test("reads the OpenAI-shaped list and needs no key for openrouter", async () => {
    const { impl, calls } = stubFetch({
      data: [
        { id: "anthropic/claude-sonnet-4.6", architecture: { input_modalities: ["text", "image"] } },
        { id: "deepseek/deepseek-v4-pro", architecture: { input_modalities: ["text"] } },
      ],
    });
    const models = await fetchProviderModels("openrouter", "", impl);
    expect(models).toEqual([
      { provider: "openrouter", model: "anthropic/claude-sonnet-4.6", supportsImages: true },
      { provider: "openrouter", model: "deepseek/deepseek-v4-pro", supportsImages: false },
    ]);
    // Public catalogue endpoint, NOT the probe's /key.
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/models");
  });

  test("strips Google's `models/` prefix so `pi --model` accepts the id", async () => {
    const { impl } = stubFetch({ models: [{ name: "models/gemini-2.5-pro" }] });
    const models = await fetchProviderModels("google", "k", impl);
    expect(models).toEqual([
      { provider: "google", model: "gemini-2.5-pro", supportsImages: false },
    ]);
  });

  test("authenticates OpenAI-compatible providers with a Bearer key", async () => {
    const { impl, calls } = stubFetch({ data: [{ id: "gpt-5.2" }] });
    await fetchProviderModels("openai", "sk-test", impl);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/models");
    expect(calls[0]!.headers.Authorization).toBe("Bearer sk-test");
  });

  test("anthropic gets its own header shape and a full-page limit", async () => {
    const { impl, calls } = stubFetch({ data: [{ id: "claude-sonnet-4-6" }] });
    await fetchProviderModels("anthropic", "sk-ant", impl);
    expect(calls[0]!.url).toContain("limit=1000");
    expect(calls[0]!.headers["x-api-key"]).toBe("sk-ant");
  });

  test("no key means no request for providers that require one", async () => {
    const { impl, calls } = stubFetch({ data: [{ id: "gpt-5.2" }] });
    expect(await fetchProviderModels("openai", "", impl)).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("an unknown provider, a non-2xx and a throw all degrade to []", async () => {
    const ok = stubFetch({ data: [{ id: "x" }] });
    expect(await fetchProviderModels("no-such-provider", "k", ok.impl)).toEqual([]);

    const bad = stubFetch({ data: [{ id: "x" }] }, { ok: false });
    expect(await fetchProviderModels("openai", "k", bad.impl)).toEqual([]);

    const boom = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await fetchProviderModels("openai", "k", boom)).toEqual([]);
  });

  test("duplicate ids collapse so the picker never shows a model twice", async () => {
    const { impl } = stubFetch({ data: [{ id: "gpt-5.2" }, { id: "gpt-5.2" }] });
    const models = await fetchProviderModels("openai", "k", impl);
    expect(models).toHaveLength(1);
  });
});

/**
 * The bring-your-own-endpoint providers (issue #694). Their `/models` lives
 * wherever the operator says it does, and an unauthenticated self-hosted server
 * is a legitimate configuration — both are the opposite of every catalog entry.
 */
describe("fetchProviderModels — custom providers (#694)", () => {
  test("openai-compatible asks the operator's endpoint, not a hardcoded vendor", async () => {
    const { impl, calls } = stubFetch({ data: [{ id: "llama3.1:70b" }] });
    const models = await fetchProviderModels(
      "openai-compatible",
      "sk-local",
      impl,
      { baseUrl: "http://localhost:11434/v1/" },
    );
    expect(calls[0]!.url).toBe("http://localhost:11434/v1/models");
    expect(calls[0]!.headers.Authorization).toBe("Bearer sk-local");
    expect(models).toEqual([
      { provider: "openai-compatible", model: "llama3.1:70b", supportsImages: false },
    ]);
  });

  test("an unauthenticated self-hosted server is queried with NO auth header", async () => {
    // Ollama / LM Studio / llama.cpp ignore Authorization, and an empty Bearer
    // is worse than no header. The empty key must not short-circuit the fetch.
    const { impl, calls } = stubFetch({ models: [{ name: "qwen2.5-coder:7b" }] });
    const models = await fetchProviderModels(
      "openai-compatible",
      "",
      impl,
      { baseUrl: "http://localhost:11434/v1" },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.Authorization).toBeUndefined();
    expect(models.map((m) => m.model)).toEqual(["qwen2.5-coder:7b"]);
  });

  test("no base URL ⇒ no request at all (never a guess)", async () => {
    const { impl, calls } = stubFetch({ data: [{ id: "x" }] });
    expect(await fetchProviderModels("openai-compatible", "k", impl)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("PhantomOps defaults to the gateway and needs its token", async () => {
    const { impl, calls } = stubFetch({ data: [{ id: "phantomops/auto" }] });
    expect(await fetchProviderModels("phantomops", "", impl)).toEqual([]);
    expect(calls).toHaveLength(0);

    const models = await fetchProviderModels("phantomops", "pok_x", impl);
    expect(calls[0]!.url).toBe("https://phantomops.app/api/v1/models");
    expect(calls[0]!.headers.Authorization).toBe("Bearer pok_x");
    expect(models.map((m) => m.model)).toEqual(["phantomops/auto"]);
  });

  test("phantomops/auto is FIRST even when the server lists it last", async () => {
    // The pickers pre-select index 0, and "your full phantom" is the product
    // decision the provider exists for.
    const { impl } = stubFetch({
      data: [{ id: "openrouter/foo" }, { id: "anthropic/bar" }, { id: "phantomops/auto" }],
    });
    const models = await fetchProviderModels("phantomops", "pok_x", impl);
    expect(models.map((m) => m.model)).toEqual([
      "phantomops/auto",
      "openrouter/foo",
      "anthropic/bar",
    ]);
  });

  test("a baseUrl passed for a CATALOG provider is ignored", async () => {
    // Only the custom providers carry an endpoint; letting a stray base_url
    // redirect a catalog provider would send a vendor key to an arbitrary host.
    const { impl, calls } = stubFetch({ data: [{ id: "gpt-5.2" }] });
    await fetchProviderModels("openai", "sk-test", impl, { baseUrl: "https://evil.example/v1" });
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/models");
  });
});
