/**
 * Key probing for the bring-your-own-endpoint providers (issue #694).
 *
 * The catalogue path assumes "no key ⇒ nothing to check". Both new providers
 * break that assumption in opposite directions: a self-hosted OpenAI-compatible
 * server is often UNAUTHENTICATED (so an empty key is a real configuration and
 * must still be probed), while PhantomOps always needs its token. Getting that
 * inverted means the wizard either blocks a valid setup or reports a green tick
 * on an endpoint that will 401 every turn.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { probeProviderKey } from "../src/lib/providerKeyProbe.ts";

const realFetch = globalThis.fetch;
let calls: { url: string; headers: Record<string, string> }[] = [];

function stubFetch(status = 200) {
  calls = [];
  globalThis.fetch = (async (url: string | URL | Request, opts?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (opts?.headers ?? {}) as Record<string, string>,
    });
    return { ok: status >= 200 && status < 300, status } as unknown as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("probeProviderKey — custom providers (#694)", () => {
  test("openai-compatible probes the operator's endpoint with Bearer auth", async () => {
    stubFetch(200);
    const res = await probeProviderKey("openai-compatible", "sk-local", {
      baseUrl: "http://localhost:11434/v1/",
    });
    expect(res.status).toBe("verified");
    expect(calls[0]!.url).toBe("http://localhost:11434/v1/models");
    expect(calls[0]!.headers.Authorization).toBe("Bearer sk-local");
  });

  test("an UNAUTHENTICATED self-hosted server is still probed, with no auth header", async () => {
    stubFetch(200);
    const res = await probeProviderKey("openai-compatible", "", {
      baseUrl: "http://localhost:11434/v1",
    });
    expect(res.status).toBe("verified");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.Authorization).toBeUndefined();
  });

  test("without a base URL nothing is guessed and nothing is fetched", async () => {
    stubFetch(200);
    const res = await probeProviderKey("openai-compatible", "sk-local");
    expect(res.status).toBe("unverified");
    expect(res.detail).toContain("base URL");
    expect(calls).toHaveLength(0);
  });

  test("PhantomOps needs its token even though its endpoint is known", async () => {
    stubFetch(200);
    const missing = await probeProviderKey("phantomops", "");
    expect(missing.status).toBe("unverified");
    expect(calls).toHaveLength(0);

    const ok = await probeProviderKey("phantomops", "pok_x");
    expect(ok.status).toBe("verified");
    expect(calls[0]!.url).toBe("https://phantomops.app/api/v1/models");
    expect(calls[0]!.headers.Authorization).toBe("Bearer pok_x");
  });

  test("an explicit rejection from the endpoint is INVALID, not merely unverified", async () => {
    stubFetch(401);
    const res = await probeProviderKey("phantomops", "pok_bad");
    expect(res.status).toBe("invalid");
  });
});
