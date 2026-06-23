/**
 * Nostr NIP-17 gift-wrap crypto — the DM-only subset phantomchat needs.
 *
 * ============================================================================
 *  WIRE-COMPATIBILITY: THIS IS A VERBATIM PORT — DO NOT IMPROVISE
 * ============================================================================
 * The PhantomChat PWA and phantombot are SYMMETRIC Nostr clients on the same
 * relays: there is no server. For phantombot to read DMs the PWA sends (and
 * for the PWA to read phantombot's replies) the gift-wrap / seal / rumor
 * pipeline must be byte-for-byte the SAME algorithm on both ends.
 *
 * This file is a faithful port of the PWA's `nostr-crypto.ts`
 * (src/lib/phantomchat/nostr-crypto.ts in the phantomchat repo), trimmed to
 * the DM path only: the group / edit / receipt / file wrappers the PWA also
 * ships are intentionally OMITTED — phantombot only sends and receives plain
 * text DMs. The functions kept here (`wrapNip17Message`, `unwrapNip17Message`,
 * `getConversationKey`, `nip44Encrypt`/`nip44Decrypt`, `createRumor`/
 * `createSeal`/`createGiftWrap`, and the `GiftWrapVerificationError`) are
 * copied unchanged so the two implementations cannot drift.
 *
 * Protocol summary (NIP-17 / NIP-44 v2 / NIP-59):
 *   rumor (kind 14, UNSIGNED)  →  seal (kind 13, signed by sender)
 *                              →  gift-wrap (kind 1059, signed by an EPHEMERAL key)
 * Each layer is NIP-44 v2 encrypted. The gift-wrap's `#p` tag routes it to the
 * recipient; its ephemeral signer hides the sender's identity from relays.
 * `created_at` on the seal and wrap is randomized up to 48h into the PAST for
 * metadata privacy — which is why receivers MUST NOT filter on it.
 * ============================================================================
 */

import * as nip44 from "nostr-tools/nip44";
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  getEventHash,
  verifyEvent,
} from "nostr-tools/pure";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes } from "@noble/hashes/utils.js";

/**
 * nostr-tools event shape used by the nip59/nip17 functions. We keep our own
 * alias rather than importing nostr-tools' `NostrEvent` so the public surface
 * of this module is self-describing (and stable if upstream renames the type).
 */
export type NTNostrEvent = {
  kind: number;
  content: string;
  pubkey: string;
  created_at: number;
  tags: string[][];
  id: string;
  sig: string;
};

export interface UnsignedEvent {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  pubkey: string;
  id: string;
}

export interface SignedEvent extends UnsignedEvent {
  sig: string;
}

/**
 * In-memory conversation-key cache, keyed by sender secret-key OBJECT identity
 * (a WeakMap) → recipient hex → derived NIP-44 conversation key. Keying on the
 * Uint8Array object (not its hex) keeps the private key from being materialized
 * into an immutable, unzeroable JS string. phantombot holds a single long-lived
 * secret key, so this cache mostly amortizes the ECDH per recipient; it is
 * ported verbatim from the PWA (which has the same shape) for parity.
 */
const conversationKeyCache: WeakMap<Uint8Array, Map<string, Uint8Array>> =
  new WeakMap();

/**
 * Get or compute a NIP-44 conversation key for a sender/recipient pair.
 * Cached per-sender by object identity, per-recipient by hex pubkey.
 */
export function getConversationKey(
  senderPriv: Uint8Array,
  recipientPubHex: string,
): Uint8Array {
  let inner = conversationKeyCache.get(senderPriv);
  if (!inner) {
    inner = new Map<string, Uint8Array>();
    conversationKeyCache.set(senderPriv, inner);
  }
  const cached = inner.get(recipientPubHex);
  if (cached) return cached;
  const convKey = nip44.v2.utils.getConversationKey(senderPriv, recipientPubHex);
  inner.set(recipientPubHex, convKey);
  return convKey;
}

