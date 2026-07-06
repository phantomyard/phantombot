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
 * re-publishing on each start supersedes the previous one.
 *
 * TWO-PART CONTENT — public booleans + a self-encrypted reachability blob:
 *
 *   {
 *     "localWs": true, "webrtc": true, "dht": false,   // PUBLIC — any contact reads
 *     "enc": "<NIP-44 self-encrypted { localWsPort, lanIps }>"  // OWNER-ONLY
 *   }
 *
 * The capability BOOLEANS must stay public: a contact has to read whether we can
 * accept a direct transport BEFORE any encrypted channel exists, and they don't
 * hold our key. But the concrete REACHABILITY — which loopback port our bridge
 * bound (now OS-ephemeral, not a fixed 47100) and our LAN IPs — is nobody's
 * business but our own. Only the persona's own PWA, holding the same nsec, can
 * decrypt the `enc` blob (NIP-44 conversation key from our key to our own
 * pubkey). So the port/IP never touch a relay in the clear, while the gate still
 * works. The PWA discovers its LOCAL node's port by reading its OWN self-advert.
 */

import { networkInterfaces } from "node:os";

import { finalizeEvent } from "nostr-tools/pure";

import { log } from "../lib/logger.ts";
import {
  getConversationKey,
  nip44Decrypt,
  nip44Encrypt,
  type NTNostrEvent,
} from "../lib/nostrCrypto.ts";
import type { RelayPool } from "../channels/phantomchat/transport.ts";

/** NIP-78 addressable app-data kind used for the capability advertisement. */
export const CAPABILITY_KIND = 30078;

/** The `d` tag that namespaces our capability event within kind 30078. */
export const CAPABILITY_D_TAG = "phantomchat-p2p";

/**
 * The PUBLIC capability booleans — plaintext, readable by any contact. Mirrors
 * the boolean half of the PWA's `PeerCapabilities` shape.
 */
export interface NodeCapabilities {
  /** The node can accept a same-machine `ws://localhost` bridge connection. */
  localWs: boolean;
  /** The node can hold a WebRTC data channel (LAN host candidates or remote). */
  webrtc: boolean;
  /**
   * The node runs a raw-UDP DHT. Always false: this build uses werift WebRTC +
   * Nostr signaling, not Hyperswarm (which panics under Bun).
   */
  dht: boolean;
}

/**
 * OWNER-PRIVATE reachability — carried self-encrypted in the `enc` field, so
 * only the persona's own nsec can read it. Never leaves a relay in the clear.
 */
export interface NodeReachability {
  /**
   * The loopback TCP port the ws bridge is ACTUALLY listening on. With
   * OS-ephemeral binding (`port: 0`) this is the real bound port, discovered at
   * runtime — the PWA reads it here rather than assuming a fixed 47100.
   */
  localWsPort: number;
  /**
   * Non-internal IPv4 LAN addresses of this host. Informational: a browser PWA
   * cannot dial a bare LAN IP over `ws://` (mixed-content + no TLS), so the LAN
   * hop is served by ICE host candidates on the node↔node WebRTC path, not by
   * the browser. Advertised so a peer knows "everything about" us for future use.
   */
  lanIps: string[];
}

/** Build the PUBLIC capability booleans a running node advertises. */
export function nodeCapabilities(): NodeCapabilities {
  return { localWs: true, webrtc: true, dht: false };
}

/**
 * Enumerate this host's non-internal IPv4 addresses (its LAN IPs). Never throws;
 * returns `[]` if enumeration fails. `family` is compared against both the
 * string `"IPv4"` (Node/Bun) and the numeric `4` some runtimes report.
 */
export function localLanIps(): string[] {
  try {
    const out: string[] = [];
    for (const addrs of Object.values(networkInterfaces())) {
      if (!addrs) continue;
      for (const a of addrs) {
        const isV4 = a.family === "IPv4" || (a.family as unknown) === 4;
        if (isV4 && !a.internal && a.address) out.push(a.address);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Build (and sign) the replaceable capability event for this node.
 *
 * @param ourSk       persona secret key (signs the event + derives the self key)
 * @param ourPubHex   persona pubkey (hex) — the self-encryption recipient
 * @param boundPort   the ACTUAL bound loopback port (e.g. `bridge.boundPort`)
 * @param reachability override the reachability blob (LAN IPs default to
 *                      `localLanIps()`); primarily a test seam.
 */
export function buildCapabilityEvent(
  ourSk: Uint8Array,
  ourPubHex: string,
  boundPort: number,
  reachability?: Partial<NodeReachability>,
): NTNostrEvent {
  const reach: NodeReachability = {
    localWsPort: boundPort,
    lanIps: reachability?.lanIps ?? localLanIps(),
    ...reachability,
  };
  const selfKey = getConversationKey(ourSk, ourPubHex);
  const enc = nip44Encrypt(JSON.stringify(reach), selfKey);
  const content = JSON.stringify({ ...nodeCapabilities(), enc });
  const template = {
    kind: CAPABILITY_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["d", CAPABILITY_D_TAG]],
    content,
  };
  return finalizeEvent(template, ourSk) as unknown as NTNostrEvent;
}

/**
 * Parse a capability event back to its public caps (and, when `ourSk` is given
 * and this is our OWN advert, the decrypted reachability). Returns `null` when
 * the event is not a well-formed capability advertisement. Never throws.
 *
 * `reachability` is only populated for a SELF advert — decryption uses the self
 * conversation key `(ourSk → event.pubkey)`, which succeeds only when
 * `event.pubkey` is our own pubkey. A contact's advert yields `caps` with no
 * `reachability`, which is correct: a contact's port/IP are none of our business.
 */
export function parseCapabilityEvent(
  event: NTNostrEvent,
  ourSk?: Uint8Array,
): { authorHex: string; caps: NodeCapabilities; reachability?: NodeReachability } | null {
  try {
    if (event.kind !== CAPABILITY_KIND) return null;
    const hasDTag = event.tags.some((t) => t[0] === "d" && t[1] === CAPABILITY_D_TAG);
    if (!hasDTag) return null;
    const parsed = JSON.parse(event.content) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) return null;
    const caps: NodeCapabilities = {
      localWs: Boolean(parsed.localWs),
      webrtc: Boolean(parsed.webrtc),
      dht: Boolean(parsed.dht),
    };
    let reachability: NodeReachability | undefined;
    if (ourSk && typeof parsed.enc === "string") {
      try {
        const selfKey = getConversationKey(ourSk, event.pubkey);
        const reach = JSON.parse(nip44Decrypt(parsed.enc, selfKey)) as Partial<NodeReachability>;
        reachability = {
          localWsPort: typeof reach.localWsPort === "number" ? reach.localWsPort : 0,
          lanIps: Array.isArray(reach.lanIps) ? reach.lanIps.filter((x) => typeof x === "string") : [],
        };
      } catch {
        // Not our advert (can't derive the matching key) or corrupt blob — the
        // public caps are still valid; just no reachability.
      }
    }
    return { authorHex: event.pubkey, caps, reachability };
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
