/**
 * P2P ↔ phantomchat-channel integration (phantomyard/phantombot#61).
 *
 * Proves the (B) wiring Kai's review demanded: a headless persona actually
 * TERMINATES a conversation over WebRTC instead of advertising a capability it
 * can't honour.
 *
 *   - A gift-wrap arriving over the P2P data channel (fed through ChannelBridge)
 *     runs the SAME ingest as a relay-delivered one and surfaces a turn.
 *   - A message that lands over BOTH transports still runs exactly one turn
 *     (dedup by wrap id) — the relay stays the delivery floor.
 *   - A reply published by the channel is teed to the node's router so it goes
 *     out over WebRTC too.
 *   - The sink is detached on abort so a stopped listener can't be fed.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

import { createPhantomchatChannel } from "../src/channels/phantomchat/channel.ts";
import type { ChannelMessage } from "../src/channels/core/types.ts";
import {
  SimplePoolPhantomchatTransport,
  type NostrFilter,
  type RelayPool,
} from "../src/channels/phantomchat/transport.ts";
import { ChannelBridge } from "../src/p2p/channelBridge.ts";
import { buildEventFrame } from "../src/p2p/frame.ts";
import { wrapNip17Message, type NTNostrEvent } from "../src/lib/nostrCrypto.ts";

const RELAYS = ["wss://a.test", "wss://b.test"];

/** Minimal in-memory pool: subscription EOSEs immediately; `feed` replays. */
class NoopPool implements RelayPool {
  published: NTNostrEvent[] = [];
  private onevent?: (event: NTNostrEvent) => void;

  subscribeMany(
    _relays: string[],
    _filter: NostrFilter,
    params: { onevent: (event: NTNostrEvent) => void; oneose?: () => void },
  ): { close(): void } {
    this.onevent = params.onevent;
    // Go live immediately so the channel's EOSE gate opens.
    setTimeout(() => params.oneose?.(), 0);
    return { close: () => {} };
  }
  /** Deliver a wrap to the live subscription, as a relay push would. */
  feed(event: NTNostrEvent): void {
    this.onevent?.(event);
  }
  publish(_relays: string[], event: NTNostrEvent): Promise<string>[] {
    this.published.push(event);
    return [Promise.resolve("ok")];
  }
  close(_relays: string[]): void {}
}

function setup() {
  const ourSk = generateSecretKey();
  const ourPub = getPublicKey(ourSk);
  const pool = new NoopPool();
  const transport = new SimplePoolPhantomchatTransport(
    ourSk,
    RELAYS,
    pool as unknown as ConstructorParameters<typeof SimplePoolPhantomchatTransport>[2],
  );
  const bridge = new ChannelBridge();
  const channel = createPhantomchatChannel({
    secretKey: ourSk,
    publicKeyHex: ourPub,
    transport,
    inboundSink: bridge,
  });
  return { ourSk, ourPub, pool, transport, bridge, channel };
}

/** A real recipient gift-wrap (kind-1059, p-tagged to `toHex`) from a peer. */
function wrapTextToUs(toHex: string, text: string) {
  const peerSk = generateSecretKey();
  const { wraps } = wrapNip17Message(
    peerSk,
    toHex,
    JSON.stringify({ id: "m1", from: "peer", to: toHex, type: "text", content: text, timestamp: Date.now() }),
  );
  return { peerPub: getPublicKey(peerSk), wrap: wraps[0] as unknown as NTNostrEvent };
}

let abort: AbortController | undefined;
afterEach(() => abort?.abort());

async function drain(channel: ReturnType<typeof setup>["channel"]) {
  abort = new AbortController();
  const got: ChannelMessage[] = [];
  const pump = (async () => {
    for await (const msg of channel.listen!(abort!.signal)) got.push(msg);
  })();
  await new Promise((r) => setTimeout(r, 10)); // let it subscribe + go live
  return { got, pump };
}

/** A fresh, valid x-only pubkey (hex) to use as a wrap recipient. */
function freshHex(): string {
  return getPublicKey(generateSecretKey());
}

