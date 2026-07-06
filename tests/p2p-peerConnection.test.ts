/**
 * werift peer-connection wrapper — the real thing. Two PeerConnection instances
 * run in-process; their signaling is looped in memory (as Nostr would, minus the
 * relays). This exercises a genuine ICE → DTLS → SCTP data-channel handshake on
 * loopback host candidates and proves opaque frames flow both ways — the same
 * round-trip the pre-implementation spike validated under a compiled Bun binary.
 *
 * No STUN (`iceServers: []`) so it needs no network — host candidates on
 * loopback connect the two peers entirely offline, which is also exactly the
 * Tier-1/Tier-2 (localhost/LAN) path.
 */

import { describe, expect, test } from "bun:test";

import { PeerConnection } from "../src/p2p/peerConnection.ts";
import type { SignalMessage } from "../src/p2p/signaling.ts";

/**
 * Wire two peers so each one's outgoing signals are delivered to the other's
 * `handleSignal` on a microtask (mimicking async relay delivery without races).
 */
function connectPair(onAFrame: (f: string) => void, onBFrame: (f: string) => void) {
  let a!: PeerConnection;
  let b!: PeerConnection;

  a = new PeerConnection({
    peerHex: "b", // A dials B
    initiator: true,
    iceServers: [],
    sendSignal: (msg: SignalMessage) => void Promise.resolve().then(() => b.handleSignal(msg)),
    onFrame: onAFrame,
  });
  b = new PeerConnection({
    peerHex: "a",
    initiator: false,
    iceServers: [],
    sendSignal: (msg: SignalMessage) => void Promise.resolve().then(() => a.handleSignal(msg)),
    onFrame: onBFrame,
  });

  return { a, b };
}

function waitFor<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label}`)), ms)),
  ]);
}

describe("werift PeerConnection round-trip", () => {
  test(
    "two peers negotiate and exchange opaque frames both ways",
    async () => {
      let resolveB!: (f: string) => void;
      let resolveA!: (f: string) => void;
      const gotOnB = new Promise<string>((r) => (resolveB = r));
      const gotOnA = new Promise<string>((r) => (resolveA = r));

      const { a, b } = connectPair(
        (f) => resolveA(f),
        (f) => {
          resolveB(f);
          // Echo back so we also prove B→A direction.
          b.send(JSON.stringify(["EVENT", { echo: "from-b" }]));
        },
      );

      // A initiates; once its channel opens, send a frame.
      await a.start();
      // Poll until A's channel is ready, then send.
      const deadline = Date.now() + 12_000;
      while (!a.isReady() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(a.isReady()).toBe(true);
      a.send(JSON.stringify(["EVENT", { hello: "from-a" }]));

      const onB = await waitFor(gotOnB, 12_000, "B receive");
      const onA = await waitFor(gotOnA, 12_000, "A receive (echo)");

      expect(JSON.parse(onB)).toEqual(["EVENT", { hello: "from-a" }]);
      expect(JSON.parse(onA)).toEqual(["EVENT", { echo: "from-b" }]);
      expect(a.getState()).toBe("connected");
      expect(b.getState()).toBe("connected");

      a.close();
      b.close();
      expect(a.getState()).toBe("closed");
    },
    20_000,
  );

  test("send returns false before the channel is open", () => {
    const pc = new PeerConnection({
      peerHex: "z",
      initiator: true,
      iceServers: [],
      sendSignal: () => {},
      onFrame: () => {},
    });
    expect(pc.isReady()).toBe(false);
    expect(pc.send("frame")).toBe(false);
    pc.close();
  });
});
