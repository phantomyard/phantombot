/*
 * fileEncrypt is the egress counterpart to blossomFetch. It must produce the
 * exact byte layout the PWA's Web Crypto AES-GCM decrypt expects (ciphertext‖
 * tag) so a voice note the bot sends round-trips on the recipient. Two
 * assertions:
 *   1. our own node:crypto decrypt (fetchAndDecryptBlossom) recovers it, and
 *   2. Web Crypto (what the PWA actually runs) recovers it too.
 */
import { describe, expect, test } from "bun:test";
import { encryptFileBytes } from "../src/channels/phantomchat/fileEncrypt.ts";
import { fetchAndDecryptBlossom } from "../src/channels/phantomchat/blossomFetch.ts";

describe("fileEncrypt — AES-256-GCM encrypt (PWA round-trip)", () => {
  test("blossomFetch decrypts what encryptFileBytes produced", async () => {
    const plaintext = Buffer.from("synthesized ogg/opus voice bytes 🎙️ reply");
    const enc = encryptFileBytes(plaintext);

    // 32-byte key, 12-byte iv, hex-encoded.
    expect(enc.keyHex.length).toBe(64);
    expect(enc.ivHex.length).toBe(24);
    // sha256 of the CIPHERTEXT (the Blossom content address).
    expect(enc.sha256Hex.length).toBe(64);

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(enc.ciphertext, { status: 200 })) as unknown as typeof fetch;
    try {
      const out = await fetchAndDecryptBlossom(
        "https://blossom.example/x",
        enc.keyHex,
        enc.ivHex,
        { expectedSha256Hex: enc.sha256Hex },
      );
      expect(new Uint8Array(out)).toEqual(new Uint8Array(plaintext));
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("Web Crypto (the PWA's decrypt) recovers the plaintext", async () => {
    const plaintext = Buffer.from("PWA-side decrypt check");
    const enc = encryptFileBytes(plaintext);

    const key = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(Buffer.from(enc.keyHex, "hex")),
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    // Web Crypto wants ciphertext‖tag in one buffer — exactly our layout.
    const out = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(Buffer.from(enc.ivHex, "hex")) },
        key,
        new Uint8Array(enc.ciphertext),
      ),
    );
    expect(out).toEqual(new Uint8Array(plaintext));
  });

  test("fresh key + iv per call", () => {
    const a = encryptFileBytes(Buffer.from("x"));
    const b = encryptFileBytes(Buffer.from("x"));
    expect(a.keyHex).not.toBe(b.keyHex);
    expect(a.ivHex).not.toBe(b.ivHex);
  });
});
