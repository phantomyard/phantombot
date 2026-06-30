/**
 * Tests for the NIP-17 gift-wrap crypto (the wire-compat crux).
 *
 * Round-trips a message as the "PWA" (sender) → phantombot (recipient) and
 * asserts the recovered rumor, then asserts the verifying unwrap REJECTS a
 * tampered rumor.id and a pubkey-binding mismatch — the two checks that make
 * `rumor.pubkey` safe to use as the auth principal.
 */

import { describe, expect, test } from "bun:test";
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  getEventHash,
  verifyEvent,
} from "nostr-tools/pure";

import {
  GiftWrapVerificationError,
  NOSTR_KIND_TYPING_RUMOR,
  createGiftWrap,
  createRumor,
  getConversationKey,
  nip44Encrypt,
  unwrapNip17Message,
  wrapNip17Message,
  wrapTypingGiftWrap,
  type NTNostrEvent,
  type SignedEvent,
  type UnsignedEvent,
} from "../src/lib/nostrCrypto.ts";

describe("wrapTypingGiftWrap — dedicated inner kind", () => {
  test("inner rumor carries NOSTR_KIND_TYPING_RUMOR (not the message kind 14)", () => {
    const senderSk = generateSecretKey();
    const recipientSk = generateSecretKey();
    const recipientHex = getPublicKey(recipientSk);

    const wrap = wrapTypingGiftWrap(senderSk, recipientHex, "stop", recipientHex);
    // Outer wrap is the standard gift-wrap kind; relays see only this.
    expect(wrap.kind).toBe(1059);

    const rumor = unwrapNip17Message(wrap, recipientSk);
    // Inner kind is the dedicated typing kind — this is what keeps a tick from
    // ever being mistaken for a kind-14 message on the receive side.
    expect(rumor.kind).toBe(NOSTR_KIND_TYPING_RUMOR);
    expect(rumor.kind).not.toBe(14);
    expect(rumor.content).toBe("stop");
    expect(rumor.tags.some((t) => t[0] === "d")).toBe(true);
  });
});

describe("wrapNip17Message / unwrapNip17Message round-trip", () => {
  test("recipient recovers the exact plaintext envelope; sender is rumor.pubkey", () => {
    const senderSk = generateSecretKey(); // the PWA
    const recipientSk = generateSecretKey(); // phantombot
    const senderHex = getPublicKey(senderSk);
    const recipientHex = getPublicKey(recipientSk);

    const envelope = JSON.stringify({
      id: "msg-1",
      from: senderHex,
      to: recipientHex,
      type: "text",
      content: "hello phantombot",
      timestamp: Date.now(),
    });

    const { wraps, rumorId } = wrapNip17Message(senderSk, recipientHex, envelope);
    // Two wraps: [recipientWrap, selfWrap].
    expect(wraps).toHaveLength(2);

    // The recipient unwraps the FIRST wrap with their own key.
    const rumor = unwrapNip17Message(wraps[0] as NTNostrEvent, recipientSk);

    // Cryptographic sender === the PWA's pubkey (the auth principal).
    expect(rumor.pubkey).toBe(senderHex);
    expect(rumor.id).toBe(rumorId);
    // The recovered content is byte-identical to the sent envelope.
    expect(rumor.content).toBe(envelope);
    expect(JSON.parse(rumor.content).content).toBe("hello phantombot");
  });

  test("self-wrap unwraps to the same rumor for the sender", () => {
    const senderSk = generateSecretKey();
    const recipientSk = generateSecretKey();
    const recipientHex = getPublicKey(recipientSk);

    const { wraps } = wrapNip17Message(senderSk, recipientHex, "hi");
    // wraps[1] is the self-wrap; the SENDER unwraps it with their own key.
    const rumor = unwrapNip17Message(wraps[1] as NTNostrEvent, senderSk);
    expect(rumor.content).toBe("hi");
    expect(rumor.pubkey).toBe(getPublicKey(senderSk));
  });
});

