/**
 * P2P transport node — public surface + daemon glue (phantomyard/phantombot#258).
 *
 * Assembles the werift + Nostr-signaling + Bun-ws pieces into a running node and
 * exposes a start-and-wait-for-abort helper the `run` daemon pushes onto its
 * task list, mirroring the phantomchat listener pattern.
 */

import { log } from "../lib/logger.ts";
import type { P2PSettings } from "../config.ts";
import type { RelayPool } from "../channels/phantomchat/transport.ts";
import {
  buildCapabilityEvent,
  nodeCapabilities,
  publishCapability,
} from "./capability.ts";
import { LocalBridge } from "./localBridge.ts";
import { P2PNode } from "./node.ts";
import { NostrSignaling } from "./signaling.ts";

export { P2PNode } from "./node.ts";
export { DEFAULT_LOCAL_NODE_PORT } from "./frame.ts";
export type { NodeCapabilities } from "./capability.ts";

export interface BuildP2PNodeDeps {
  /** Persona secret key — signs signaling + capability, derives our pubkey. */
  secretKey: Uint8Array;
  /** Persona pubkey (hex) — decides initiator/responder role per peer. */
  publicKeyHex: string;
  /** Relays used for signaling + capability (same set the chat channel uses). */
  relays: string[];
  /** The relay pool to ride (reuse the persona's existing SimplePool). */
  pool: RelayPool;
  /** Resolved P2P settings (port + STUN). */
  settings: P2PSettings;
}

/** Assemble a ready-to-start P2P node from a persona's identity + relays. */
export function buildP2PNode(deps: BuildP2PNodeDeps): P2PNode {
  const signaling = new NostrSignaling(deps.secretKey, deps.relays, deps.pool);
  const iceServers = deps.settings.stunServers.map((urls) => ({ urls }));
  return new P2PNode({
    ourPubHex: deps.publicKeyHex,
    iceServers,
    signaling,
    createBridge: (onOutbound) => new LocalBridge({ port: deps.settings.port, onOutbound }),
  });
}

/**
 * Publish this node's capability advertisement once. Best-effort and detached
 * from startup — a relay hiccup must never delay the node coming up, and the
 * advert is inert until a PWA companion reads it.
 */
export function advertiseP2PCapability(deps: BuildP2PNodeDeps): void {
  const event = buildCapabilityEvent(deps.secretKey, nodeCapabilities(deps.settings.port));
  void publishCapability(deps.pool, deps.relays, event).catch((err) => {
    log.debug(`[p2p] capability advertise failed: ${String(err)}`);
  });
}

/**
 * Start a node and keep it alive until the abort signal fires, then stop it.
 * Shaped like the phantomchat listener so `run` can `tasks.push(...)` it and
 * `Promise.all` the lot under the shared shutdown `AbortController`.
 */
export async function runP2PNode(node: P2PNode, signal: AbortSignal): Promise<void> {
  node.start();
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  node.stop();
}
