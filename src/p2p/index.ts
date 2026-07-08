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
import { buildCapabilityEvent, publishCapability } from "./capability.ts";
import type { ChannelBridge } from "./channelBridge.ts";
import { installIceErrorGuard } from "./iceErrorGuard.ts";
import { P2PNode } from "./node.ts";
import { NostrSignaling } from "./signaling.ts";

export { P2PNode } from "./node.ts";
export { ChannelBridge } from "./channelBridge.ts";
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
  /** Resolved P2P settings (STUN servers, enabled flag). */
  settings: P2PSettings;
  /**
   * The in-process bridge to the persona's phantomchat channel. Created before
   * the node so the channel + transport can be wired to it at construction; the
   * node injects its outbound router into it here. Replaces the old ws
   * `LocalBridge` — a headless persona has no co-located browser, so its "local
   * side" is its own channel (see channelBridge.ts).
   */
  bridge: ChannelBridge;
}

/** Assemble a ready-to-start P2P node from a persona's identity + relays. */
export function buildP2PNode(deps: BuildP2PNodeDeps): P2PNode {
  const signaling = new NostrSignaling(deps.secretKey, deps.relays, deps.pool);
  const iceServers = deps.settings.stunServers.map((urls) => ({ urls }));
  return new P2PNode({
    ourPubHex: deps.publicKeyHex,
    iceServers,
    signaling,
    createBridge: (onOutbound) => {
      // Inject the node's router into the pre-made channel bridge and hand it
      // back as the node's BridgePort. No socket is opened.
      deps.bridge.setRouter(onOutbound);
      return deps.bridge;
    },
  });
}

/**
 * Publish this node's capability advertisement once. Best-effort and detached
 * from startup — a relay hiccup must never delay the node coming up. Post-#61
 * the advert is a single `{ webrtc: true }` boolean (no loopback port).
 */
export function advertiseP2PCapability(deps: BuildP2PNodeDeps): void {
  const event = buildCapabilityEvent(deps.secretKey);
  void publishCapability(deps.pool, deps.relays, event).catch((err) => {
    log.debug(`[p2p] capability advertise failed: ${String(err)}`);
  });
}

/**
 * Keep an ALREADY-STARTED node alive until the abort signal fires, then stop it.
 * Shaped like the phantomchat listener so `run` can `tasks.push(...)` it and
 * `Promise.all` the lot under the shared shutdown `AbortController`.
 *
 * The node MUST already be started (see `startP2PNode`). Startup is deliberately
 * kept out of this task: `node.start()` throws synchronously on a port conflict,
 * and if that throw happened here it would surface as a rejected task and abort
 * the whole `phantombot run` process — exactly the failure this split prevents.
 */
export async function keepP2PNodeAlive(node: P2PNode, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  node.stop();
}

export interface StartP2PNodeInput {
  node: P2PNode;
  /** Publish the capability advert — only after a successful start. */
  advertise: () => void;
  signal: AbortSignal;
  out: { write: (s: string) => void };
  err: { write: (s: string) => void };
  persona: string;
}

/**
 * Start a P2P node with its bridge SYNCHRONOUSLY and, on success, return a
 * long-lived task to push onto the daemon's list. On failure (e.g. the loopback
 * port is already taken by another persona/process) it is fully contained: the
 * error is logged, a relay-fallback warning is written, the node is torn down,
 * and `null` is returned so the caller keeps every other channel running.
 *
 * This is the crux of the port-conflict-must-not-kill-the-daemon fix — the throw
 * is caught here, never inside a pushed Promise.
 */
export function startP2PNode(input: StartP2PNodeInput): Promise<void> | null {
  // werift's ICE UDP sockets throw benign uncaught ECONNREFUSED/EHOSTUNREACH on
  // dead candidate probes, which would crash-loop the daemon mid-handshake.
  // Install the scoped guard before any peer connection can open a socket.
  installIceErrorGuard();
  try {
    input.node.start(); // synchronous; contains any signaling bring-up throw
  } catch (e) {
    log.warn(`p2p[${input.persona}]: node failed to start`, {
      error: (e as Error).message,
    });
    input.err.write(
      `warning: p2p node failed to start — chat still works over relays\n`,
    );
    try {
      input.node.stop();
    } catch {
      // best-effort teardown of a half-started node
    }
    return null;
  }
  input.advertise();
  input.out.write(
    `  [p2p:${input.persona}] WebRTC node up (relay fallback active)\n`,
  );
  return keepP2PNodeAlive(input.node, input.signal);
}
