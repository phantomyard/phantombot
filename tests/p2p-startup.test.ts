/**
 * Daemon startup containment (phantomchat#258, Kai review on #266).
 *
 * `node.start()` throws SYNCHRONOUSLY when the loopback port is already taken.
 * If that throw escaped into a pushed task it would reject `Promise.all(tasks)`
 * and abort the whole `phantombot run` process — killing PhantomChat over a P2P
 * port conflict. `startP2PNode` must contain it: log, warn, tear down, return
 * `null`, and never reject. These tests drive that with a REAL LocalBridge
 * occupying the port (the exact failure Kai reproduced).
 */

import { afterEach, describe, expect, test } from "bun:test";

import { startP2PNode } from "../src/p2p/index.ts";
import { P2PNode } from "../src/p2p/node.ts";
import { LocalBridge } from "../src/p2p/localBridge.ts";
import type { SignalHandler, SignalMessage, Signaling } from "../src/p2p/signaling.ts";

class FakeSignaling implements Signaling {
  started = false;
  send(_to: string, _msg: SignalMessage): Promise<void> {
    return Promise.resolve();
  }
  onMessage(_h: SignalHandler): void {}
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.started = false;
  }
}

class Capture {
  text = "";
  write(s: string): void {
    this.text += s;
  }
}

const SELF = "a".repeat(64);

let blocker: LocalBridge | null = null;
let node: P2PNode | null = null;
afterEach(() => {
  node?.stop();
  node = null;
  blocker?.stop();
  blocker = null;
});

function makeNode(port: number): P2PNode {
  return new P2PNode({
    ourPubHex: SELF,
    iceServers: [],
    signaling: new FakeSignaling(),
    createBridge: (onOutbound) => new LocalBridge({ port, onOutbound }),
  });
}

describe("startP2PNode — port-conflict containment", () => {
  test("a taken loopback port degrades to a warning, not a rejected task", async () => {
    // Occupy the port first — this is Kai's two-bridges-on-one-port repro.
    blocker = new LocalBridge({ port: 0, onOutbound: () => {} });
    blocker.start();
    const takenPort = blocker.boundPort;

    node = makeNode(takenPort);
    const out = new Capture();
    const err = new Capture();
    let advertised = false;

    const task = startP2PNode({
      node,
      advertise: () => {
        advertised = true;
      },
      signal: new AbortController().signal,
      out,
      err,
      persona: "lena",
    });

    // Contained: no task to push, relay-fallback warning emitted, advert skipped.
    expect(task).toBeNull();
    expect(err.text).toContain("chat still works over relays");
    expect(advertised).toBe(false);
    // The node was left re-startable (start never completed), not wedged.
    expect(node.stats().peers).toEqual([]);
  });

  test("a free port starts, advertises, and the task resolves on abort", async () => {
    node = makeNode(0);
    const out = new Capture();
    const err = new Capture();
    let advertised = false;
    const ac = new AbortController();

    let advertisedPort = -1;
    const task = startP2PNode({
      node,
      advertise: (boundPort) => {
        advertised = true;
        advertisedPort = boundPort;
      },
      signal: ac.signal,
      out,
      err,
      persona: "lena",
    });

    expect(task).not.toBeNull();
    expect(advertised).toBe(true);
    // Ephemeral bind → a real OS-assigned port was advertised, not 0.
    expect(advertisedPort).toBeGreaterThan(0);
    expect(out.text).toContain("[p2p:lena]");
    expect(err.text).toBe("");

    // The keep-alive task must resolve cleanly once we abort (no hang, no throw).
    ac.abort();
    await task;
  });
});

describe("ephemeral ports — many personas, one machine, zero collisions", () => {
  test("two nodes on port 0 both start and bind DISTINCT ports", () => {
    // The exact "5 phantoms on the same PC" scenario, minimised to two: with the
    // old fixed 47100 the second would throw a port conflict; with ephemeral
    // binding each gets its own free port and both come up.
    const a = makeNode(0);
    const b = makeNode(0);
    try {
      a.start();
      b.start();
      expect(a.boundPort).toBeGreaterThan(0);
      expect(b.boundPort).toBeGreaterThan(0);
      expect(a.boundPort).not.toBe(b.boundPort);
    } finally {
      a.stop();
      b.stop();
    }
  });

  test("startP2PNode advertises each node's REAL bound port, not the request", () => {
    const n = makeNode(0);
    const ac = new AbortController();
    let advertisedPort = -1;
    const task = startP2PNode({
      node: n,
      advertise: (boundPort) => {
        advertisedPort = boundPort;
      },
      signal: ac.signal,
      out: new Capture(),
      err: new Capture(),
      persona: "kai",
    });
    try {
      expect(task).not.toBeNull();
      // What was advertised is exactly what the bridge actually bound.
      expect(advertisedPort).toBe(n.boundPort);
      expect(advertisedPort).toBeGreaterThan(0);
    } finally {
      ac.abort();
      n.stop();
    }
  });
});
