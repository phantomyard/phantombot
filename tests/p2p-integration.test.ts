/**
 * End-to-end: two full P2P nodes exchange a message with NO relay in the data
 * path. Real werift peer connections (loopback host candidates), real routing
 * brain, an in-memory signaling bus standing in for Nostr relays, and fake
 * bridges standing in for the two PWAs.
 *
 * The flow proven here is the whole point of phantombot#258:
 *
 *   PWA_A → bridge_A → node_A → werift data channel → node_B → bridge_B → PWA_B
 *
 * The gift-wrap is opaque to both nodes; they forward it verbatim. Success = the
 * exact frame PWA_A sent lands at PWA_B's bridge, having never touched a relay.
 */

import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

import { P2PNode, type BridgePort } from "../src/p2p/node.ts";
import type { ParsedEventFrame } from "../src/p2p/frame.ts";
import type { SignalMessage, SignalHandler, Signaling } from "../src/p2p/signaling.ts";
import type { NTNostrEvent } from "../src/lib/nostrCrypto.ts";

/** In-memory signaling fabric: routes signals between registered node pubkeys. */
class SignalBus {
  private handlers = new Map<string, SignalHandler>();
  register(hex: string, handler: SignalHandler): void {
    this.handlers.set(hex, handler);
  }
  route(from: string, to: string, msg: SignalMessage): void {
    // Deliver asynchronously, like a relay would.
    const h = this.handlers.get(to);
    if (h) queueMicrotask(() => h(from, msg));
  }
}

class BusSignaling implements Signaling {
  constructor(
    private readonly ourHex: string,
    private readonly bus: SignalBus,
  ) {}
  private handler: SignalHandler | null = null;
  send(to: string, msg: SignalMessage): Promise<void> {
    this.bus.route(this.ourHex, to, msg);
    return Promise.resolve();
  }
  onMessage(h: SignalHandler): void {
    this.handler = h;
  }
  start(): void {
    this.bus.register(this.ourHex, (from, msg) => this.handler?.(from, msg));
  }
  stop(): void {}
}

/** A bridge that captures broadcasts and can inject a PWA send. */
class CapturingBridge implements BridgePort {
  broadcasts: string[] = [];
  outbound!: (frame: ParsedEventFrame, raw: string) => void;
  start(): void {}
  stop(): void {}
  broadcast(frame: string): number {
    this.broadcasts.push(frame);
    return 1;
  }
  clientCount(): number {
    return 1;
  }
  pwaSends(recipientHex: string, raw: string): void {
    const frame: ParsedEventFrame = {
      wrap: { tags: [["p", recipientHex]] } as unknown as NTNostrEvent,
      recipientHex,
    };
    this.outbound(frame, raw);
  }
}

function buildNode(ourHex: string, bus: SignalBus) {
  const bridge = new CapturingBridge();
  const node = new P2PNode({
    ourPubHex: ourHex,
    iceServers: [],
    signaling: new BusSignaling(ourHex, bus),
    createBridge: (onOutbound) => {
      bridge.outbound = onOutbound;
      return bridge;
    },
    // real werift PeerConnection (default createPeer)
  });
  node.start();
  return { node, bridge };
}

describe("two-node P2P bridge (relay-free data path)", () => {
  test(
    "a frame from PWA_A lands at PWA_B over the werift channel",
    async () => {
      const aHex = getPublicKey(generateSecretKey());
      const bHex = getPublicKey(generateSecretKey());
      const bus = new SignalBus();

      const a = buildNode(aHex, bus);
      const b = buildNode(bHex, bus);

      // PWA_A sends a message addressed to B.
      const raw = JSON.stringify(["EVENT", { id: "wrap-1", to: bHex, sealed: true }]);
      a.bridge.pwaSends(bHex, raw);

      // Wait for the werift handshake + delivery.
      const deadline = Date.now() + 15_000;
      while (b.bridge.broadcasts.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(b.bridge.broadcasts).toEqual([raw]);
      // And A never broadcast to itself (no self-loop).
      expect(a.bridge.broadcasts).toHaveLength(0);

      a.node.stop();
      b.node.stop();
    },
    20_000,
  );
});
