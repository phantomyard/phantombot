/**
 * P2P signaling over Nostr (phantomyard/phantombot#258).
 *
 * A WebRTC connection cannot bootstrap itself: two nodes behind NAT must first
 * swap an SDP offer/answer and a handful of ICE candidates. Something has to
 * carry those small blobs. We already depend on Nostr relays, so they carry the
 * signaling too — demoted from "every message" to just the WebRTC handshake.
 *
 * Design choices:
 *
 *  - **Dedicated ephemeral kind (`NOSTR_KIND_P2P_SIGNAL`).** Signaling does NOT
 *    reuse the chat gift-wrap kind (1059). If it did, the persona's chat
 *    subscription (`kind:1059, #p:<us>`) would pick up signaling events and try
 *    to unwrap them as chat messages. A distinct kind in the ephemeral range
 *    (20000–29999, per NIP-01 relays don't persist these) keeps the two planes
 *    cleanly separate and means stale offers aren't stored on relays forever.
 *
 *  - **NIP-44 encryption, REAL-key authorship.** Unlike chat (which signs with a
 *    throwaway ephemeral key to hide the social graph), signaling is signed with
 *    the node's real key so the recipient can derive the shared NIP-44
 *    conversation key from `event.pubkey`. The two nodes already know each
 *    other's pubkeys (that's how the PWA routed here), so there is no graph to
 *    hide at this layer — and the SDP/ICE payload stays end-to-end encrypted.
 *
 * The module exposes pure encode/decode helpers (fully unit-testable) and a
 * `NostrSignaling` class that rides the same `RelayPool` seam the chat transport
 * uses, so tests inject an in-memory fake pool with zero sockets.
 */

import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

import { log } from "../lib/logger.ts";
import {
  getConversationKey,
  nip44Encrypt,
  nip44Decrypt,
  type NTNostrEvent,
} from "../lib/nostrCrypto.ts";
import type { NostrFilter, RelayPool } from "../channels/phantomchat/transport.ts";

/**
 * Ephemeral Nostr kind for P2P WebRTC signaling. In the 20000–29999 ephemeral
 * range so relays don't persist it. Distinct from chat gift-wraps (1059) and the
 * PhantomChat typing indicator (20001).
 */
export const NOSTR_KIND_P2P_SIGNAL = 21050;

/**
 * How far back the signaling subscription looks on (re)connect. Ephemeral events
 * generally aren't replayed, but a small window tolerates relays that briefly
 * buffer. Signaling is retried by the connection layer, so this is only a hint.
 */
export const SIGNAL_SINCE_WINDOW_SEC = 30;

/** An SDP offer or answer. */
export interface SdpSignal {
  t: "offer" | "answer";
  sdp: string;
}

/** A single trickled ICE candidate. */
export interface CandidateSignal {
  t: "candidate";
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

/** Signals a peer has given up on this handshake so we can tear the half-open PC down. */
export interface ByeSignal {
  t: "bye";
}

/**
 * A nudge from the deterministic-RESPONDER side to the INITIATOR side. To avoid
 * offer glare, only the peer with the smaller pubkey ever offers. When the
 * larger-pubkey node has traffic for a peer it can't offer itself, so it sends a
 * `hello`; the initiator answers by starting its offer.
 */
export interface HelloSignal {
  t: "hello";
}

export type SignalMessage = SdpSignal | CandidateSignal | ByeSignal | HelloSignal;

/** Structural guard for a decoded signal payload. */
export function isSignalMessage(value: unknown): value is SignalMessage {
  if (!value || typeof value !== "object") return false;
  const t = (value as { t?: unknown }).t;
  if (t === "offer" || t === "answer") return typeof (value as SdpSignal).sdp === "string";
  if (t === "candidate") return typeof (value as CandidateSignal).candidate === "string";
  if (t === "bye" || t === "hello") return true;
  return false;
}

/**
 * Encrypt + sign a signal for `recipientHex`. Returns a ready-to-publish
 * ephemeral Nostr event. Pure aside from the ephemeral `created_at`.
 */
export function encodeSignal(
  senderSk: Uint8Array,
  recipientHex: string,
  msg: SignalMessage,
): NTNostrEvent {
  const convKey = getConversationKey(senderSk, recipientHex);
  const content = nip44Encrypt(JSON.stringify(msg), convKey);
  const template = {
    kind: NOSTR_KIND_P2P_SIGNAL,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["p", recipientHex]],
    content,
  };
  return finalizeEvent(template, senderSk) as unknown as NTNostrEvent;
}

