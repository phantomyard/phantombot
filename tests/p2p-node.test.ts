/**
 * The node routing brain, driven entirely through its seams (fake signaling,
 * fake bridge, fake peers) so it runs with zero sockets. Covers the parts that
 * are easy to get wrong: deterministic initiator vs. hello-nudge, buffering a
 * frame until the channel opens then flushing it, dropping self-addressed
 * wraps, and redialling a failed peer.
 */

import { describe, expect, spyOn, test } from "bun:test";

import { log } from "../src/lib/logger.ts";
import { P2PNode, type BridgePort, type PeerLike } from "../src/p2p/node.ts";
import type { PeerConnectionOptions, PeerState } from "../src/p2p/peerConnection.ts";
import type { ParsedEventFrame } from "../src/p2p/frame.ts";
import type { SignalMessage, SignalHandler, Signaling } from "../src/p2p/signaling.ts";
import type { NTNostrEvent } from "../src/lib/nostrCrypto.ts";

class FakeSignaling implements Signaling {
  sent: { to: string; msg: SignalMessage }[] = [];
  handler: SignalHandler | null = null;
  started = false;
  send(to: string, msg: SignalMessage): Promise<void> {
    this.sent.push({ to, msg });
    return Promise.resolve();
  }
  onMessage(h: SignalHandler): void {
    this.handler = h;
  }
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.started = false;
  }
  /** Simulate an inbound signal from a peer. */
  emit(senderHex: string, msg: SignalMessage): void {
    this.handler?.(senderHex, msg);
  }
}

class FakeBridge implements BridgePort {
  broadcasts: string[] = [];
  clients = 1;
  started = false;
  boundPort = 50000;
  outbound!: (frame: ParsedEventFrame, raw: string) => void;
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.started = false;
  }
  broadcast(frame: string): number {
    this.broadcasts.push(frame);
    return this.clients;
  }
  clientCount(): number {
    return this.clients;
  }
  /** Simulate the PWA sending a frame over ws://localhost. */
  pwaSends(recipientHex: string, raw = `["EVENT",{"to":"${recipientHex}"}]`): void {
    const frame: ParsedEventFrame = {
      wrap: { tags: [["p", recipientHex]] } as unknown as NTNostrEvent,
      recipientHex,
    };
    this.outbound(frame, raw);
  }
}

class FakePeer implements PeerLike {
  readonly peerHex: string;
  readonly opts: PeerConnectionOptions;
  state: PeerState = "new";
  started = false;
  sent: string[] = [];
  handled: SignalMessage[] = [];
  closed = false;
  sendReturns = true;
  constructor(opts: PeerConnectionOptions) {
    this.peerHex = opts.peerHex;
    this.opts = opts;
  }
  getState(): PeerState {
    return this.state;
  }
  isReady(): boolean {
    return this.state === "connected";
  }
  start(): Promise<void> {
    this.started = true;
    this.state = "connecting";
    return Promise.resolve();
  }
  handleSignal(msg: SignalMessage): Promise<void> {
    this.handled.push(msg);
    return Promise.resolve();
  }
  send(frame: string): boolean {
    if (!this.sendReturns) return false;
    this.sent.push(frame);
    return true;
  }
  close(): void {
    this.closed = true;
    this.state = "closed";
  }
  /** Drive the state transition the node listens on. */
  transition(state: PeerState): void {
    this.state = state;
    this.opts.onState?.(state);
  }
  /** Simulate an inbound data-channel frame. */
  deliver(frame: string): void {
    this.opts.onFrame(frame);
  }
}

function makeNode(ourPubHex: string) {
  const signaling = new FakeSignaling();
  const bridge = new FakeBridge();
  const peers: FakePeer[] = [];
  const node = new P2PNode({
    ourPubHex,
    iceServers: [],
    signaling,
    createBridge: (onOutbound) => {
      bridge.outbound = onOutbound;
      return bridge;
    },
    createPeer: (opts) => {
      const p = new FakePeer(opts);
      peers.push(p);
      return p;
    },
  });
  node.start();
  return { node, signaling, bridge, peers, peerFor: (hex: string) => peers.find((p) => p.peerHex === hex) };
}

