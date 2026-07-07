/**
 * P2P capability advertisement (phantomyard/phantombot#258, phantomchat#61).
 *
 * The PWA's transport ladder is GATED: it only tries a direct transport toward a
 * peer that has ADVERTISED it can accept one (see phantomchat
 * `transport/capability.ts` — `PeerCapabilityRegistry`). Until a peer advertises,
 * every send falls straight through to the relay with no probe and no added
 * latency. This module is how a phantombot node fills that registry.
 *
 * A node publishes an addressable app-data event (NIP-78 kind 30078, `d` tag
 * `phantomchat-p2p`) under the persona's pubkey. It is replaceable, so
 * re-publishing on each start supersedes the previous one, and its content is
 * PLAINTEXT on purpose:
 *
 *   { "webrtc": true }
 *
 * SCOPE (issue #61 rewrite). There is exactly ONE direct transport: WebRTC
 * (NAT-traversed via ICE, signaled over Nostr). The former `localWs` /
 * `localWsPort` (same-machine `ws://localhost`) and `dht` (Hyperswarm) fields
 * were removed from the advert:
 *   - The localhost tier only helped when a PWA and this node shared one machine
 *     — a vanishingly rare case for real conversations — and all the port
 *     plumbing it needed (ephemeral bind + advertise + dial) bought a sub-ms win
 *     only there.
 *   - `dht` was always false (this build is werift WebRTC + Nostr signaling, not
 *     Hyperswarm), and the browser never had a DHT tier to consume it.
 *   - LAN IPs never belonged here either: a browser PWA cannot dial a bare LAN IP
 *     over `ws://`; the node↔node WebRTC path discovers LAN host candidates live
 *     via ICE at connection time.
 * WHY PLAINTEXT: the `webrtc` boolean must be public — a contact reads whether we
 * accept a direct transport BEFORE any encrypted channel exists, and they don't
 * hold our key. Nothing here is a secret.
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
 * What a node advertises — PLAINTEXT. Mirrors the PWA's `PeerCapabilities` shape
 * verbatim (phantomchat `transport/capability.ts`) so ingestion is a direct
 * assignment. Post-#61 this is a single `webrtc` boolean.
 */
export interface NodeCapabilities {
  /** The node can hold a WebRTC data channel (LAN host candidates, STUN, TURN). */
  webrtc: boolean;
}

/**
 * Build the capability descriptor a running node advertises. A phantombot node
 * that has the P2P subsystem enabled can hold a WebRTC data channel, so it
 * advertises `webrtc: true`.
 */
export function nodeCapabilities(): NodeCapabilities {
  return { webrtc: true };
}

/**
 * Build (and sign) the replaceable capability event for this node.
 *
 * @param ourSk persona secret key (signs the event)
 */
export function buildCapabilityEvent(ourSk: Uint8Array): NTNostrEvent {
  const template = {
    kind: CAPABILITY_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["d", CAPABILITY_D_TAG]],
    content: JSON.stringify(nodeCapabilities()),
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
    // Read only `webrtc`. Legacy adverts may still carry localWs/localWsPort/dht
    // from the retired tiers; they are ignored.
    return {
      authorHex: event.pubkey,
      caps: {
        webrtc: Boolean(parsed.webrtc),
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
