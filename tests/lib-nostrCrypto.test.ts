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
} from "nostr-tools/pure";

import {
  GiftWrapVerificationError,
  createGiftWrap,
  createRumor,
  getConversationKey,
  nip44Encrypt,
  unwrapNip17Message,
  wrapNip17Message,
  type NTNostrEvent,
  type SignedEvent,
  type UnsignedEvent,
} from "../src/lib/nostrCrypto.ts";

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