/** Encrypt plaintext using NIP-44 v2. */
export function nip44Encrypt(
  plaintext: string,
  conversationKey: Uint8Array,
): string {
  return nip44.v2.encrypt(plaintext, conversationKey);
}

/** Decrypt ciphertext using NIP-44 v2. */
export function nip44Decrypt(
  ciphertext: string,
  conversationKey: Uint8Array,
): string {
  return nip44.v2.decrypt(ciphertext, conversationKey);
}

// ==================== NIP-17 Gift-Wrap API ====================

/**
 * Wrap a text message as NIP-17 gift-wrap events for the recipient AND the
 * sender (self-send for multi-device recovery — the PWA shows the user's own
 * sent messages by reading back its self-wrap). Returns BOTH kind-1059 events
 * and the canonical rumor id; callers publish both wraps to every relay.
 *
 * Uses the manual rumor → seal → gift-wrap pipeline (below) rather than
 * nostr-tools' `wrapManyEvents`, because that helper emits incorrect `#p` tags
 * (random pubkeys instead of the recipient's), which breaks relay routing and
 * therefore delivery — the exact bug the PWA hit and worked around.
 */
export function wrapNip17Message(
  senderSk: Uint8Array,
  recipientPubHex: string,
  content: string,
): { wraps: NTNostrEvent[]; rumorId: string } {
  const senderPubHex = getPublicKey(senderSk);
  const tags: string[][] = [["p", recipientPubHex]];

  // Rumor (kind 14, unsigned). createRumor populates `.id` via getEventHash so
  // the sender and receiver converge on the SAME id after unwrap.
  const rumor = createRumor(content, senderSk, tags);

  // Seal + gift-wrap for the recipient.
  const recipientSeal = createSeal(rumor, senderSk, recipientPubHex);
  const recipientWrap = createGiftWrap(recipientSeal, recipientPubHex);

  // Seal + gift-wrap for self (multi-device recovery).
  const selfSeal = createSeal(rumor, senderSk, senderPubHex);
  const selfWrap = createGiftWrap(selfSeal, senderPubHex);

  return {
    wraps: [recipientWrap, selfWrap] as unknown as NTNostrEvent[],
    rumorId: rumor.id,
  };
}

/**
 * Wrap a text message as NIP-17 gift-wrap events for N group members + self.
 *
 * This is a faithful port of the PWA's `wrapGroupMessage`
 * (src/lib/phantomchat/nostr-crypto.ts) — the group sibling of
 * `wrapNip17Message`, kept byte-compatible so a reply phantombot sends into a
 * group is indistinguishable from one the PWA would send:
 *
 *   - A SINGLE rumor (kind 14) is created with one `['p', <memberHex>]` tag per
 *     member PLUS a trailing `['group', <groupId>]` tag. The PWA's inbound
 *     router (`getGroupIdFromRumor`) keys off exactly this `group` tag to route
 *     the message into the group thread instead of a 1:1 DM — so the tag SHAPE
 *     and ORDER (p-tags first, group tag last) must match.
 *   - That one rumor is sealed + gift-wrapped INDIVIDUALLY for each member, then
 *     once more for the sender (self-send, multi-device recovery) — exactly like
 *     the DM path's recipient + self wraps, generalized to N recipients.
 *
 * `memberPubkeys` is the OTHER members (the sender is added as the self-wrap and
 * must NOT appear in `memberPubkeys`, mirroring the PWA's `otherMembers`).
 *
 * Returns `memberPubkeys.length + 1` kind-1059 wraps and the canonical rumor id.
 */