/**
 * Decrypt an inbound signaling event. Derives the NIP-44 conversation key from
 * the event's (real) author pubkey and our secret key. Returns the sender's
 * pubkey and the decoded message, or `null` if the event isn't a valid signal
 * addressed to us (bad decrypt, wrong shape). Never throws.
 */
export function decodeSignal(
  recipientSk: Uint8Array,
  event: NTNostrEvent,
): { senderHex: string; msg: SignalMessage } | null {
  try {
    if (event.kind !== NOSTR_KIND_P2P_SIGNAL) return null;
    const senderHex = event.pubkey;
    const convKey = getConversationKey(recipientSk, senderHex);
    const plaintext = nip44Decrypt(event.content, convKey);
    const msg = JSON.parse(plaintext) as unknown;
    if (!isSignalMessage(msg)) return null;
    return { senderHex, msg };
  } catch {
    return null;
  }
}

/** Callback for a decoded inbound signal. */
export type SignalHandler = (senderHex: string, msg: SignalMessage) => void;

/**
 * The signaling seam the connection layer depends on. A real implementation
 * rides Nostr relays; tests inject a fake that loops messages in-memory.
 */
export interface Signaling {
  /** Publish a signal to a peer. Best-effort; resolves once handed to relays. */
  send(recipientHex: string, msg: SignalMessage): Promise<void>;
  /** Register the inbound handler. Only one handler is supported. */
  onMessage(handler: SignalHandler): void;
  /** Begin subscribing for inbound signals addressed to us. */
  start(): void;
  /** Tear the subscription down. */
  stop(): void;
}

/** Nostr-relay-backed signaling over the shared `RelayPool` seam. */
export class NostrSignaling implements Signaling {
  private readonly ourSk: Uint8Array;
  private readonly ourPubHex: string;
  private readonly relays: string[];
  private readonly pool: RelayPool;
  private handler: SignalHandler | null = null;
  private sub: { close(): void } | null = null;
  /** Dedup inbound events by id — relays can deliver the same event twice. */
  private readonly seen = new Set<string>();

  constructor(ourSk: Uint8Array, relays: string[], pool: RelayPool) {
    this.ourSk = ourSk;
    this.ourPubHex = getPublicKey(ourSk);
    this.relays = relays;
    this.pool = pool;
  }

  onMessage(handler: SignalHandler): void {
    this.handler = handler;
  }

  start(): void {
    if (this.sub) return;
    const filter: NostrFilter = {
      kinds: [NOSTR_KIND_P2P_SIGNAL],
      "#p": [this.ourPubHex],
      since: Math.floor(Date.now() / 1000) - SIGNAL_SINCE_WINDOW_SEC,
    };
    this.sub = this.pool.subscribeMany(this.relays, filter, {
      onevent: (event) => this.ingest(event),
    });
  }

  stop(): void {
    if (this.sub) {
      try {
        this.sub.close();
      } catch (err) {
        log.debug(`[p2p] signaling sub close failed: ${String(err)}`);
      }
      this.sub = null;
    }
    this.seen.clear();
  }

  private ingest(event: NTNostrEvent): void {
    if (!event || typeof event.id !== "string") return;
    if (this.seen.has(event.id)) return;
    this.seen.add(event.id);
    // Bound the dedup set so a long-lived node doesn't leak memory.
    if (this.seen.size > 4096) {
      this.seen.clear();
      this.seen.add(event.id);
    }
    const decoded = decodeSignal(this.ourSk, event);
    if (!decoded) return;
    this.handler?.(decoded.senderHex, decoded.msg);
  }

  async send(recipientHex: string, msg: SignalMessage): Promise<void> {
    const event = encodeSignal(this.ourSk, recipientHex, msg);
    const results = await Promise.allSettled(this.pool.publish(this.relays, event));
    const ok = results.some((r) => r.status === "fulfilled");
    if (!ok) {
      log.debug(`[p2p] signaling publish reached no relay for ${recipientHex.slice(0, 8)}`);
    }
  }
}
