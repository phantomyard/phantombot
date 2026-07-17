/*
 * blossomFetch decrypt must round-trip the PWA's Web Crypto AES-GCM encrypt.
 * The PWA (phantomchat file-crypto.ts) encrypts with Web Crypto, which APPENDS
 * the 16-byte GCM tag to the ciphertext; this asserts the bot's node:crypto
 * decrypt (which splits the tag) recovers the exact plaintext.
 *
 * Also covers multi-GET receive: primary host dead → mirror / hash-GET works.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { fetchAndDecryptBlossom } from "../src/channels/phantomchat/blossomFetch.ts";

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("blossomFetch — AES-256-GCM decrypt (PWA round-trip)", () => {
  test("decrypts a Web-Crypto-encrypted blob (tag appended) back to plaintext", async () => {
    const plaintext = new TextEncoder().encode("fake ogg/opus voice bytes 🎙️ test");
    const key = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, [
      "encrypt",
    ]);
    // Web Crypto output is ciphertext‖tag — exactly what the PWA uploads.
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, plaintext),
    );
    const sha256 = toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", ct)));

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(ct, { status: 200 })) as unknown as typeof fetch;
    try {
      const out = await fetchAndDecryptBlossom(
        "https://blossom.example/x",
        toHex(key),
        toHex(iv),
        {
          expectedSha256Hex: sha256,
          // Pin known servers empty so we don't hit real defaults.
          knownServers: [],
        },
      );
      expect(new Uint8Array(out)).toEqual(new Uint8Array(plaintext));
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("rejects a sha256 mismatch before attempting decryption", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })) as unknown as typeof fetch;
    try {
      await expect(
        fetchAndDecryptBlossom(
          "https://blossom.example/x",
          "00".repeat(32),
          "00".repeat(12),
          { expectedSha256Hex: "deadbeef", knownServers: [] },
        ),
      ).rejects.toThrow(/sha256 mismatch|blossom fetch failed/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("falls back to a mirror when the primary host 404s", async () => {
    const plaintext = new TextEncoder().encode("mirror1-ok");
    const key = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, [
      "encrypt",
    ]);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, plaintext),
    );
    const sha256 = createHash("sha256").update(ct).digest("hex");

    const hits: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL) => {
      const u = String(input);
      hits.push(u);
      if (u.includes("primary")) return new Response("gone", { status: 404 });
      if (u.includes("mirror1")) return new Response(ct, { status: 200 });
      return new Response("nope", { status: 500 });
    }) as unknown as typeof fetch;
    try {
      const out = await fetchAndDecryptBlossom(
        "https://primary.example/" + sha256,
        toHex(key),
        toHex(iv),
        {
          expectedSha256Hex: sha256,
          mirrors: ["https://mirror1.example/" + sha256],
          knownServers: [],
        },
      );
      expect(new Uint8Array(out)).toEqual(new Uint8Array(plaintext));
      expect(hits[0]).toContain("primary");
      expect(hits.some((h) => h.includes("mirror1"))).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("falls back to hash-GET on a known server when envelope mirrors are empty", async () => {
    const plaintext = new TextEncoder().encode("hash-get-ok");
    const key = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, [
      "encrypt",
    ]);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, plaintext),
    );
    const sha256 = createHash("sha256").update(ct).digest("hex");

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL) => {
      const u = String(input);
      if (u.startsWith("https://dead.example/")) return new Response("gone", { status: 404 });
      if (u === `https://nostr.download/${sha256}`) return new Response(ct, { status: 200 });
      return new Response("nope", { status: 500 });
    }) as unknown as typeof fetch;
    try {
      const out = await fetchAndDecryptBlossom(
        "https://dead.example/" + sha256,
        toHex(key),
        toHex(iv),
        {
          expectedSha256Hex: sha256,
          knownServers: ["https://nostr.download"],
        },
      );
      expect(new Uint8Array(out)).toEqual(new Uint8Array(plaintext));
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
