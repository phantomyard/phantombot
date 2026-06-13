/**
 * Tests for `phantombot phantomchat`'s side-effect helpers + identity helpers.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyPhantomchatConfig,
  parseAllowedNpubs,
  parseRelays,
} from "../src/cli/phantomchat.ts";
import {
  decodeNpubToHex,
  generateIdentity,
  identityFromNsec,
  loadIdentityFromEnv,
} from "../src/lib/nostrIdentity.ts";

let workdir: string;
let configPath: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-pc-cli-"));
  configPath = join(workdir, "config.toml");
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

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

describe("applyPhantomchatConfig", () => {
  test("writes [channels.phantomchat] relays + allowed_npubs, not the nsec", async () => {
    await applyPhantomchatConfig(configPath, {
      relays: ["wss://a.example"],
      allowedNpubs: ["npub1aaa"],
    });
    const text = await readFile(configPath, "utf8");
    expect(text).toContain("[channels.phantomchat]");
    expect(text).toContain("wss://a.example");
    expect(text).toContain("npub1aaa");
    expect(text).not.toContain("nsec");
    expect(text).not.toContain("secret");
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

  test("loadIdentityFromEnv reads PHANTOMCHAT_NSEC, undefined when absent/bad", () => {
    const id = generateIdentity();
    expect(loadIdentityFromEnv({ PHANTOMCHAT_NSEC: id.nsec } as never)?.npub).toBe(
      id.npub,
    );
    expect(loadIdentityFromEnv({} as never)).toBeUndefined();
    expect(
      loadIdentityFromEnv({ PHANTOMCHAT_NSEC: "not-an-nsec" } as never),
    ).toBeUndefined();
  });
});