export function wrapGroupMessage(
  senderSk: Uint8Array,
  memberPubkeys: string[],
  content: string,
  groupId: string,
): { wraps: NTNostrEvent[]; rumorId: string } {
  const senderPubHex = getPublicKey(senderSk);
  const allWraps: NTNostrEvent[] = [];

  // Tags: one p-tag per OTHER member, then the group tag last (matches the PWA's
  // wrapGroupMessage tag order — the group tag is what the PWA routes on).
  const tags: string[][] = memberPubkeys.map((pk) => ["p", pk]);
  tags.push(["group", groupId]);

  // A single rumor shared across all wraps (so every member converges on the
  // same rumor id, just like the DM path).
  const rumor = createRumor(content, senderSk, tags);

  // One seal+gift-wrap per other member.
  for (const memberPk of memberPubkeys) {
    const seal = createSeal(rumor, senderSk, memberPk);
    const wrap = createGiftWrap(seal, memberPk);
    allWraps.push(wrap as unknown as NTNostrEvent);
  }

  // Self-send for multi-device recovery (the bot reads its own sent messages
  // back from this wrap — same role as the DM self-wrap).
  const selfSeal = createSeal(rumor, senderSk, senderPubHex);
  const selfWrap = createGiftWrap(selfSeal, senderPubHex);
  allWraps.push(selfWrap as unknown as NTNostrEvent);

  return { wraps: allWraps, rumorId: rumor.id };
}

/**
 * Error thrown by `unwrapNip17Message` when a verification step fails, so
 * callers can distinguish a hostile/forged event (drop silently) from a
 * transport/parse error (log + move on). The `code` names the failed check.
 */
export class GiftWrapVerificationError extends Error {
  readonly code: "wrap_sig" | "seal_sig" | "pubkey_binding" | "rumor_id";
  constructor(
    code: "wrap_sig" | "seal_sig" | "pubkey_binding" | "rumor_id",
    message: string,
  ) {
    super(message);
    this.name = "GiftWrapVerificationError";
    this.code = code;
  }
}

/**
 * Unwrap a kind-1059 gift-wrap to recover the rumor, VERIFYING at every layer.
 * Each failing check throws `GiftWrapVerificationError`:
 *
 *   (a) verifyEvent(wrap)  — wrap Schnorr signature valid (drops forged events).
 *   (b) NIP-44 decrypt wrap with our key  → seal (kind 13).
 *   (c) verifyEvent(seal)  — seal Schnorr signature valid.
 *   (d) NIP-44 decrypt seal with our key + seal.pubkey  → rumor.
 *   (e) rumor.pubkey === seal.pubkey  — anti-impersonation binding. Without
 *       this a malicious sender could seal a rumor claiming `pubkey = victim`
 *       under their OWN signing key; nostr-tools' nip17/nip59 do NOT enforce
 *       it. This binding is WHY the auth gate can trust `rumor.pubkey`.
 *   (f) getEventHash(rumor) === rumor.id  — the unsigned rumor's id matches its
 *       canonical hash (prevents tampering with the id field).
 *
 * The returned `rumor.pubkey` is the cryptographically-proven sender — the
 * value the phantomchat auth gate allow-lists against.
 */
