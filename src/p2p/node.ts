/**
 * The P2P node orchestrator (phantomyard/phantombot#258).
 *
 * Wires the three planes together and routes opaque gift-wrap frames between
 * them:
 *
 *   PWA  ──ws://localhost──▶  LocalBridge ─▶ node ─▶ PeerConnection ─▶ peer node
 *   peer node ─▶ PeerConnection ─▶ node ─▶ LocalBridge ──ws──▶ PWA
 *
 * with Nostr signaling carrying the WebRTC handshake for each peer. The node is
 * pure routing: it reads the recipient off a wrap's p-tag and forwards the
 * sealed wrap to that peer's data channel (dialing one on demand), and it
 * broadcasts inbound peer frames to the local PWA. It never decrypts a wrap.
 *
 * Glare-free negotiation: for any pair, the node with the SMALLER pubkey is the
 * sole initiator. When the larger-pubkey node has traffic it can't offer itself,
 * it sends a `hello` nudge and the initiator offers. So exactly one side ever
 * offers — no rollback, no perfect-negotiation state machine.
 *
 * Everything is injected through seams (`signaling`, `createBridge`,
 * `createPeer`) so the whole routing brain is unit-testable with in-memory fakes
 * and zero sockets, while production wires the real werift + Nostr + Bun-ws
 * implementations.
 */

import { log } from "../lib/logger.ts";
import type { ParsedEventFrame } from "./frame.ts";
import type { PeerConnectionOptions, PeerState } from "./peerConnection.ts";
import { PeerConnection } from "./peerConnection.ts";
import type { SignalMessage, Signaling } from "./signaling.ts";

/** The subset of a peer connection the orchestrator drives (mockable). */
export interface PeerLike {
  readonly peerHex: string;
  getState(): PeerState;
  isReady(): boolean;
  start(): Promise<void>;
  handleSignal(msg: SignalMessage): Promise<void>;
  send(frame: string): boolean;
  close(): void;
}

/** The local endpoint the node pushes inbound frames to (mockable). */
export interface BridgePort {
  start(): void;
  stop(): void;
  /** Push a frame to connected local PWA sockets; returns delivery count. */
  broadcast(frame: string): number;
  /** How many local PWA sockets are attached. */
  clientCount(): number;
  /**
   * The loopback port the bridge is ACTUALLY listening on. With OS-ephemeral
   * binding (`port: 0`) this is only meaningful after `start()`; that's fine
   * because the node advertises it post-start.
   */
  readonly boundPort: number;
}

export interface P2PNodeDeps {
  /** This node's pubkey (hex) — decides initiator/responder role per peer. */
  ourPubHex: string;
  /** Public STUN servers for NAT traversal. Empty = host candidates only. */
  iceServers: { urls: string }[];
  /** Nostr-backed signaling (or a fake in tests). */
  signaling: Signaling;
  /** Build the local ws bridge, given the outbound-frame handler to call. */
  createBridge: (onOutbound: (frame: ParsedEventFrame, raw: string) => void) => BridgePort;
  /** Build a peer connection. Defaults to a real werift `PeerConnection`. */
  createPeer?: (opts: PeerConnectionOptions) => PeerLike;
  /** Max frames buffered per peer while its channel comes up. Default 64. */
  maxOutboxPerPeer?: number;
}

const DEFAULT_MAX_OUTBOX = 64;

export class P2PNode {
  private readonly ourPubHex: string;
  private readonly iceServers: { urls: string }[];
  private readonly signaling: Signaling;
  private readonly createPeer: (opts: PeerConnectionOptions) => PeerLike;
  private readonly maxOutbox: number;
  private readonly bridge: BridgePort;

  private readonly peers = new Map<string, PeerLike>();
  /** Frames waiting for a peer's channel to open, per peer. */
  private readonly outbox = new Map<string, string[]>();
  /** Peers we've already kicked into negotiating (offer sent / nudge sent). */
  private readonly negotiating = new Set<string>();
  private started = false;

  constructor(deps: P2PNodeDeps) {
    this.ourPubHex = deps.ourPubHex;
    this.iceServers = deps.iceServers;
    this.signaling = deps.signaling;
    this.createPeer = deps.createPeer ?? ((o) => new PeerConnection(o));
    this.maxOutbox = deps.maxOutboxPerPeer ?? DEFAULT_MAX_OUTBOX;
    this.bridge = deps.createBridge((frame, raw) => this.onOutbound(frame, raw));
  }

  /**
   * Start the bridge + signaling. Idempotent. `bridge.start()` throws
   * synchronously on a port conflict — we only mark the node `started` AFTER
   * both come up, so a failed start leaves the node re-startable and makes
   * `stop()` a safe no-op (the caller in `startP2PNode` handles the throw).
   */
  start(): void {
    if (this.started) return;
    this.signaling.onMessage((senderHex, msg) => {
      void this.onSignal(senderHex, msg);
    });
    this.bridge.start(); // may throw (port in use) — started stays false
    this.signaling.start();
    this.started = true;
    log.info(`[p2p] node started (self ${this.ourPubHex.slice(0, 8)})`);
  }

  /**
   * The loopback port the bridge actually bound. Meaningful only after
   * `start()` (with an OS-ephemeral request the kernel assigns it on listen).
   * This is the value advertised so the PWA can find its local node.
   */
  get boundPort(): number {
    return this.bridge.boundPort;
  }

