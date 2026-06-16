/**
 * Nostr identity helpers for the phantomchat channel.
 *
 * Each PERSONA owns its own long-lived Nostr keypair (its identity on the
 * PhantomChat network), stored as an `nsec` in that persona's
 * `phantomchat.json` (see channels/phantomchat/personaStore.ts). Unlike the PWA
 * — which derives its key from a BIP-39 mnemonic the human writes down —
 * phantombot generates a RAW 32-byte secret key; the nsec round-trips it
 * losslessly for backup, so the mnemonic layer the PWA uses is omitted here.
 *
 * Encoding conventions (NIP-19):
 *   - npub… : bech32 public key. This is what Andrew copies into the PWA to
 *             start a DM with phantombot, and what goes in `allowed_npubs`.
 *   - nsec… : bech32 secret key. The persisted form of the bot's private key.
 *   - hex   : the 64-char form used on the WIRE (rumor `from`/`to`, `#p` tags,
 *             the auth allowlist after decode). Everything internal is hex.
 */

import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import {
  npubEncode as nip19NpubEncode,
  nsecEncode as nip19NsecEncode,
  decode as nip19Decode,
} from "nostr-tools/nip19";
import { hexToBytes } from "nostr-tools/utils";

/** A resolved phantomchat identity: the secret key bytes plus its encodings. */
export interface NostrIdentity {
  /** 32-byte secret key. Keep out of logs. */
  secretKey: Uint8Array;
  /** 64-char hex public key — the wire/auth form. */
  publicKeyHex: string;
  /** bech32 npub — the shareable address Andrew pastes into the PWA. */
  npub: string;
  /** bech32 nsec — the persisted secret form (stored in ~/.env). */
  nsec: string;
}

/**
 * Generate a fresh phantomchat identity from a random 32-byte secret key.
 * No mnemonic — see the module header for why.
 */
export function generateIdentity(): NostrIdentity {
  const secretKey = generateSecretKey();
  return identityFromSecretKey(secretKey);
}

/** Build the full identity (hex pubkey + npub + nsec) from raw secret bytes. */
export function identityFromSecretKey(secretKey: Uint8Array): NostrIdentity {
  const publicKeyHex = getPublicKey(secretKey);
  return {
    secretKey,
    publicKeyHex,
    npub: nip19NpubEncode(publicKeyHex),
    nsec: nip19NsecEncode(secretKey),
  };
}

/**
 * Decode an `nsec…` (or bare 64-char hex) secret key into a full identity.
 * Throws on anything that isn't a valid nsec or hex private key.
 */
export function identityFromNsec(nsecOrHex: string): NostrIdentity {
  const trimmed = nsecOrHex.trim();
  if (trimmed.startsWith("nsec1")) {
    const decoded = nip19Decode(trimmed);
    if (decoded.type !== "nsec") {
      throw new Error("expected an nsec-encoded secret key");
    }
    return identityFromSecretKey(decoded.data as Uint8Array);
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return identityFromSecretKey(hexToBytes(trimmed));
  }
  throw new Error("not a valid nsec or 64-char hex secret key");
}

/** Encode a hex public key as `npub…`. */
export function npubEncode(publicKeyHex: string): string {
  return nip19NpubEncode(publicKeyHex);
}

/** Encode a secret key (bytes) as `nsec…`. */
export function nsecEncode(secretKey: Uint8Array): string {
  return nip19NsecEncode(secretKey);
}

/**
 * Decode an `npub…` (or bare 64-char hex) public key to its 64-char hex form —
 * the form used on the wire and in the auth allowlist. Throws on anything else.
 */
export function decodeNpubToHex(npubOrHex: string): string {
  const trimmed = npubOrHex.trim();
  if (trimmed.startsWith("npub1")) {
    const decoded = nip19Decode(trimmed);
    if (decoded.type !== "npub") {
      throw new Error("expected an npub-encoded public key");
    }
    return decoded.data as string;
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  throw new Error("not a valid npub or 64-char hex public key");
}

/**
 * Decode a list of npub (or hex) strings to lowercase hex pubkeys, skipping
 * anything that doesn't parse. Used to turn the configured `allowed_npubs`
 * list into the hex set the auth gate compares `rumor.pubkey` against.
 */
export function decodeAllowedNpubs(npubs: string[]): string[] {
  const out: string[] = [];
  for (const n of npubs) {
    try {
      out.push(decodeNpubToHex(n).toLowerCase());
    } catch {
      // Skip malformed entries — a typo in one npub shouldn't disable the gate.
    }
  }
  return out;
}
