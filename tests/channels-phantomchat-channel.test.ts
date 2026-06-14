/**
 * Tests for the phantomchat Channel adapter's NEW receive-side behaviours:
 *
 *  1. PRESENCE PING → PONG. A live gift-wrapped `{type:"presence-ping", nonce}`
 *     is answered with a gift-wrapped `{type:"presence-pong", nonce}` to the
 *     pinger — echoing the nonce — and does NOT produce a chat message in the
 *     listen() stream. A PRE-EOSE (backlog) ping is NOT ponged.
 *
 *  2. SELF-HEAL WATCHDOG. When the pool reports fewer connected relays than
 *     configured, the watchdog re-arms the gift-wrap subscription (a fresh
 *     subscribeMany), recovering from a hard relay drop.
 */

import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

import { createPhantomchatChannel } from "../src/channels/phantomchat/channel.ts";
import {
  SimplePoolPhantomchatTransport,
  type NostrFilter,
  type RelayPool,
} from "../src/channels/phantomchat/transport.ts";
import {
  wrapNip17Message,
  type NTNostrEvent,
} from "../src/lib/nostrCrypto.ts";

/**
 * In-memory pool with optional connection-status control. `feed` delivers a
 * wrap to the live subscription; `subscribeCount` tracks re-arms; EOSE can be
 * deferred so a pre-EOSE (backlog) path is testable.
 */
class FakePool implements RelayPool {
  published: NTNostrEvent[] = [];
  subscribeCount = 0;
  private onevent?: (event: NTNostrEvent) => void;
  private connected = new Map<string, boolean>();

  constructor(
    relays: string[],
    private readonly opts: { autoEose?: boolean } = { autoEose: true },
  ) {
    for (const r of relays) this.connected.set(r, true);
  }

  subscribeMany(
    _relays: string[],
    _filter: NostrFilter,
    params: { onevent: (event: NTNostrEvent) => void; oneose?: () => void },
  ): { close(): void } {
    this.subscribeCount++;
    this.onevent = params.onevent;
    if (this.opts.autoEose !== false) params.oneose?.();
    return {
      close: () => {
        this.onevent = undefined;
      },
    };
  }

  publish(_relays: string[], event: NTNostrEvent): Promise<string>[] {
    this.published.push(event);
    return [Promise.resolve("ok")];
  }

  listConnectionStatus(): Map<string, boolean> {
    return this.connected;
  }

  close(_relays: string[]): void {}

  feed(event: NTNostrEvent): void {
    this.onevent?.(event);
  }

  /** Simulate a relay hard-dropping (deleted from the pool / disconnected). */
  dropRelay(url: string): void {
    this.connected.set(url, false);
  }
}

const RELAYS = ["wss://a.test", "wss://b.test"];

function setup(opts?: { autoEose?: boolean; healCheckMs?: number }) {
  const ourSk = generateSecretKey();
  const ourPub = getPublicKey(ourSk);
  const pool = new FakePool(RELAYS, { autoEose: opts?.autoEose ?? true });
  const transport = new SimplePoolPhantomchatTransport(
    ourSk,
    RELAYS,
    pool as unknown as ConstructorParameters<typeof SimplePoolPhantomchatTransport>[2],
  );
  const channel = createPhantomchatChannel({
    secretKey: ourSk,
    publicKeyHex: ourPub,
    transport,
    healCheckMs: opts?.healCheckMs,
  });
  return { ourSk, ourPub, pool, transport, channel };
}

/** Build a gift-wrap from a fresh peer to `toHex` carrying `envelope`. */
function wrapEnvelopeToUs(toHex: string, envelope: object) {
  const peerSk = generateSecretKey();
  const { wraps } = wrapNip17Message(peerSk, toHex, JSON.stringify(envelope));
  // wraps[0] is the recipient (us) wrap.
  return { peerPub: getPublicKey(peerSk), wrap: wraps[0] as unknown as NTNostrEvent };
}

describe("phantomchat channel — presence ping/pong", () => {
  test("a live ping is answered with a nonce-echoing pong, no chat message", async () => {
    const { ourPub, pool, channel } = setup();
    const ac = new AbortController();

    const received: string[] = [];
    const pump = (async () => {
      for await (const msg of channel.listen!(ac.signal)) received.push(msg.text);
    })();

    // Give listen() a tick to subscribe + open the live-gate (auto-EOSE).
    await new Promise((r) => setTimeout(r, 10));

    const { wrap } = wrapEnvelopeToUs(ourPub, {
      id: "x",
      from: "peer",
      to: ourPub,
      type: "presence-ping",
      nonce: "nonce-abc-123",
      content: "",
      timestamp: Date.now(),
    });
    pool.feed(wrap);

    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    await pump;

    // The pong is addressed (gift-wrapped) to the pinger, so we can't unwrap it
    // here without the peer's key. Assert at the wire level: exactly one wrap
    // published, it's a kind-1059 gift-wrap (the pong), and NO chat message
    // surfaced in the listen() stream (a ping must never spawn a turn).
    expect(pool.published.length).toBe(1);
    expect(pool.published[0]!.kind).toBe(1059);
    expect(received.length).toBe(0);
  });

  test("a pre-EOSE (backlog) ping is NOT ponged", async () => {
    const { ourPub, pool, channel } = setup({ autoEose: false });
    const ac = new AbortController();
    const pump = (async () => {
      for await (const _ of channel.listen!(ac.signal)) { /* drain */ }
    })();
    await new Promise((r) => setTimeout(r, 10));

    const peerSk = generateSecretKey();
    const { wraps } = wrapNip17Message(
      peerSk,
      ourPub,
      JSON.stringify({
        id: "x",
        from: getPublicKey(peerSk),
        to: ourPub,
        type: "presence-ping",
        nonce: "stale",
        content: "",
        timestamp: Date.now(),
      }),
    );
    pool.feed(wraps[0] as unknown as NTNostrEvent);

    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    await pump;

    // No EOSE ever fired → live-gate closed → backlog ping ignored, no pong.
    expect(pool.published.length).toBe(0);
  });
});

describe("phantomchat channel — self-heal watchdog", () => {
  test("re-arms the subscription when a relay drops", async () => {
    const { pool, channel } = setup({ healCheckMs: 10 });
    const ac = new AbortController();
    const pump = (async () => {
      for await (const _ of channel.listen!(ac.signal)) { /* drain */ }
    })();

    await new Promise((r) => setTimeout(r, 15));
    expect(pool.subscribeCount).toBe(1); // initial arm, all relays healthy

    // A relay hard-drops → watchdog should re-arm on its next tick.
    pool.dropRelay("wss://b.test");
    await new Promise((r) => setTimeout(r, 40));

    ac.abort();
    await pump;

    expect(pool.subscribeCount).toBeGreaterThan(1);
  });

  test("does not re-arm while all relays stay connected", async () => {
    const { pool, channel } = setup({ healCheckMs: 10 });
    const ac = new AbortController();
    const pump = (async () => {
      for await (const _ of channel.listen!(ac.signal)) { /* drain */ }
    })();

    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    await pump;

    expect(pool.subscribeCount).toBe(1);
  });
});
