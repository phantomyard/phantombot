/*
 * blossomFetch decrypt must round-trip the PWA's Web Crypto AES-GCM encrypt.
 * The PWA (phantomchat file-crypto.ts) encrypts with Web Crypto, which APPENDS
 * the 16-byte GCM tag to the ciphertext; this asserts the bot's node:crypto
 * decrypt (which splits the tag) recovers the exact plaintext.
 */
import { describe, expect, test } from "bun:test";
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
        { expectedSha256Hex: sha256 },
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
          { expectedSha256Hex: "deadbeef" },
        ),
      ).rejects.toThrow(/sha256 mismatch/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