describe("verifying unwrap rejects tampering", () => {
  test("(f) a tampered rumor.id is rejected", () => {
    const senderSk = generateSecretKey();
    const recipientSk = generateSecretKey();
    const recipientHex = getPublicKey(recipientSk);

    // Build a rumor, then CORRUPT its id before sealing/wrapping. The id no
    // longer matches getEventHash(rumor), so unwrap must throw rumor_id.
    const rumor = createRumor("tampered", senderSk, [["p", recipientHex]]);
    const badRumor: UnsignedEvent = { ...rumor, id: "0".repeat(64) };

    const convKey = getConversationKey(senderSk, recipientHex);
    const sealTemplate = {
      kind: 13,
      created_at: Math.floor(Date.now() / 1000),
      tags: [] as string[][],
      content: nip44Encrypt(JSON.stringify(badRumor), convKey),
    };
    const seal = finalizeEvent(sealTemplate, senderSk) as unknown as SignedEvent;
    const wrap = createGiftWrap(seal, recipientHex);

    expect(() => unwrapNip17Message(wrap as NTNostrEvent, recipientSk)).toThrow(
      GiftWrapVerificationError,
    );
    try {
      unwrapNip17Message(wrap as NTNostrEvent, recipientSk);
    } catch (e) {
      expect((e as GiftWrapVerificationError).code).toBe("rumor_id");
    }
  });

  test("(e) a pubkey-binding mismatch is rejected (impersonation)", () => {
    const attackerSk = generateSecretKey(); // signs the seal
    const victimSk = generateSecretKey(); // whose pubkey the attacker claims
    const recipientSk = generateSecretKey();
    const recipientHex = getPublicKey(recipientSk);
    const victimHex = getPublicKey(victimSk);

    // Attacker builds a rumor claiming pubkey = VICTIM, with a self-consistent
    // id, then seals it under their OWN key. rumor.pubkey (victim) !==
    // seal.pubkey (attacker) → unwrap must throw pubkey_binding. The id is the
    // correct canonical hash of the claimed body, so check (f) passes and (e)
    // is the gate that must catch the impersonation.
    const forged = createRumorWithPubkey(
      "i am the victim",
      victimHex,
      Math.floor(Date.now() / 1000),
      [["p", recipientHex]],
    );

    const convKey = getConversationKey(attackerSk, recipientHex);
    const seal = finalizeEvent(
      {
        kind: 13,
        created_at: Math.floor(Date.now() / 1000),
        tags: [] as string[][],
        content: nip44Encrypt(JSON.stringify(forged), convKey),
      },
      attackerSk,
    ) as unknown as SignedEvent;
    const wrap = createGiftWrap(seal, recipientHex);

    try {
      unwrapNip17Message(wrap as NTNostrEvent, recipientSk);
      throw new Error("expected unwrap to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(GiftWrapVerificationError);
      expect((e as GiftWrapVerificationError).code).toBe("pubkey_binding");
    }
  });
});

/**
 * Build a rumor whose `pubkey` is an ARBITRARY hex (not derived from a secret
 * key) but whose `id` is still the correct canonical hash of that body — so it
 * passes check (f) and forces the pubkey-binding check (e) to be the gate.
 * Mirrors createRumor but takes the pubkey directly.
 */
function createRumorWithPubkey(
  content: string,
  pubkey: string,
  created_at: number,
  tags: string[][],
): UnsignedEvent {
  // getEventHash is re-derived inside createRumor via the sender key; here we
  // inline the same hashing by reusing nostr-tools through createRumor is not
  // possible (it derives pubkey), so compute the hash the same way the lib does.
  const event = { kind: 14, created_at, tags, content, pubkey };
  const id = getEventHash(event as never);
  return { ...event, id };
}

// ==================== PhantomChat Protocol v2 Tests ====================

import {
  getSymmetricKey,
  clearSymmetricKeyCache,
  warmSymmetricKeyCache,
  encryptV2,
  decryptV2,
  wrapV2,
  unwrapV2,
  isV2Event,
} from "../src/lib/nostrCrypto.ts";

describe("PhantomChat Protocol v2 — symmetric key derivation", () => {
  test("both parties derive the same key from ECDH (commutativity)", async () => {
    const skA = generateSecretKey();
    const skB = generateSecretKey();
    const pkA = getPublicKey(skA);
    const pkB = getPublicKey(skB);

    const { key: keyA } = await getSymmetricKey(skA, pkB);
    const { key: keyB } = await getSymmetricKey(skB, pkA);

    // Both CryptoKey objects should be functionally identical
    // (same algorithm, same usages). We can't compare CryptoKey objects directly,
    // but we can verify encrypt/decrypt roundtrip across parties.
    const plaintext = "cross-party test";
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const cipherBuf = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      keyA,
      encoded,
    );
    const plainBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      keyB,
      cipherBuf,
    );
    expect(new TextDecoder().decode(plainBuf)).toBe(plaintext);
  });

  test("caching works — same key object returned on second call", async () => {
    clearSymmetricKeyCache();
    const sk = generateSecretKey();
    const peerPk = getPublicKey(generateSecretKey());

    const first = await getSymmetricKey(sk, peerPk);
    const second = await getSymmetricKey(sk, peerPk);
    expect(first.key).toBe(second.key); // same object reference = cache hit
  });

  test("different peers produce different keys", async () => {
    clearSymmetricKeyCache();
    const sk = generateSecretKey();
    const peer1 = getPublicKey(generateSecretKey());
    const peer2 = getPublicKey(generateSecretKey());

    const { key: key1 } = await getSymmetricKey(sk, peer1);
    const { key: key2 } = await getSymmetricKey(sk, peer2);
    expect(key1).not.toBe(key2);
  });

  test("clearSymmetricKeyCache wipes the cache", async () => {
    const sk = generateSecretKey();
    const peer = getPublicKey(generateSecretKey());

    const first = await getSymmetricKey(sk, peer);
    clearSymmetricKeyCache();
    const second = await getSymmetricKey(sk, peer);
    expect(first.key).not.toBe(second.key); // new object after clear
  });
});

