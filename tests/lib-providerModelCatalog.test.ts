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