  /** Stop everything and drop all peer connections. Idempotent. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const peer of this.peers.values()) {
      try {
        peer.close();
      } catch (err) {
        log.debug(`[p2p] peer close failed: ${String(err)}`);
      }
    }
    this.peers.clear();
    this.outbox.clear();
    this.negotiating.clear();
    this.signaling.stop();
    this.bridge.stop();
    log.info("[p2p] node stopped");
  }

  /** A snapshot for the `p2p status` CLI. */
  stats(): { localClients: number; peers: { peerHex: string; state: PeerState }[] } {
    return {
      localClients: this.bridge.clientCount(),
      peers: Array.from(this.peers.values()).map((p) => ({
        peerHex: p.peerHex,
        state: p.getState(),
      })),
    };
  }

  private amInitiator(peerHex: string): boolean {
    return this.ourPubHex < peerHex;
  }

  /** An outgoing PWA frame → route it to the recipient peer's channel. */
  private onOutbound(frame: ParsedEventFrame, raw: string): void {
    const peerHex = frame.recipientHex;
    if (peerHex === this.ourPubHex) {
      // A self-addressed wrap (multi-device sync copy). There is no remote peer
      // to route it to; the relay copy handles multi-device. Drop silently.
      return;
    }
    const peer = this.getOrCreatePeer(peerHex);
    if (peer.isReady()) {
      if (peer.send(raw)) return;
      // Send failed on a supposedly-open channel — fall through to buffer/redial.
    }
    this.enqueue(peerHex, raw);
    this.kickstart(peerHex, peer);
  }

  /** An inbound signal from a peer. */
  private async onSignal(senderHex: string, msg: SignalMessage): Promise<void> {
    log.info(`[p2p] signal in: ${msg.t} from ${senderHex.slice(0, 8)}`);
    if (msg.t === "hello") {
      // We were nudged to initiate. Only act if we are in fact the initiator.
      if (this.amInitiator(senderHex)) {
        const peer = this.getOrCreatePeer(senderHex);
        this.kickstart(senderHex, peer);
      }
      return;
    }
    const peer = this.getOrCreatePeer(senderHex);
    // Receiving an offer/answer/candidate means we're actively negotiating, so
    // don't also fire a nudge for this peer.
    this.negotiating.add(senderHex);
    await peer.handleSignal(msg);
  }

  /** An inbound frame off a peer's data channel → hand to the local PWA. */
  private onPeerFrame(_peerHex: string, frame: string): void {
    this.bridge.broadcast(frame);
  }

  private onPeerState(peerHex: string, state: PeerState): void {
    log.info(`[p2p] peer ${peerHex.slice(0, 8)} → ${state}`);
    if (state === "connected") {
      this.flushOutbox(peerHex);
    } else if (state === "failed" || state === "closed") {
      this.dropPeer(peerHex);
    }
  }

  private getOrCreatePeer(peerHex: string): PeerLike {
    const existing = this.peers.get(peerHex);
    if (existing) {
      const s = existing.getState();
      if (s !== "failed" && s !== "closed") return existing;
      this.dropPeer(peerHex);
    }
    const peer = this.createPeer({
      peerHex,
      initiator: this.amInitiator(peerHex),
      iceServers: this.iceServers,
      sendSignal: (msg) => void this.signaling.send(peerHex, msg),
      onFrame: (frame) => this.onPeerFrame(peerHex, frame),
      onState: (state) => this.onPeerState(peerHex, state),
    });
    this.peers.set(peerHex, peer);
    if (!this.outbox.has(peerHex)) this.outbox.set(peerHex, []);
    return peer;
  }

  /**
   * Begin negotiation with a peer exactly once. The initiator sends its offer;
   * the responder can't offer, so it nudges the initiator with a `hello`.
   */
  private kickstart(peerHex: string, peer: PeerLike): void {
    if (this.negotiating.has(peerHex)) return;
    this.negotiating.add(peerHex);
    if (this.amInitiator(peerHex)) {
      log.info(`[p2p] kickstart ${peerHex.slice(0, 8)}: sending offer (initiator)`);
      void peer.start();
    } else {
      log.info(`[p2p] kickstart ${peerHex.slice(0, 8)}: sending hello (responder)`);
      void this.signaling.send(peerHex, { t: "hello" });
    }
  }

  private enqueue(peerHex: string, raw: string): void {
    let box = this.outbox.get(peerHex);
    if (!box) {
      box = [];
      this.outbox.set(peerHex, box);
    }
    box.push(raw);
    // Bounded: the relay copy is the guaranteed floor, so dropping the oldest
    // buffered P2P copy is safe — it just means that message went relay-only.
    if (box.length > this.maxOutbox) box.shift();
  }

  private flushOutbox(peerHex: string): void {
    const box = this.outbox.get(peerHex);
    const peer = this.peers.get(peerHex);
    if (!box || !peer) return;
    this.outbox.set(peerHex, []);
    for (const raw of box) {
      if (!peer.send(raw)) {
        log.debug(`[p2p] flush send failed for ${peerHex.slice(0, 8)}; dropping (relay is floor)`);
      }
    }
  }

  private dropPeer(peerHex: string): void {
    const peer = this.peers.get(peerHex);
    if (peer) {
      try {
        peer.close();
      } catch (err) {
        log.debug(`[p2p] dropPeer close failed: ${String(err)}`);
      }
    }
    this.peers.delete(peerHex);
    this.outbox.delete(peerHex);
    this.negotiating.delete(peerHex);
  }
}