describe("PhantomChat Protocol v2 — encrypt/decrypt roundtrip", () => {
  test("AES-256-GCM encrypt then decrypt recovers plaintext", async () => {
    clearSymmetricKeyCache();
    const sk = generateSecretKey();
    const peer = getPublicKey(generateSecretKey());
    const { key } = await getSymmetricKey(sk, peer);

    const plaintext = "hello v2 world 🚀";
    const ciphertext = await encryptV2(plaintext, key);
    const decrypted = await decryptV2(ciphertext, key);
    expect(decrypted).toBe(plaintext);
  });

  test("different ciphertexts for same plaintext (random IV)", async () => {
    clearSymmetricKeyCache();
    const sk = generateSecretKey();
    const peer = getPublicKey(generateSecretKey());
    const { key } = await getSymmetricKey(sk, peer);

    const a = await encryptV2("same", key);
    const b = await encryptV2("same", key);
    expect(a).not.toBe(b); // different IVs → different ciphertexts
  });

  test("wrong key fails to decrypt", async () => {
    clearSymmetricKeyCache();
    const sk1 = generateSecretKey();
    const sk2 = generateSecretKey();
    const peer = getPublicKey(generateSecretKey());

    const { key: key1 } = await getSymmetricKey(sk1, peer);
    const { key: key2 } = await getSymmetricKey(sk2, peer);

    const ciphertext = await encryptV2("secret", key1);
    await expect(decryptV2(ciphertext, key2)).rejects.toThrow();
  });
});

