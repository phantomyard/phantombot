/**
 * P2P capability advertisement (phantomyard/phantombot#258, phantomchat#61).
 *
 * The PWA's transport ladder is GATED: it only tries a direct transport toward a
 * peer that has ADVERTISED it can accept one (see phantomchat
 * `transport/capability.ts` — `PeerCapabilityRegistry`). Until a peer advertises,
 * every send falls straight through to the relay with no probe and no added
 * latency. That registry is empty for every PWA user today; this module is how a
 * phantombot node fills it.
 *
 * A node publishes an addressable app-data event (NIP-78 kind 30078, `d` tag
 * `phantomchat-p2p`) under the persona's pubkey. It is replaceable, so
 * re-publishing on each start just supersedes the previous one, and it is public
 * (unencrypted) on purpose — capability is not a secret, and the PWA needs to
 * read a contact's capability before any encrypted channel exists.
 *
 * PROPOSED CROSS-REPO CONTRACT. The matching PWA-side ingestion (subscribe by
 * contact pubkey, parse this event, call `PeerCapabilityRegistry.set`) lands in
 * a phantomchat companion PR. Until it ships this advertisement is inert: it's a
 * public event nothing reads yet, so publishing it changes no behaviour. The
 * shape here is the contract that companion implements.
 */

import { finalizeEvent } from "nostr-tools/pure";

import { log } from "../lib/logger.ts";
import type { NTNostrEvent } from "../lib/nostrCrypto.ts";
import type { RelayPool } from "../channels/phantomchat/transport.ts";

/** NIP-78 addressable app-data kind used for the capability advertisement. */
export const CAPABILITY_KIND = 30078;

/** The `d` tag that namespaces our capability event within kind 30078. */
export const CAPABILITY_D_TAG = "phantomchat-p2p";

/**
 * What a node advertises. Mirrors the PWA's `PeerCapabilities` shape verbatim
 * (phantomchat `transport/capability.ts`) so ingestion is a direct assignment.
 */
export interface NodeCapabilities {
  /** The node can accept a same-machine `ws://localhost` bridge connection. */
  localWs: boolean;
  /** TCP port the node's ws bridge listens on. */
  localWsPort: number;
  /** The node can hold a WebRTC data channel (LAN host candidates or remote). */
  webrtc: boolean;
  /**
   * The node runs a raw-UDP DHT. Always false: this build uses werift WebRTC +
   * Nostr signaling, not Hyperswarm (which panics under Bun). Kept in the shape
   * so the field is explicit rather than absent.
   */
  dht: boolean;
}

/** Build the capability descriptor a running node advertises. */
export function nodeCapabilities(port: number): NodeCapabilities {
  return { localWs: true, localWsPort: port, webrtc: true, dht: false };
}

/** Build (and sign) the replaceable capability event for this node. */
export function buildCapabilityEvent(
  ourSk: Uint8Array,
  caps: NodeCapabilities,
): NTNostrEvent {
  const template = {
    kind: CAPABILITY_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["d", CAPABILITY_D_TAG]],
    content: JSON.stringify(caps),
  };
  return finalizeEvent(template, ourSk) as unknown as NTNostrEvent;
}

/**
 * Parse a capability event back to `{ authorHex, caps }`, or `null` when it is
 * not a well-formed capability advertisement. This is the reference the PWA
 * companion mirrors on ingest. Never throws.
 */
export function parseCapabilityEvent(
  event: NTNostrEvent,
): { authorHex: string; caps: NodeCapabilities } | null {
  try {
    if (event.kind !== CAPABILITY_KIND) return null;
    const hasDTag = event.tags.some((t) => t[0] === "d" && t[1] === CAPABILITY_D_TAG);
    if (!hasDTag) return null;
    const parsed = JSON.parse(event.content) as Partial<NodeCapabilities>;
    if (typeof parsed !== "object" || parsed === null) return null;
    return {
      authorHex: event.pubkey,
      caps: {
        localWs: Boolean(parsed.localWs),
        localWsPort: typeof parsed.localWsPort === "number" ? parsed.localWsPort : 0,
        webrtc: Boolean(parsed.webrtc),
        dht: Boolean(parsed.dht),
      },
    };
  } catch {
    return null;
  }
}

/**
 * Publish this node's capability advertisement. Best-effort: resolves once the
 * event has been handed to the relays (success if any relay accepts). A failure
 * to reach relays is non-fatal — the advertisement is inert until a PWA reads it.
 */
export async function publishCapability(
  pool: RelayPool,
  relays: string[],
  event: NTNostrEvent,
): Promise<void> {
  const results = await Promise.allSettled(pool.publish(relays, event));
  const ok = results.some((r) => r.status === "fulfilled");
  if (!ok) {
    log.debug("[p2p] capability advertisement reached no relay");
  }
}
