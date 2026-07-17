/**
 * Tests for the bot-side Blossom server list: website fetch, disaster-net
 * fallback, and multi-GET candidate expansion (primary → mirrors → hash GETs).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_BLOSSOM_SERVERS,
  blossomHashUrl,
  expandBlossomFetchUrls,
  fetchCanonicalBlossomServers,
} from "../src/channels/phantomchat/blossomServers.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = realFetch;
});

function mockFetch(impl: (url: string) => Promise<Response>) {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = ((
    input: string | URL,
  ) => impl(String(input))) as unknown as typeof fetch;
}

describe("fetchCanonicalBlossomServers", () => {
  test("parses a valid blossom.json into an https URL list", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          servers: [
            "https://nostr.download",
            "https://blossom.ditto.pub/",
            "https://blossom.data.haus",
          ],
        }),
        { status: 200 },
      ),
    );
    expect(await fetchCanonicalBlossomServers("https://x/blossom.json")).toEqual([
      "https://nostr.download",
      "https://blossom.ditto.pub",
      "https://blossom.data.haus",
    ]);
  });

  test("filters non-https and de-dupes", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          servers: [
            "https://ok.example",
            "http://insecure.example",
            "https://ok.example/",
            42,
            null,
          ],
        }),
        { status: 200 },
      ),
    );
    expect(await fetchCanonicalBlossomServers("https://x/blossom.json")).toEqual([
      "https://ok.example",
    ]);
  });

  test("returns null on non-ok / malformed / empty / throw", async () => {
    mockFetch(async () => new Response("nope", { status: 404 }));
    expect(await fetchCanonicalBlossomServers("https://x/blossom.json")).toBeNull();

    mockFetch(async () => new Response(JSON.stringify({ nope: 1 }), { status: 200 }));
    expect(await fetchCanonicalBlossomServers("https://x/blossom.json")).toBeNull();

    mockFetch(async () =>
      new Response(JSON.stringify({ servers: ["http://x"] }), { status: 200 }),
    );
    expect(await fetchCanonicalBlossomServers("https://x/blossom.json")).toBeNull();

    mockFetch(async () => {
      throw new Error("network down");
    });
    expect(await fetchCanonicalBlossomServers("https://x/blossom.json")).toBeNull();
  });
});

describe("DEFAULT_BLOSSOM_SERVERS disaster net", () => {
  test("is the solid free trio (no mime walls / paid hosts)", () => {
    expect(DEFAULT_BLOSSOM_SERVERS).toEqual([
      "https://nostr.download",
      "https://blossom.ditto.pub",
      "https://blossom.data.haus",
    ]);
  });
});

describe("expandBlossomFetchUrls", () => {
  test("orders primary → mirrors → hash GETs on known servers, de-duped", () => {
    const sha = "ab".repeat(32);
    const urls = expandBlossomFetchUrls(
      "https://nostr.download/" + sha,
      sha,
      ["https://blossom.ditto.pub/" + sha, "https://nostr.download/" + sha],
      ["https://nostr.download", "https://blossom.data.haus"],
    );
    expect(urls).toEqual([
      "https://nostr.download/" + sha,
      "https://blossom.ditto.pub/" + sha,
      // hash GET on data.haus only (nostr.download already present via primary)
      blossomHashUrl("https://blossom.data.haus", sha),
    ]);
  });

  test("skips hash expansion when sha256 is missing / invalid", () => {
    expect(
      expandBlossomFetchUrls("https://primary.example/x", undefined, ["https://m.example/x"]),
    ).toEqual(["https://primary.example/x", "https://m.example/x"]);
    expect(expandBlossomFetchUrls("https://primary.example/x", "not-a-hash", [])).toEqual([
      "https://primary.example/x",
    ]);
  });
});
