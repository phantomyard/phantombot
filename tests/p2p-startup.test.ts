/**
 * Daemon startup containment (phantomchat#258, Kai review on #266; #61 rewrite).
 *
 * `node.start()` runs synchronously and can throw during signaling bring-up. If
 * that throw escaped into a pushed task it would reject `Promise.all(tasks)` and
 * abort the whole `phantombot run` process — killing PhantomChat over a P2P
 * hiccup. `startP2PNode` must contain it: log, warn, tear down, return `null`,
 * and never reject. (The old ws loopback bridge — and its port-conflict throw —
 * was retired in #61; the in-process `ChannelBridge` opens no socket, so
 * containment is now proven against a throwing signaling layer instead.)
 */

import { afterEach, describe, expect, test } from "bun:test";

import { ChannelBridge, startP2PNode } from "../src/p2p/index.ts";
import { P2PNode } from "../src/p2p/node.ts";
import type { SignalHandler, SignalMessage, Signaling } from "../src/p2p/signaling.ts";

class FakeSignaling implements Signaling {
  started = false;
  constructor(private readonly throwOnStart = false) {}
  send(_to: string, _msg: SignalMessage): Promise<void> {
    return Promise.resolve();
  }
  onMessage(_h: SignalHandler): void {}
  start(): void {
    if (this.throwOnStart) throw new Error("signaling boom");
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

let node: P2PNode | null = null;
afterEach(() => {
  node?.stop();
  node = null;
});

function makeNode(throwOnStart = false): P2PNode {
  return new P2PNode({
    ourPubHex: SELF,
    iceServers: [],
    signaling: new FakeSignaling(throwOnStart),
    createBridge: (onOutbound) => {
      const bridge = new ChannelBridge();
      bridge.setRouter(onOutbound);
      return bridge;
    },
  });
}

describe("startP2PNode — startup-throw containment", () => {
  test("a throwing bring-up degrades to a warning, not a rejected task", () => {
    node = makeNode(true);
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
    // The node was torn down, not wedged.
    expect(node.stats().peers).toEqual([]);
  });

  test("a clean start advertises and the task resolves on abort", async () => {
    node = makeNode(false);
    const out = new Capture();
    const err = new Capture();
    let advertised = false;
    const ac = new AbortController();

    const task = startP2PNode({
      node,
      advertise: () => {
        advertised = true;
      },
      signal: ac.signal,
      out,
      err,
      persona: "lena",
    });

    expect(task).not.toBeNull();
    expect(advertised).toBe(true);
    expect(out.text).toContain("[p2p:lena]");
    expect(out.text).toContain("WebRTC");
    expect(err.text).toBe("");

    // The keep-alive task must resolve cleanly once we abort (no hang, no throw).
    ac.abort();
    await task;
  });
});