export function unwrapNip17Message(
  event: NTNostrEvent,
  recipientSk: Uint8Array,
): {
  kind: number;
  content: string;
  pubkey: string;
  created_at: number;
  tags: string[][];
  id: string;
} {
  // (a) Verify wrap signature — drops forged events from hostile relays.
  if (!verifyEvent(event as never)) {
    throw new GiftWrapVerificationError("wrap_sig", "gift-wrap signature invalid");
  }

  // (b) Decrypt wrap → seal.
  const wrapConvKey = getConversationKey(recipientSk, event.pubkey);
  const sealJson = nip44Decrypt(event.content, wrapConvKey);
  const seal = JSON.parse(sealJson) as SignedEvent;

  // (c) Verify seal signature.
  if (!verifyEvent(seal as never)) {
    throw new GiftWrapVerificationError("seal_sig", "seal signature invalid");
  }

  // (d) Decrypt seal → rumor (seal.pubkey is the DH counterpart).
  const sealConvKey = getConversationKey(recipientSk, seal.pubkey);
  const rumorJson = nip44Decrypt(seal.content, sealConvKey);
  const rumor = JSON.parse(rumorJson) as UnsignedEvent;

  // (e) Bind rumor.pubkey to seal.pubkey — anti-impersonation.
  if (rumor.pubkey !== seal.pubkey) {
    throw new GiftWrapVerificationError(
      "pubkey_binding",
      `rumor.pubkey (${rumor.pubkey.slice(0, 8)}...) does not match seal.pubkey (${seal.pubkey.slice(0, 8)}...)`,
    );
  }

  // (f) Verify rumor.id matches its canonical hash (rumors are unsigned).
  const expectedId = getEventHash(rumor as never);
  if (rumor.id !== expectedId) {
    throw new GiftWrapVerificationError(
      "rumor_id",
      "rumor id does not match canonical hash",
    );
  }

  return rumor as {
    kind: number;
    content: string;
    pubkey: string;
    created_at: number;
    tags: string[][];
    id: string;
  };
}

// ==================== PhantomChat Protocol v2 — Symmetric Key ====================

/**
 * In-memory cache of derived AES-256-GCM symmetric keys, keyed by the sorted
 * pair of hex public keys (ECDH is commutative: ECDH(skA, pkB) == ECDH(skB, pkA)).
 *
 * Populated lazily on first encrypt/decrypt per peer, wiped on logout.
 */
const symmetricKeyCache: Map<string, CryptoKey> = new Map();

/**
 * Derive or retrieve a cached AES-256-GCM symmetric key for a peer.
 *
 * One ECDH between `localSk` and `peerPubHex`, then HKDF-SHA256 with
 * info="pc-v2" → 32-byte key. Both sides derive the same key independently.
 *
 * @returns `{ raw: Uint8Array; key: CryptoKey }` — raw unused in hot path
 */
export async function getSymmetricKey(
  localSk: Uint8Array,
  peerPubHex: string,
): Promise<{ raw: Uint8Array; key: CryptoKey }> {
  const localPubHex = getPublicKey(localSk);
  const cacheKey =
    localPubHex < peerPubHex
      ? `${localPubHex}:${peerPubHex}`
      : `${peerPubHex}:${localPubHex}`;

  const cachedKey = symmetricKeyCache.get(cacheKey);
  if (cachedKey) return { raw: new Uint8Array(0), key: cachedKey };

  // ECDH: shared secret from (localSk, peerPub). noble/curves expects
  // compressed pubkey (33 bytes with 02/03 prefix). Nostr x-only keys
  // always use even y → prefix 0x02.
  const peerPubBytes = new Uint8Array([0x02, ...hexToBytes(peerPubHex)]);
  const sharedSecret = secp256k1.getSharedSecret(localSk, peerPubBytes);

  // HKDF-SHA256 → 32-byte symmetric key
  const info = new TextEncoder().encode("pc-v2");
  const rawKey = hkdf(sha256, sharedSecret, undefined, info, 32);

  // Copy to ArrayBuffer-backed Uint8Array for crypto.subtle compatibility
  const rawKeyBuf = new Uint8Array([...rawKey]);
  const key = await crypto.subtle.importKey(
    "raw",
    rawKeyBuf,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );

  symmetricKeyCache.set(cacheKey, key);
  return { raw: rawKey, key };
}

/**
 * Clear the symmetric key cache (call on logout/identity change).
 */
export function clearSymmetricKeyCache(): void {
  symmetricKeyCache.clear();
}

/**
 * PhantomChat v2: encrypt plaintext with AES-256-GCM.
 * IV (12 bytes) prepended to ciphertext, all base64url-encoded.
 */