describe("P2PNode routing", () => {
  test("start wires bridge + signaling", () => {
    const { signaling, bridge } = makeNode("m".repeat(64));
    expect(signaling.started).toBe(true);
    expect(bridge.started).toBe(true);
  });

  test("as initiator: outbound frame dials, buffers, then flushes on connect", () => {
    const us = "a".repeat(64);
    const peerHex = "f".repeat(64); // us < peer → we initiate
    const { bridge, peerFor } = makeNode(us);

    bridge.pwaSends(peerHex, "frame-1");
    const peer = peerFor(peerHex)!;
    expect(peer.started).toBe(true); // initiator started the offer
    expect(peer.sent).toHaveLength(0); // not ready yet → buffered

    peer.transition("connected");
    expect(peer.sent).toEqual(["frame-1"]); // flushed
  });

  test("as responder: outbound frame sends a hello nudge instead of offering", () => {
    const us = "f".repeat(64);
    const peerHex = "a".repeat(64); // us > peer → peer initiates, we nudge
    const { signaling, bridge, peerFor } = makeNode(us);

    bridge.pwaSends(peerHex, "frame-1");
    const peer = peerFor(peerHex)!;
    expect(peer.started).toBe(false); // responder must not offer
    expect(signaling.sent).toContainEqual({ to: peerHex, msg: { t: "hello" } });

    peer.transition("connected");
    expect(peer.sent).toEqual(["frame-1"]);
  });

  test("ready peer sends immediately without buffering", () => {
    const us = "a".repeat(64);
    const peerHex = "f".repeat(64);
    const { bridge, peerFor } = makeNode(us);

    bridge.pwaSends(peerHex, "first");
    const peer = peerFor(peerHex)!;
    peer.transition("connected");
    bridge.pwaSends(peerHex, "second");
    expect(peer.sent).toEqual(["first", "second"]);
  });

  test("hello nudge makes the initiator offer", () => {
    const us = "a".repeat(64); // us < peer → we're the initiator
    const peerHex = "f".repeat(64);
    const { signaling, peerFor } = makeNode(us);

    signaling.emit(peerHex, { t: "hello" });
    expect(peerFor(peerHex)!.started).toBe(true);
  });

  test("hello nudge to a responder is ignored (no double-offer)", () => {
    const us = "f".repeat(64); // us > peer → we're the responder
    const peerHex = "a".repeat(64);
    const { signaling, peers } = makeNode(us);

    signaling.emit(peerHex, { t: "hello" });
    expect(peers).toHaveLength(0); // nothing created, nothing offered
  });

  test("inbound offer creates a peer and feeds it the signal", () => {
    const us = "f".repeat(64);
    const peerHex = "a".repeat(64);
    const { signaling, peerFor } = makeNode(us);

    signaling.emit(peerHex, { t: "offer", sdp: "x" });
    expect(peerFor(peerHex)!.handled).toEqual([{ t: "offer", sdp: "x" }]);
  });

  test("a re-offer (new session) rebuilds the peer on a clean connection", () => {
    const us = "f".repeat(64);
    const peerHex = "a".repeat(64);
    const { signaling, peers, peerFor } = makeNode(us);

    // First session: offer establishes a peer.
    signaling.emit(peerHex, { t: "offer", sdp: "session-1" });
    const first = peerFor(peerHex)!;
    first.transition("connected");
    expect(peers.filter((p) => p.peerHex === peerHex)).toHaveLength(1);

    // The peer reconnects with a brand-new offer while the old (zombie) peer is
    // still "connected" — werift never fired a failure. Must rebuild, not feed
    // the new-session offer into the dead transport.
    signaling.emit(peerHex, { t: "offer", sdp: "session-2" });
    expect(first.closed).toBe(true);
    const both = peers.filter((p) => p.peerHex === peerHex);
    expect(both).toHaveLength(2);
    expect(both[1]!.handled).toEqual([{ t: "offer", sdp: "session-2" }]);
  });

  test("a duplicate offer (same SDP) is ignored, not rebuilt", () => {
    const us = "f".repeat(64);
    const peerHex = "a".repeat(64);
    const { signaling, peers, peerFor } = makeNode(us);

    signaling.emit(peerHex, { t: "offer", sdp: "same" });
    const first = peerFor(peerHex)!;
    signaling.emit(peerHex, { t: "offer", sdp: "same" });
    // No teardown, no second peer, offer handled exactly once.
    expect(first.closed).toBe(false);
    expect(peers.filter((p) => p.peerHex === peerHex)).toHaveLength(1);
    expect(first.handled).toEqual([{ t: "offer", sdp: "same" }]);
  });

  test("a candidate arriving before the first offer is not torn down by that offer", () => {
    const us = "f".repeat(64);
    const peerHex = "a".repeat(64);
    const { signaling, peers, peerFor } = makeNode(us);

    // Relay reordering: candidate lands first, creating a buffering peer.
    signaling.emit(peerHex, { t: "candidate", candidate: "cand", sdpMid: null, sdpMLineIndex: null });
    const peer = peerFor(peerHex)!;
    // The FIRST offer must feed this same peer (preserving buffered candidates),
    // NOT rebuild it.
    signaling.emit(peerHex, { t: "offer", sdp: "session-1" });
    expect(peer.closed).toBe(false);
    expect(peers.filter((p) => p.peerHex === peerHex)).toHaveLength(1);
    expect(peer.handled.map((m) => m.t)).toEqual(["candidate", "offer"]);
  });

  test("inbound peer frame is broadcast to the local PWA", () => {
    const us = "a".repeat(64);
    const peerHex = "f".repeat(64);
    const { bridge, peerFor } = makeNode(us);
    bridge.pwaSends(peerHex);
    peerFor(peerHex)!.deliver(`["EVENT",{"inbound":true}]`);
    expect(bridge.broadcasts).toEqual([`["EVENT",{"inbound":true}]`]);
  });

  test("a self-addressed wrap is dropped, no peer created", () => {
    const us = "a".repeat(64);
    const { bridge, peers } = makeNode(us);
    bridge.pwaSends(us);
    expect(peers).toHaveLength(0);
  });

  test("a failed peer is dropped and redialled on the next frame", () => {
    const us = "a".repeat(64);
    const peerHex = "f".repeat(64);
    const { bridge, peers, peerFor } = makeNode(us);

    bridge.pwaSends(peerHex, "one");
    const first = peerFor(peerHex)!;
    first.transition("failed");
    expect(first.closed).toBe(true);

    bridge.pwaSends(peerHex, "two");
    // A brand-new peer object was created for the redial.
    expect(peers.filter((p) => p.peerHex === peerHex)).toHaveLength(2);
    expect(peers[1]!.started).toBe(true);
  });

  test("stop closes peers and tears down bridge + signaling", () => {
    const us = "a".repeat(64);
    const peerHex = "f".repeat(64);
    const { node, signaling, bridge, peerFor } = makeNode(us);
    bridge.pwaSends(peerHex);
    node.stop();
    expect(peerFor(peerHex)!.closed).toBe(true);
    expect(signaling.started).toBe(false);
    expect(bridge.started).toBe(false);
  });

  test("stats reflects local clients and peer states", () => {
    const us = "a".repeat(64);
    const peerHex = "f".repeat(64);
    const { node, bridge, peerFor } = makeNode(us);
    bridge.pwaSends(peerHex);
    peerFor(peerHex)!.transition("connected");
    const stats = node.stats();
    expect(stats.localClients).toBe(1);
    expect(stats.peers).toEqual([{ peerHex, state: "connected" }]);
  });
});

