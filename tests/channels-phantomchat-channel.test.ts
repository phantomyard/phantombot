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
import type { ChannelMessage } from "../src/channels/core/types.ts";
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

describe("phantomchat channel — presence dropped", () => {
  test("a presence ping is silently dropped — no pong, no chat message", async () => {
    // Presence was removed: the channel no longer pongs (or shows status). A
    // stale ping from a not-yet-updated client must be discarded, never spawn a
    // turn, and never publish a pong.
    const { ourPub, pool, channel } = setup();
    const ac = new AbortController();

    const received: string[] = [];
    const pump = (async () => {
      for await (const msg of channel.listen!(ac.signal)) received.push(msg.text);
    })();

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

    // No pong published, no chat message surfaced.
    expect(pool.published.length).toBe(0);
    expect(received.length).toBe(0);
  });
});

describe("phantomchat channel — delivery receipt plumbing", () => {
  test("a live DM text surfaces a turn carrying the envelope id as messageId", async () => {
    const { ourPub, pool, channel } = setup();
    const ac = new AbortController();

    const got: ChannelMessage[] = [];
    const pump = (async () => {
      for await (const msg of channel.listen!(ac.signal)) got.push(msg);
    })();

    await new Promise((r) => setTimeout(r, 10));

    const { wrap } = wrapEnvelopeToUs(ourPub, {
      id: "chat-42-0", // app message id the PWA's DeliveryTracker keys on
      from: "peer",
      to: ourPub,
      type: "text",
      content: "hello lena",
      timestamp: Date.now(),
    });
    pool.feed(wrap);

    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    await pump;

    // The DM surfaces with the app message id plumbed through, so the SERVER
    // can receipt it after the auth gate. The channel itself receipts nothing
    // (gating belongs to the server — strangers must be dropped silently).
    expect(got.length).toBe(1);
    expect(got[0]!.text).toBe("hello lena");
    expect(got[0]!.messageId).toBe("chat-42-0");
    expect(pool.published.length).toBe(0);
  });

  test("a pre-EOSE (backlog) DM text yields no turn", async () => {
    const { ourPub, pool, channel } = setup({ autoEose: false });
    const ac = new AbortController();
    const got: ChannelMessage[] = [];
    const pump = (async () => {
      for await (const msg of channel.listen!(ac.signal)) got.push(msg);
    })();
    await new Promise((r) => setTimeout(r, 10));

    const { wrap } = wrapEnvelopeToUs(ourPub, {
      id: "chat-99-0",
      from: "peer",
      to: ourPub,
      type: "text",
      content: "backlog",
      timestamp: Date.now(),
    });
    pool.feed(wrap);

    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    await pump;

    // Live-gate closed → no turn surfaces, so the server never receipts it.
    expect(got.length).toBe(0);
    expect(pool.published.length).toBe(0);
  });
});

