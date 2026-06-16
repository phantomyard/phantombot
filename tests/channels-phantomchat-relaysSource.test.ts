/**
 * Tests for fetchCanonicalRelays — pulls the canonical relay list from the
 * PWA-served /relays.json (single source of truth) and returns null on any
 * failure so callers fall back to cached/seed relays.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  fetchCanonicalRelays,
  sameRelays,
} from "../src/channels/phantomchat/relaysSource.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = realFetch;
});

function mockFetch(impl: () => Promise<Response>) {
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    impl as unknown as typeof fetch;
}

describe("fetchCanonicalRelays", () => {
  test("parses a valid relays.json into a wss URL list", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({ relays: ["wss://a.example", "wss://b.example"] }),
        { status: 200 },
      ),
    );
    expect(await fetchCanonicalRelays("https://x/relays.json")).toEqual([
      "wss://a.example",
      "wss://b.example",
    ]);
  });

  test("filters out non-ws(s) and non-string entries", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({ relays: ["wss://ok", "http://bad", 42, null] }),
        { status: 200 },
      ),
    );
    expect(await fetchCanonicalRelays("https://x/relays.json")).toEqual([
      "wss://ok",
    ]);
  });

  test("returns null on a non-ok response", async () => {
    mockFetch(async () => new Response("nope", { status: 404 }));
    expect(await fetchCanonicalRelays("https://x/relays.json")).toBeNull();
  });

  test("returns null when relays is missing / not an array", async () => {
    mockFetch(async () => new Response(JSON.stringify({ nope: 1 }), { status: 200 }));
    expect(await fetchCanonicalRelays("https://x/relays.json")).toBeNull();
  });

  test("returns null when no valid relays survive filtering", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ relays: ["http://x", 1] }), { status: 200 }),
    );
    expect(await fetchCanonicalRelays("https://x/relays.json")).toBeNull();
  });

  test("returns null when fetch throws (offline)", async () => {
    mockFetch(async () => {
      throw new Error("network down");
    });
    expect(await fetchCanonicalRelays("https://x/relays.json")).toBeNull();
  });
});

describe("sameRelays", () => {
  test("true for identical order + contents", () => {
    expect(sameRelays(["wss://a", "wss://b"], ["wss://a", "wss://b"])).toBe(true);
  });
  test("false on differing length or order", () => {
    expect(sameRelays(["wss://a"], ["wss://a", "wss://b"])).toBe(false);
    expect(sameRelays(["wss://a", "wss://b"], ["wss://b", "wss://a"])).toBe(false);
  });
});