describe("ChannelBridge — unit", () => {
  test("broadcast feeds a parsed wrap to the registered sink", () => {
    const bridge = new ChannelBridge();
    const seen: NTNostrEvent[] = [];
    bridge.setSink((e) => { seen.push(e); });
    const { wrap } = wrapTextToUs(freshHex(), "hi");

    expect(bridge.broadcast(buildEventFrame(wrap))).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.id).toBe(wrap.id);
    expect(bridge.clientCount()).toBe(1);
  });

  test("broadcast is a no-op without a sink or on a malformed frame", () => {
    const bridge = new ChannelBridge();
    expect(bridge.broadcast("not json")).toBe(0);
    expect(bridge.clientCount()).toBe(0);

    const seen: NTNostrEvent[] = [];
    bridge.setSink((e) => { seen.push(e); });
    expect(bridge.broadcast('["REQ","sub"]')).toBe(0); // not an EVENT frame
    expect(seen).toHaveLength(0);

    bridge.setSink(null); // detach
    const { wrap } = wrapTextToUs(freshHex(), "hi");
    expect(bridge.broadcast(buildEventFrame(wrap))).toBe(0);
  });

  test("routeOutbound frames the wrap and hands it to the node router", () => {
    const bridge = new ChannelBridge();
    const routed: { recipientHex: string; raw: string }[] = [];
    bridge.setRouter((frame, raw) => routed.push({ recipientHex: frame.recipientHex, raw }));
    const to = freshHex();
    const { wrap } = wrapTextToUs(to, "reply");

    bridge.routeOutbound(wrap);
    expect(routed).toHaveLength(1);
    expect(routed[0]!.recipientHex).toBe(to);
    expect(routed[0]!.raw).toBe(buildEventFrame(wrap));
  });

  test("routeOutbound is a safe no-op before the router is wired", () => {
    const bridge = new ChannelBridge();
    const { wrap } = wrapTextToUs(freshHex(), "reply");
    expect(() => bridge.routeOutbound(wrap)).not.toThrow();
  });
});

describe("P2P inbound terminates in the channel", () => {
  test("a gift-wrap fed over the bridge surfaces a turn", async () => {
    const { ourPub, bridge, channel } = setup();
    const { got, pump } = await drain(channel);

    const { wrap } = wrapTextToUs(ourPub, "hello over webrtc");
    bridge.broadcast(buildEventFrame(wrap));

    await new Promise((r) => setTimeout(r, 30));
    abort!.abort();
    await pump;

    expect(got.map((m) => m.text)).toEqual(["hello over webrtc"]);
  });

  test("the same message over relay AND WebRTC runs exactly one turn (dedup)", async () => {
    const { ourPub, pool, bridge, channel } = setup();
    const { got, pump } = await drain(channel);

    const { wrap } = wrapTextToUs(ourPub, "only once");
    // Arrives over both transports — relay push and a direct WebRTC frame.
    pool.feed(wrap);
    bridge.broadcast(buildEventFrame(wrap));

    await new Promise((r) => setTimeout(r, 30));
    abort!.abort();
    await pump;

    expect(got.map((m) => m.text)).toEqual(["only once"]);
  });

  test("the sink is detached after abort — a late frame is dropped", async () => {
    const { ourPub, bridge, channel } = setup();
    const { got, pump } = await drain(channel);
    abort!.abort();
    await pump;

    // Listener is gone; a straggler WebRTC frame must not be ingested or throw.
    const { wrap } = wrapTextToUs(ourPub, "too late");
    expect(bridge.broadcast(buildEventFrame(wrap))).toBe(0);
    expect(got).toHaveLength(0);
  });
});

describe("P2P outbound tee", () => {
  test("publishWrap tees the event to the bridge router", async () => {
    const { transport, bridge } = setup();
    const routed: NTNostrEvent[] = [];
    bridge.setRouter((frame) => routed.push(frame.wrap));
    transport.setPublishObserver((e) => bridge.routeOutbound(e));

    const { wrap } = wrapTextToUs(freshHex(), "a reply");
    await transport.publishWrap(wrap);

    expect(routed).toHaveLength(1);
    expect(routed[0]!.id).toBe(wrap.id);
  });
});
