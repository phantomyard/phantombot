/**
 * Local ws bridge — the real Bun WebSocket server, exercised by a real loopback
 * WebSocket client. Proves the PWA-facing contract end to end: a client frame
 * reaches `onOutbound`, and a broadcast reaches the client.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { LocalBridge } from "../src/p2p/localBridge.ts";
import { buildEventFrame } from "../src/p2p/frame.ts";
import type { ParsedEventFrame } from "../src/p2p/frame.ts";
import type { NTNostrEvent } from "../src/lib/nostrCrypto.ts";

let bridge: LocalBridge | null = null;
afterEach(() => {
  bridge?.stop();
  bridge = null;
});

function giftWrap(recipientHex: string): NTNostrEvent {
  return {
    id: "a".repeat(64),
    pubkey: "b".repeat(64),
    sig: "c".repeat(128),
    kind: 1059,
    created_at: 1,
    tags: [["p", recipientHex]],
    content: "sealed",
  };
}

function openClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", () => reject(new Error("client failed to open")));
    setTimeout(() => reject(new Error("client open timeout")), 3000);
  });
}

describe("LocalBridge loopback", () => {
  test("a client EVENT frame reaches onOutbound with the recipient parsed", async () => {
    const received: ParsedEventFrame[] = [];
    bridge = new LocalBridge({ port: 0, onOutbound: (f) => received.push(f) });
    bridge.start();

    const client = await openClient(bridge.boundPort);
    const recipientHex = "d".repeat(64);
    client.send(buildEventFrame(giftWrap(recipientHex)));

    await Bun.sleep(100);
    expect(received).toHaveLength(1);
    expect(received[0]!.recipientHex).toBe(recipientHex);
    client.close();
  });

  test("junk and non-EVENT frames are ignored, not delivered", async () => {
    const received: ParsedEventFrame[] = [];
    bridge = new LocalBridge({ port: 0, onOutbound: (f) => received.push(f) });
    bridge.start();

    const client = await openClient(bridge.boundPort);
    client.send("not json");
    client.send(JSON.stringify(["REQ", "sub", {}]));
    await Bun.sleep(100);
    expect(received).toHaveLength(0);
    client.close();
  });

  test("broadcast reaches connected clients", async () => {
    bridge = new LocalBridge({ port: 0, onOutbound: () => {} });
    bridge.start();

    const client = await openClient(bridge.boundPort);
    const got = new Promise<string>((resolve) => {
      client.addEventListener("message", (ev) => resolve(String(ev.data)));
    });

    // Wait for the server to register the socket, then broadcast.
    await Bun.sleep(50);
    const frame = buildEventFrame(giftWrap("e".repeat(64)));
    const count = bridge.broadcast(frame);
    expect(count).toBe(1);

    const received = await Promise.race([
      got,
      new Promise<string>((_, r) => setTimeout(() => r(new Error("no message")), 2000)),
    ]);
    expect(received).toBe(frame);
    client.close();
  });

  test("broadcast to nobody returns 0 and does not throw", () => {
    bridge = new LocalBridge({ port: 0, onOutbound: () => {} });
    bridge.start();
    expect(bridge.broadcast("frame")).toBe(0);
  });
});