describe("P2PNode delivery receipts (#542)", () => {
  const us = "a".repeat(64);
  const peerHex = "f".repeat(64);

  function receiptNode(ackTimeoutMs = 60) {
    const signaling = new FakeSignaling();
    const bridge = new FakeBridge();
    const peers: FakePeer[] = [];
    let outbound!: (frame: ParsedEventFrame, raw: string) => Promise<boolean>;
    const node = new P2PNode({
      ourPubHex: us,
      iceServers: [],
      signaling,
      ackTimeoutMs,
      createBridge: (onOutbound) => {
        outbound = onOutbound;
        bridge.outbound = onOutbound;
        return bridge;
      },
      createPeer: (opts) => {
        const p = new FakePeer(opts);
        peers.push(p);
        return p;
      },
    });
    node.start();
    const send = (id: string, to = peerHex) =>
      outbound(
        { wrap: { id, tags: [["p", to]] } as unknown as NTNostrEvent, recipientHex: to },
        `["EVENT",{"id":"${id}"}]`,
      );
    return { node, bridge, peers, send, peerFor: (hex: string) => peers.find((p) => p.peerHex === hex) };
  }

  function wrapTo(to: string, id = "e".repeat(64)): string {
    return JSON.stringify([
      "EVENT",
      { id, pubkey: "b".repeat(64), sig: "c".repeat(128), content: "x", kind: 1059, created_at: 1, tags: [["p", to]] },
    ]);
  }

  test("an OK from the recipient peer resolves the send true, and never reaches the bridge", async () => {
    const { bridge, send, peerFor } = receiptNode();
    const first = send("w0"); // creates the peer
    peerFor(peerHex)!.transition("connected");
    await first;
    const pending = send("w1");
    peerFor(peerHex)!.deliver('["OK","w1",true,"p2p"]');
    expect(await pending).toBe(true);
    expect(bridge.broadcasts).toHaveLength(0);
  });

  test("no receipt within the window resolves false", async () => {
    const { send, peerFor } = receiptNode(30);
    const pending = send("w1");
    peerFor(peerHex)!.transition("connected");
    expect(await pending).toBe(false);
  });

  test("an OK from a DIFFERENT peer cannot confirm the send", async () => {
    const other = "d".repeat(64);
    const { send, peerFor } = receiptNode(40);
    const pending = send("w1");
    peerFor(peerHex)!.transition("connected");
    // Bring up a second peer and have IT ack our id.
    void send("x", other);
    peerFor(other)!.transition("connected");
    peerFor(other)!.deliver('["OK","w1",true,"p2p"]');
    expect(await pending).toBe(false);
  });

  test("a rejected OK is not a delivery, and settles well inside the window (phantomchat#142)", async () => {
    // A window far longer than the test timeout: only an immediate settle passes.
    const { send, peerFor } = receiptNode(60_000);
    const pending = send("w1");
    peerFor(peerHex)!.transition("connected");
    const started = Date.now();
    peerFor(peerHex)!.deliver('["OK","w1",false,"blocked"]');
    expect(await pending).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("a rejection from a DIFFERENT peer does not settle the send", async () => {
    const other = "d".repeat(64);
    const { send, peerFor } = receiptNode(60_000);
    const pending = send("w1");
    peerFor(peerHex)!.transition("connected");
    void send("x", other);
    peerFor(other)!.transition("connected");
    peerFor(other)!.deliver('["OK","w1",false,"blocked"]');
    peerFor(peerHex)!.deliver('["OK","w1",true,"p2p"]');
    expect(await pending).toBe(true);
  });

  test("a receipt that cannot be sent is logged with the wrap id prefix only (phantomchat#142)", () => {
    const { send, peerFor } = receiptNode();
    void send("w0");
    const peer = peerFor(peerHex)!;
    peer.transition("connected");
    peer.sendReturns = false;
    const lines: string[] = [];
    const spy = spyOn(log, "debug").mockImplementation((msg: string) => {
      lines.push(msg);
    });
    try {
      peer.deliver(wrapTo(us, "e".repeat(64)));
    } finally {
      spy.mockRestore();
    }
    const receiptLines = lines.filter((l) => l.includes("could not send receipt"));
    expect(receiptLines).toHaveLength(1);
    expect(receiptLines[0]).toContain("eeeeeeee");
    expect(receiptLines[0]).not.toContain("e".repeat(9));
  });

  test("a receipt send that throws is logged, never propagated", () => {
    const { send, peerFor } = receiptNode();
    void send("w0");
    const peer = peerFor(peerHex)!;
    peer.transition("connected");
    peer.send = () => {
      throw new Error("channel closing");
    };
    const lines: string[] = [];
    const spy = spyOn(log, "debug").mockImplementation((msg: string) => {
      lines.push(msg);
    });
    try {
      expect(() => peer.deliver(wrapTo(us))).not.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(lines.some((l) => l.includes("could not send receipt") && l.includes("channel closing"))).toBe(true);
  });

  test("a dropped peer releases its waiters immediately", async () => {
    const { send, peerFor } = receiptNode(60_000);
    const pending = send("w1");
    peerFor(peerHex)!.transition("failed");
    expect(await pending).toBe(false);
  });

  test("a self-addressed wrap resolves false without a peer", async () => {
    const { send, peers } = receiptNode();
    expect(await send("w1", us)).toBe(false);
    expect(peers).toHaveLength(0);
  });

  test("an inbound EVENT addressed to us is ingested, then acknowledged on the same channel", () => {
    const { bridge, send, peerFor } = receiptNode();
    void send("w0");
    const peer = peerFor(peerHex)!;
    peer.transition("connected");
    peer.sent.length = 0;
    peer.deliver(wrapTo(us, "e".repeat(64)));
    expect(bridge.broadcasts).toHaveLength(1);
    expect(peer.sent).toEqual([JSON.stringify(["OK", "e".repeat(64), true, "p2p"])]);
  });

  test("no listener took the frame → no receipt", () => {
    const { bridge, send, peerFor } = receiptNode();
    void send("w0");
    const peer = peerFor(peerHex)!;
    peer.transition("connected");
    peer.sent.length = 0;
    bridge.clients = 0;
    peer.deliver(wrapTo(us));
    expect(peer.sent).toHaveLength(0);
  });

  test("a wrap addressed to someone else is not acknowledged", () => {
    const { send, peerFor } = receiptNode();
    void send("w0");
    const peer = peerFor(peerHex)!;
    peer.transition("connected");
    peer.sent.length = 0;
    peer.deliver(wrapTo("9".repeat(64)));
    expect(peer.sent).toHaveLength(0);
  });
});