export async function encryptV2(
  plaintext: string,
  symmetricKey: CryptoKey,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const cipherBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    symmetricKey,
    encoded,
  );
  const result = new Uint8Array(iv.length + new Uint8Array(cipherBuf).length);
  result.set(iv, 0);
  result.set(new Uint8Array(cipherBuf), iv.length);
  return base64urlEncode(result);
}

/**
 * PhantomChat v2: decrypt ciphertext with AES-256-GCM.
 * Expects base64url-encoded data with 12-byte IV prepended.
 */
export async function decryptV2(
  ciphertext: string,
  symmetricKey: CryptoKey,
): Promise<string> {
  const data = base64urlDecode(ciphertext);
  const iv = data.slice(0, 12);
  const encrypted = data.slice(12);
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    symmetricKey,
    encrypted,
  );
  return new TextDecoder().decode(plainBuf);
}

/**
 * PhantomChat v2: wrap a message. Creates a kind-14 rumor, encrypts with
 * AES-256-GCM, publishes as a signed kind-1059 event with ['v', 'pc-v2'] tag.
 *
 * Per-message cost: 1× AES-GCM + 1× Schnorr sign ≈ 1ms (vs NIP-17 ≈ 12ms).
 *
 * @param replyTo Optional reply reference {eventId, relayUrl?}
 */
export async function wrapV2(
  senderSk: Uint8Array,
  recipientPubHex: string,
  content: string,
  replyTo?: { eventId: string; relayUrl?: string },
): Promise<{ event: NTNostrEvent; rumorId: string }> {
  const senderPubHex = getPublicKey(senderSk);
  const tags: string[][] = [["p", recipientPubHex], ["v", "pc-v2"]];
  if (replyTo) {
    tags.push(["e", replyTo.eventId, replyTo.relayUrl || "", "reply"]);
  }

  // Rumor (kind 14, unsigned) — same structure as NIP-17 rumor
  const rumor = {
    kind: 14,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content,
    pubkey: senderPubHex,
  };
  const rumorId = getEventHash(rumor as never);
  // Assign id after hashing — rumor type needs it for the signed event
  const rumorWithId = { ...rumor, id: rumorId };

  // Derive shared symmetric key (cached after first call per peer)
  const { key: symmetricKey } = await getSymmetricKey(senderSk, recipientPubHex);

  // Encrypt rumor JSON with AES-256-GCM
  const encryptedContent = await encryptV2(JSON.stringify(rumorWithId), symmetricKey);

  // Sign as kind-1059 with sender's real key (no ephemeral key)
  const eventTemplate = {
    kind: 1059,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: encryptedContent,
  };
  const event = finalizeEvent(eventTemplate, senderSk) as unknown as NTNostrEvent;

  return { event, rumorId };
}

/**
 * PhantomChat v2: unwrap a message. Verifies the kind-1059 signature, derives
 * the shared symmetric key, and decrypts the content to recover the rumor.
 *
 * @throws {GiftWrapVerificationError} on invalid signature or impersonation
 */
export async function unwrapV2(
  event: NTNostrEvent,
  recipientSk: Uint8Array,
): Promise<{
  kind: number;
  content: string;
  pubkey: string;
  created_at: number;
  tags: string[][];
  id: string;
}> {
  if (!verifyEvent(event as never)) {
    throw new GiftWrapVerificationError("wrap_sig", "v2 event signature invalid");
  }

  // Determine counterparty for key derivation
  const myPubkey = getPublicKey(recipientSk);
  let counterpartyPubHex: string;
  if (event.pubkey === myPubkey) {
    // We're the sender (self-send) — use the p tag recipient
    const pTag = event.tags?.find((t) => t[0] === "p");
    if (!pTag) {
      throw new GiftWrapVerificationError(
        "pubkey_binding",
        "v2 self-send event missing p tag",
      );
    }
    counterpartyPubHex = pTag[1]!;
  } else {
    counterpartyPubHex = event.pubkey;
  }
  const { key: symmetricKey } = await getSymmetricKey(recipientSk, counterpartyPubHex);

  const rumorJson = await decryptV2(event.content, symmetricKey);
  const rumor = JSON.parse(rumorJson) as UnsignedEvent;

  // Anti-impersonation: rumor.pubkey must match event.pubkey
  if (rumor.pubkey !== event.pubkey) {
    throw new GiftWrapVerificationError(
      "pubkey_binding",
      `v2 rumor.pubkey (${rumor.pubkey?.slice(0, 8)}...) does not match event.pubkey (${event.pubkey?.slice(0, 8)}...)`,
    );
  }

  return rumor as {
    kind: number;
    content: string;
    pubkey: string;
    created_at: number;
    tags: string[][];
    id: string;
  };
}