describe("PhantomChat Protocol v2 — wrapV2 / unwrapV2 roundtrip", () => {
  test("recipient recovers plaintext and sender pubkey", async () => {
    clearSymmetricKeyCache();
    const senderSk = generateSecretKey();
    const recipientSk = generateSecretKey();
    const senderHex = getPublicKey(senderSk);
    const recipientHex = getPublicKey(recipientSk);

    const { event, rumorId } = await wrapV2(senderSk, recipientHex, "hello v2");

    expect(event.kind).toBe(1059);
    // event.pubkey is an ephemeral throwaway key — NOT the sender's real key.
    // Sender authenticity lives inside the encrypted rumor (rumor.pubkey).
    expect(event.pubkey).not.toBe(senderHex);
    expect(event.pubkey).not.toBe(recipientHex);
    expect(event.tags.some((t) => t[0] === "v" && t[1] === "pc-v2")).toBe(true);

    const rumor = await unwrapV2(event, recipientSk);
    expect(rumor.content).toBe("hello v2");
    expect(rumor.pubkey).toBe(senderHex);
    expect(rumor.id).toBe(rumorId);
  });

  test("isV2Event detects v2 events", async () => {
    const senderSk = generateSecretKey();
    const recipientSk = generateSecretKey();
    const { event } = await wrapV2(senderSk, getPublicKey(recipientSk), "test");
    expect(isV2Event(event)).toBe(true);
  });

  test("isV2Event returns false for legacy NIP-17 wraps", () => {
    const senderSk = generateSecretKey();
    const recipientPk = getPublicKey(generateSecretKey());
    const { wraps } = wrapNip17Message(senderSk, recipientPk, "legacy");
    expect(isV2Event(wraps[0] as NTNostrEvent)).toBe(false);
  });

  test("self-send unwraps correctly (sender = recipient)", async () => {
    clearSymmetricKeyCache();
    const sk = generateSecretKey();
    const peer = getPublicKey(generateSecretKey());
    const myPk = getPublicKey(sk);

    const { event } = await wrapV2(sk, peer, "self-test");
    // Simulate self-send: event.pubkey === our pubkey, use p tag for counterparty
    const rumor = await unwrapV2(event, sk);
    expect(rumor.content).toBe("self-test");
    expect(rumor.pubkey).toBe(myPk);
  });

  test("unwrapV2 rejects forged signature", async () => {
    clearSymmetricKeyCache();
    const senderSk = generateSecretKey();
    const recipientSk = generateSecretKey();
    const { event } = await wrapV2(senderSk, getPublicKey(recipientSk), "test");

    // Build a completely new event with wrong content but keep the original sig
    const wrongEvent = {
      ...event,
      content: await encryptV2("wrong", (await getSymmetricKey(senderSk, getPublicKey(recipientSk))).key),
    };
    // Sign the wrong event with a different key
    const fakeSk = generateSecretKey();
    const forged = finalizeEvent(
      { kind: 1059, created_at: wrongEvent.created_at, tags: wrongEvent.tags, content: wrongEvent.content },
      fakeSk,
    ) as unknown as NTNostrEvent;

    await expect(unwrapV2(forged, recipientSk)).rejects.toThrow();
  });

  test("unwrapV2 rejects impersonation (rumor.pubkey ≠ event.pubkey)", async () => {
    clearSymmetricKeyCache();
    const attackerSk = generateSecretKey();
    const recipientSk = generateSecretKey();
    const recipientHex = getPublicKey(recipientSk);
    const victimSk = generateSecretKey();
    const victimHex = getPublicKey(victimSk);

    // Derive key as if we're the victim, but sign with attacker's key
    // This creates a mismatch: event.pubkey = attacker, but rumor.pubkey = victim
    // We need to manually construct the event to trigger this
    const { key: symmetricKey } = await getSymmetricKey(attackerSk, recipientHex);
    const fakeRumor = {
      kind: 14,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", recipientHex], ["v", "pc-v2"]],
      content: "impersonation",
      pubkey: victimHex, // victim's pubkey in rumor, but signed by attacker
    } as const;
    const rumorId = getEventHash(fakeRumor as never);
    const rumorWithId = { ...fakeRumor, id: rumorId };
    const encrypted = await encryptV2(JSON.stringify(rumorWithId), symmetricKey);
    const eventTemplate = {
      kind: 1059,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", recipientHex], ["v", "pc-v2"]],
      content: encrypted,
    };
    const event = finalizeEvent(eventTemplate, attackerSk) as unknown as NTNostrEvent;

    await expect(unwrapV2(event, recipientSk)).rejects.toThrow(
      GiftWrapVerificationError,
    );
  });

  test("v2 is ~6× faster than NIP-17 (performance sanity check)", async () => {
    clearSymmetricKeyCache();
    const senderSk = generateSecretKey();
    const recipientSk = generateSecretKey();
    const recipientHex = getPublicKey(recipientSk);
    const plaintext = JSON.stringify({ type: "text", content: "benchmark" });

    // Warm up
    await wrapV2(senderSk, recipientHex, plaintext);
    wrapNip17Message(senderSk, recipientHex, plaintext);

    const iterations = 50;

    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) {
      await wrapV2(senderSk, recipientHex, plaintext);
    }
    const v2Ms = performance.now() - t0;

    const t1 = performance.now();
    for (let i = 0; i < iterations; i++) {
      wrapNip17Message(senderSk, recipientHex, plaintext);
    }
    const nip17Ms = performance.now() - t1;

    const ratio = nip17Ms / v2Ms;
    // v2 should be at least 3× faster (conservative; actual is ~6×+)
    expect(ratio).toBeGreaterThan(3);
  });
});

// ==================== Cross-repo shared test vector ====================
// This vector MUST match between phantombot and phantomchat. The deterministic
// inner half (ECDH → HKDF → AES-256-GCM key) is byte-pinned. The outer
// envelope is non-deterministic (ephemeral signing) so we assert it structurally.
//
// If this test diverges between repos, the protocol has drifted and DMs will
// silently fail to decrypt.