describe("phantomchat channel — NIP-17 dual-read (plain text)", () => {
  test("a live plain-text rumor (no envelope) surfaces a turn keyed by the rumor id", async () => {
    const { ourPub, pool, channel } = setup();
    const ac = new AbortController();
    const got: ChannelMessage[] = [];
    const pump = (async () => {
      for await (const msg of channel.listen!(ac.signal)) got.push(msg);
    })();
    await new Promise((r) => setTimeout(r, 10));

    // Standard NIP-17: the rumor content IS the plain text (what 0xchat and the
    // aligned PWA send) — no JSON envelope.
    const peerSk = generateSecretKey();
    const { wraps, rumorId } = wrapNip17Message(peerSk, ourPub, "hello from 0xchat");
    pool.feed(wraps[0] as unknown as NTNostrEvent);

    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    await pump;

    expect(got.length).toBe(1);
    expect(got[0]!.text).toBe("hello from 0xchat");
    expect(got[0]!.messageId).toBe(rumorId); // receipts/edits key off the rumor id
    expect(pool.published.length).toBe(0);
  });

  test("an empty-content rumor (e.g. a delivery receipt) yields no turn", async () => {
    const { ourPub, pool, channel } = setup();
    const ac = new AbortController();
    const got: ChannelMessage[] = [];
    const pump = (async () => {
      for await (const msg of channel.listen!(ac.signal)) got.push(msg);
    })();
    await new Promise((r) => setTimeout(r, 10));

    const peerSk = generateSecretKey();
    const { wraps } = wrapNip17Message(peerSk, ourPub, "");
    pool.feed(wraps[0] as unknown as NTNostrEvent);

    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    await pump;

    expect(got.length).toBe(0);
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

/**
 * A pool whose FIRST subscribeMany is the long-lived live subscription and whose
 * SUBSEQUENT calls are catch-up-poll fetches that replay `fetchQueue` then EOSE.
 * It deliberately NEVER pushes anything to the live subscription, modelling the
 * ghost bug: a wrap that persists on the relay but the live push dropped. Only
 * the poll can recover it.
 */
class PollOnlyPool implements RelayPool {
  fetchQueue: NTNostrEvent[] = [];
  private calls = 0;
  private connected = new Map<string, boolean>();
  constructor(relays: string[]) {
    for (const r of relays) this.connected.set(r, true);
  }
  subscribeMany(
    _relays: string[],
    _filter: NostrFilter,
    params: { onevent: (event: NTNostrEvent) => void; oneose?: () => void },
  ): { close(): void } {
    this.calls++;
    if (this.calls === 1) {
      // Live subscription: go live immediately, but NEVER push any event.
      params.oneose?.();
      return { close: () => {} };
    }
    // Catch-up poll fetch: replay the queued wraps, then signal EOSE.
    for (const e of this.fetchQueue) params.onevent(e);
    params.oneose?.();
    return { close: () => {} };
  }
  publish(_relays: string[], _event: NTNostrEvent): Promise<string>[] {
    return [Promise.resolve("ok")];
  }
  listConnectionStatus(): Map<string, boolean> {
    return this.connected;
  }
  close(_relays: string[]): void {}
}

describe("phantomchat channel — catch-up poll", () => {
  test("delivers a message the live push dropped, recovered only via the poll", async () => {
    const ourSk = generateSecretKey();
    const ourPub = getPublicKey(ourSk);
    const pool = new PollOnlyPool(RELAYS);
    const transport = new SimplePoolPhantomchatTransport(
      ourSk,
      RELAYS,
      pool as unknown as ConstructorParameters<
        typeof SimplePoolPhantomchatTransport
      >[2],
    );
    const channel = createPhantomchatChannel({
      secretKey: ourSk,
      publicKeyHex: ourPub,
      transport,
      healCheckMs: 100_000, // keep the watchdog out of this test
      backfillPollMs: 20, // fire the poll quickly
    });

    // Queue a real text message that will ONLY ever arrive via the poll.
    const { wrap } = wrapEnvelopeToUs(ourPub, {
      id: "msg-poll-1",
      from: "peer",
      to: ourPub,
      type: "text",
      content: "recovered by poll",
      timestamp: Date.now(),
    });
    pool.fetchQueue = [wrap];

    const ac = new AbortController();
    const received: string[] = [];
    const pump = (async () => {
      for await (const msg of channel.listen!(ac.signal)) received.push(msg.text);
    })();

    // Wait past a couple of poll intervals.
    await new Promise((r) => setTimeout(r, 80));
    ac.abort();
    await pump;

    expect(received).toContain("recovered by poll");
  });
});

describe("phantomchat channel — voice / media intake", () => {
  test("a DM voice envelope (metadata JSON in content) surfaces as media, not raw JSON", async () => {
    const { ourPub, pool, channel } = setup();
    const ac = new AbortController();

    const got: ChannelMessage[] = [];
    const pump = (async () => {
      for await (const msg of channel.listen!(ac.signal)) got.push(msg);
    })();

    await new Promise((r) => setTimeout(r, 10));

    // Real DM wire shape (chat-api.sendFileMessage → sendMessage): a typed
    // envelope whose `content` is the file-metadata JSON STRING (key/iv).
    const fileMeta = {
      url: "https://nostr.download/b8447b96c67839dc9aa4632408a0d35375",
      sha256: "b8447b96c67839dc9aa4632408a0d35375ad6d9c0f42ee6057a5be47eb074b03",
      mimeType: "audio/ogg",
      size: 26050,
      key: "2d3574e50d989038d2b377601485960210a2f381068a49446b40f2e754f9adb8",
      iv: "7bab87dee86e940684b2ff88",
      mediaType: "voice",
      duration: 9,
      waveform: [0, 0, 8, 255, 255],
      servers: [
        "https://nostr.download/b8447b96c67839dc9aa4632408a0d35375",
        "https://blossom.ditto.pub/b8447b96c67839dc9aa4632408a0d35375",
      ],
    };
    const { wrap } = wrapEnvelopeToUs(ourPub, {
      id: "chat-99-0",
      from: "peer",
      to: ourPub,
      type: "voice",
      content: JSON.stringify(fileMeta),
      timestamp: Date.now(),
    });
    pool.feed(wrap);

    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    await pump;

    expect(got.length).toBe(1);
    const m = got[0]!;
    // Surfaced as MEDIA (so the server transcribes), NOT a turn over the JSON.
    expect(m.text).toBe(""); // bare voice note has no caption
    expect(m.media).toBeDefined();
    expect(m.media!.kind).toBe("voice");
    expect(m.media!.url).toBe(fileMeta.url);
    expect(m.media!.sha256).toBe(fileMeta.sha256);
    expect(m.media!.keyHex).toBe(fileMeta.key); // accepts `key`
    expect(m.media!.ivHex).toBe(fileMeta.iv); // accepts `iv`
    expect(m.media!.mimeType).toBe("audio/ogg");
    expect(m.media!.durationS).toBe(9);
    // Multi-mirror list plumbed through for receive multi-GET (#88 bot half).
    expect(m.media!.servers).toEqual(fileMeta.servers);
    // Receipt keyed off the envelope's app id (PWA file delivery tracker).
    expect(m.messageId).toBe("chat-99-0");
  });
});

describe("phantomchat channel — attachment (non-voice) intake", () => {
  test("a group image envelope (fileMetadata object + caption) surfaces as media", async () => {
    const { ourPub, pool, channel } = setup();
    const ac = new AbortController();
    const got: ChannelMessage[] = [];
    const pump = (async () => {
      for await (const msg of channel.listen!(ac.signal)) got.push(msg);
    })();
    await new Promise((r) => setTimeout(r, 10));

    // Real group wire shape (GroupAPI.sendFile): `fileMetadata` OBJECT
    // (keyHex/ivHex), with the caption in `content`.
    const { wrap } = wrapEnvelopeToUs(ourPub, {
      id: "grp-123-abc",
      type: "image",
      content: "check this out",
      timestamp: Date.now(),
      fileMetadata: {
        url: "https://nostr.download/deadbeefimg",
        sha256: "deadbeef00000000000000000000000000000000000000000000000000000000",
        mimeType: "image/jpeg",
        size: 845123,
        keyHex: "11".repeat(32),
        ivHex: "22".repeat(12),
        width: 1200,
        height: 800,
        servers: [
          "https://nostr.download/deadbeefimg",
          "https://blossom.data.haus/deadbeefimg",
        ],
      },
    });
    pool.feed(wrap);

    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    await pump;

    expect(got.length).toBe(1);
    const m = got[0]!;
    expect(m.text).toBe("check this out"); // caption preserved
    expect(m.media?.kind).toBe("image");
    expect(m.media?.url).toBe("https://nostr.download/deadbeefimg");
    expect(m.media?.keyHex).toBe("11".repeat(32)); // accepts `keyHex`
    expect(m.media?.ivHex).toBe("22".repeat(12));
    expect(m.media?.size).toBe(845123);
    expect(m.media?.servers).toEqual([
      "https://nostr.download/deadbeefimg",
      "https://blossom.data.haus/deadbeefimg",
    ]);
  });
});
