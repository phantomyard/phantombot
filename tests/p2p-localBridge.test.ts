/**
 * Local ws bridge — the real Bun WebSocket server, exercised by a real loopback
 * WebSocket client. Proves the PWA-facing contract end to end: a client frame
 * reaches `onOutbound`, and a broadcast reaches the client.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { LocalBridge, isOriginAllowed } from "../src/p2p/localBridge.ts";
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

describe("isOriginAllowed (pure)", () => {
  const allow = ["https://chat.phantomyard.ai"];

  test("a genuinely absent Origin is allowed (CLI + non-browser tooling)", () => {
    expect(isOriginAllowed(null, allow)).toBe(true);
    expect(isOriginAllowed(undefined, allow)).toBe(true);
    expect(isOriginAllowed("", allow)).toBe(true);
  });

  test('a literal "null" Origin (browser opaque origin) is refused', () => {
    // Sandboxed iframes, data:/file: pages, and some cross-origin redirects make
    // a browser send `Origin: null`. A hostile page can provoke it, so it must
    // NOT be treated as trusted non-browser tooling.
    expect(isOriginAllowed("null", allow)).toBe(false);
  });

  test("localhost origins are always allowed (the dev PWA)", () => {
    expect(isOriginAllowed("http://localhost:5173", allow)).toBe(true);
    expect(isOriginAllowed("https://localhost", allow)).toBe(true);
    expect(isOriginAllowed("http://127.0.0.1:8080", allow)).toBe(true);
    expect(isOriginAllowed("http://[::1]:3000", allow)).toBe(true);
  });

  test("a listed production origin is allowed, an unlisted site is not", () => {
    expect(isOriginAllowed("https://chat.phantomyard.ai", allow)).toBe(true);
    expect(isOriginAllowed("https://example.com", allow)).toBe(false);
    expect(isOriginAllowed("https://evil.phantomyard.ai", allow)).toBe(false);
    // Must be exact — a lookalike host is not a substring match.
    expect(isOriginAllowed("https://chat.phantomyard.ai.evil.com", allow)).toBe(false);
  });

  test("an unparseable Origin is refused", () => {
    expect(isOriginAllowed("not a url", allow)).toBe(false);
  });
});

describe("LocalBridge origin gate (live)", () => {
  // The gate runs in `fetch` BEFORE `server.upgrade`, so a plain GET is enough
  // to exercise it: a hostile Origin is refused with 403; an allowed Origin
  // passes the gate and only then hits the "websocket only" 426.
  test("a hostile browser Origin is refused with 403", async () => {
    bridge = new LocalBridge({
      port: 0,
      onOutbound: () => {},
      allowedOrigins: ["https://chat.phantomyard.ai"],
    });
    bridge.start();
    const res = await fetch(`http://127.0.0.1:${bridge.boundPort}/`, {
      headers: { Origin: "https://example.com" },
    });
    expect(res.status).toBe(403);
  });

  test('a literal "null" Origin is refused with 403', async () => {
    bridge = new LocalBridge({
      port: 0,
      onOutbound: () => {},
      allowedOrigins: ["https://chat.phantomyard.ai"],
    });
    bridge.start();
    const res = await fetch(`http://127.0.0.1:${bridge.boundPort}/`, {
      headers: { Origin: "null" },
    });
    expect(res.status).toBe(403);
  });

  test("the allowed PhantomChat origin passes the gate (426, not 403)", async () => {
    bridge = new LocalBridge({
      port: 0,
      onOutbound: () => {},
      allowedOrigins: ["https://chat.phantomyard.ai"],
    });
    bridge.start();
    const res = await fetch(`http://127.0.0.1:${bridge.boundPort}/`, {
      headers: { Origin: "https://chat.phantomyard.ai" },
    });
    expect(res.status).toBe(426);
  });

  test("a localhost origin passes the gate even when not explicitly listed", async () => {
    bridge = new LocalBridge({ port: 0, onOutbound: () => {}, allowedOrigins: [] });
    bridge.start();
    const res = await fetch(`http://127.0.0.1:${bridge.boundPort}/`, {
      headers: { Origin: "http://localhost:5173" },
    });
    expect(res.status).toBe(426);
  });
});