describe("PhantomChat Protocol v2 — cross-repo shared test vector", () => {
  // Fixed keys derived from minimal byte patterns for reproducibility.
  // NEVER use these in production — they're test-only.
  const senderSk = Uint8Array.from(
    Array.from({ length: 32 }, (_, i) => i + 1),
  );
  const recipientSk = Uint8Array.from(
    Array.from({ length: 32 }, (_, i) => i + 2),
  );
  const senderPk = getPublicKey(senderSk);
  const recipientPk = getPublicKey(recipientSk);

  // Deterministic inner half — these bytes MUST match across repos
  const EXPECTED_SYMMETRIC_KEY =
    "20be5fd3f2476eed59a6eeac45331d88e8f5a2204591f3604d57c87b1eada7fc";
  const EXPECTED_RUMOR_ID =
    "1012a22578e51593cad513f022acd569452a8a22a3560e9af260049edcdc4435";
  const PLAINTEXT = "test vector plaintext";
  const FIXED_CREATED_AT = 1700000000;

  test("symmetric key derivation matches cross-repo vector", async () => {
    clearSymmetricKeyCache();
    const { key } = await getSymmetricKey(senderSk, recipientPk);
    // Export the raw key bytes for comparison
    const raw = new Uint8Array(
      await crypto.subtle.exportKey("raw", key),
    );
    expect(Buffer.from(raw).toString("hex")).toBe(EXPECTED_SYMMETRIC_KEY);
  });

  test("rumor id matches cross-repo vector for fixed timestamp", () => {
    const rumor = {
      kind: 14,
      created_at: FIXED_CREATED_AT,
      tags: [["p", recipientPk], ["v", "pc-v2"]],
      content: PLAINTEXT,
      pubkey: senderPk,
    };
    expect(getEventHash(rumor as never)).toBe(EXPECTED_RUMOR_ID);
  });

  test("full wrap/unwrap roundtrip with fixed keys produces correct rumor", async () => {
    clearSymmetricKeyCache();
    // Patch Date.now to get a predictable created_at in the rumor
    const realDateNow = Date.now;
    Date.now = () => FIXED_CREATED_AT * 1000;
    try {
      const { event, rumorId } = await wrapV2(senderSk, recipientPk, PLAINTEXT);

      // Outer envelope: structural checks (non-deterministic due to ephemeral signing)
      expect(event.kind).toBe(1059);
      expect(event.pubkey).not.toBe(senderPk); // ephemeral, not sender
      expect(event.pubkey).not.toBe(recipientPk);
      expect(event.tags.some((t) => t[0] === "p" && t[1] === recipientPk)).toBe(true);
      expect(event.tags.some((t) => t[0] === "v" && t[1] === "pc-v2")).toBe(true);
      // Signature is valid (signed by ephemeral key)
      expect(verifyEvent(event as never)).toBe(true);

      // Inner half: rumorId must match the pinned vector
      expect(rumorId).toBe(EXPECTED_RUMOR_ID);

      // Unwrap recovers the correct rumor
      const rumor = await unwrapV2(event, recipientSk);
      expect(rumor.content).toBe(PLAINTEXT);
      expect(rumor.pubkey).toBe(senderPk);
      expect(rumor.id).toBe(EXPECTED_RUMOR_ID);
      expect(rumor.kind).toBe(14);
      expect(rumor.created_at).toBe(FIXED_CREATED_AT);
    } finally {
      Date.now = realDateNow;
    }
  });

  test("cross-party unwrap: recipient can decrypt what sender encrypted", async () => {
    clearSymmetricKeyCache();
    const realDateNow = Date.now;
    Date.now = () => FIXED_CREATED_AT * 1000;
    try {
      const { event } = await wrapV2(senderSk, recipientPk, PLAINTEXT);
      // Simulate the recipient receiving the event
      const rumor = await unwrapV2(event, recipientSk);
      expect(rumor.content).toBe(PLAINTEXT);
      expect(rumor.pubkey).toBe(senderPk);
    } finally {
      Date.now = realDateNow;
    }
  });

  test("cold-cache unwrap: warm cache for known peer, then unwrap ephemeral-signed event", async () => {
    // Simulates the bot startup flow:
    // 1. Cache is empty (fresh process)
    // 2. Server warms cache for known allowed peers
    // 3. Inbound v2 DM arrives (ephemeral outer key) and can be decrypted
    clearSymmetricKeyCache();

    // Simulate sender producing a v2 event in their own process
    // (their cache warming is irrelevant to us)
    const { event, rumorId } = await wrapV2(senderSk, recipientPk, PLAINTEXT);

    // Clear cache again — simulates the wrap happening in a different process
    clearSymmetricKeyCache();

    // Bot startup: warm cache for known peer (senderPk is in our allow-list)
    await warmSymmetricKeyCache(recipientSk, [senderPk]);

    // Inbound v2 DM arrives — unwrapV2 should find the warmed key
    const rumor = await unwrapV2(event, recipientSk);
    expect(rumor.content).toBe(PLAINTEXT);
    expect(rumor.pubkey).toBe(senderPk);
    expect(rumor.id).toBe(rumorId);
  });
});
