/**
 * Tests for `phantombot phantomchat`'s parse helpers + identity helpers.
 * (The per-persona file store is covered in channels-phantomchat-personaStore.test.ts.)
 */

import { describe, expect, test } from "bun:test";

import { parseAllowedNpubs, parseRelays } from "../src/cli/phantomchat.ts";
import {
  decodeNpubToHex,
  generateIdentity,
  identityFromNsec,
} from "../src/lib/nostrIdentity.ts";

describe("parseRelays", () => {
  test("keeps only ws(s):// URLs, comma/space separated", () => {
    expect(parseRelays("wss://a.example, wss://b.example http://nope")).toEqual([
      "wss://a.example",
      "wss://b.example",
    ]);
  });
  test("returns [] on empty input", () => {
    expect(parseRelays("  ")).toEqual([]);
  });
});

describe("parseAllowedNpubs", () => {
  test("keeps only decodable npubs", () => {
    const id = generateIdentity();
    const good = id.npub;
    expect(parseAllowedNpubs(`${good}, npub1garbage, notanpub`)).toEqual([good]);
  });
  test("returns [] on empty input", () => {
    expect(parseAllowedNpubs("")).toEqual([]);
  });
});

describe("nostr identity helpers", () => {
  test("generate → nsec → identity round-trips the keypair", () => {
    const id = generateIdentity();
    expect(id.npub.startsWith("npub1")).toBe(true);
    expect(id.nsec.startsWith("nsec1")).toBe(true);
    expect(id.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);

    const reloaded = identityFromNsec(id.nsec);
    expect(reloaded.publicKeyHex).toBe(id.publicKeyHex);
    expect(reloaded.npub).toBe(id.npub);
  });

  test("decodeNpubToHex round-trips against the npub encoding", () => {
    const id = generateIdentity();
    expect(decodeNpubToHex(id.npub)).toBe(id.publicKeyHex);
    // Bare hex passes through (lowercased).
    expect(decodeNpubToHex(id.publicKeyHex.toUpperCase())).toBe(id.publicKeyHex);
  });
});