/**
 * Check whether a Nostr event is a PhantomChat v2 message (has ['v', 'pc-v2'] tag).
 */
export function isV2Event(event: NTNostrEvent): boolean {
  return (
    event.tags?.some((t) => t[0] === "v" && t[1] === "pc-v2") ?? false
  );
}

// ==================== Low-level pipeline ====================

/**
 * Create an unsigned rumor event (NIP-17 kind 14). The rumor is NOT signed —
 * it has an `id` (its canonical hash) but no `sig`. The id is what receiver
 * and sender converge on after unwrap.
 */
export function createRumor(
  content: string,
  senderSk: Uint8Array,
  tags?: string[][],
): UnsignedEvent {
  const pubkey = getPublicKey(senderSk);
  const event = {
    kind: 14,
    created_at: Math.floor(Date.now() / 1000),
    tags: tags || [],
    content,
    pubkey,
  };
  const id = getEventHash(event);
  return { ...event, id };
}

/**
 * Create a sealed event (NIP-17 kind 13): the rumor JSON, NIP-44-encrypted to
 * the recipient and signed by the SENDER's key. `created_at` is the REAL send
 * time — no backdating. The seal is encrypted inside the gift-wrap so its
 * timestamp is never observable anyway, and truthful timestamps are what let
 * the PWA poll with a tight `since` to recover any reply the relay dropped from
 * its live push. (Mirror of the PWA-side change in phantomchat nostr-crypto.ts.)
 */
export function createSeal(
  rumor: UnsignedEvent,
  senderSk: Uint8Array,
  recipientPk: string,
): SignedEvent {
  const convKey = getConversationKey(senderSk, recipientPk);
  const encryptedContent = nip44Encrypt(JSON.stringify(rumor), convKey);

  const created_at = Math.floor(Date.now() / 1000);

  const sealTemplate = {
    kind: 13,
    created_at,
    tags: [] as string[][],
    content: encryptedContent,
  };

  return finalizeEvent(sealTemplate, senderSk) as unknown as SignedEvent;
}

/**
 * Create a gift-wrapped event (NIP-17 kind 1059): the seal JSON, NIP-44-
 * encrypted to the recipient and signed by a fresh EPHEMERAL key (so relays
 * can't link the wrap to the real sender). `#p` tags the recipient for relay
 * routing; `created_at` is the REAL send time — no backdating, so the PWA's
 * tight-`since` catch-up poll can recover a reply the relay failed to push.
 */
export function createGiftWrap(
  seal: SignedEvent,
  recipientPk: string,
): SignedEvent {
  const ephemeralSk = generateSecretKey();
  const convKey = getConversationKey(ephemeralSk, recipientPk);
  const encryptedContent = nip44Encrypt(JSON.stringify(seal), convKey);

  const created_at = Math.floor(Date.now() / 1000);

  const wrapTemplate = {
    kind: 1059,
    created_at,
    tags: [["p", recipientPk]],
    content: encryptedContent,
  };

  return finalizeEvent(wrapTemplate, ephemeralSk) as unknown as SignedEvent;
}

// ==================== Base64url helpers (NIP-44 compatible) ====================

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str: string): Uint8Array {
  let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
