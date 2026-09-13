/**
 * Regression tests for "every send waits for the slowest relay".
 *
 * THE BUG: publishWrap did `await Promise.allSettled(pool.publish(...))`, so a
 * send only returned once EVERY relay had accepted or timed out. One slow or
 * dead relay cost each message its full connect + ack timeout (~7.4s, ~16s
 * with a NIP-42 retry) — even while a P2P link was up — and a multi-bubble
 * reply stacked that per bubble.
 *
 * What these pin:
 *   1. A send returns on the FIRST relay accept; a hung relay doesn't hold it.
 *   2. flush() still waits for the background relays (one-shot callers).
 *   3. nostr-tools RESOLVES an unreachable relay with "connection failure: …";
 *      that must not count as an accept.
 *   4. A P2P receipt from the recipient returns the send while relays are
 *      still pending.
 */

import { describe, expect, test } from "bun:test";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";

import {
  SimplePoolPhantomchatTransport,
  isRelayConnectionFailure,
  type RelayPool,
} from "../src/channels/phantomchat/transport.ts";
import type { NTNostrEvent } from "../src/lib/nostrCrypto.ts";

const RELAYS = ["wss://fast.example", "wss://slow.example", "wss://third.example"];

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function wrap(sk: Uint8Array): NTNostrEvent {
  return finalizeEvent(
    { kind: 1059, created_at: Math.floor(Date.now() / 1000), tags: [], content: "x" },
    sk,
  ) as unknown as NTNostrEvent;
}

function poolWith(results: () => Promise<string>[]): RelayPool {
  return {
    subscribeMany() { return { close() {} }; },
    publish() { return results(); },
    close() {},
  };
}

/** Resolves to "done" if `p` settles within `ms`, else "pending". */
async function within(p: Promise<unknown>, ms: number): Promise<"done" | "pending"> {
  return Promise.race([
    p.then(() => "done" as const),
    new Promise<"pending">((r) => setTimeout(() => r("pending"), ms)),
  ]);
}

describe("publishWrap returns without waiting for the slowest relay", () => {
  test("returns on the first accept while another relay hangs; flush waits for it", async () => {
    const slow = deferred<string>();
    const hung = deferred<string>();
    const sk = generateSecretKey();
    const t = new SimplePoolPhantomchatTransport(
      sk, RELAYS, poolWith(() => [Promise.resolve(""), slow.promise, hung.promise]),
    );
    expect(await within(t.publishWrap(wrap(sk)), 200)).toBe("done");

    const flushed = t.flush();
    expect(await within(flushed, 50)).toBe("pending");
    slow.resolve("");
    hung.resolve("");
    expect(await within(flushed, 200)).toBe("done");
    t.close();
  });

  test("a 'connection failure' resolution is NOT an accept", async () => {
    expect(isRelayConnectionFailure("connection failure: timed out")).toBe(true);
    expect(isRelayConnectionFailure("")).toBe(false);

    const sk = generateSecretKey();
    const ack = deferred<boolean>();
    const t = new SimplePoolPhantomchatTransport(
      sk, RELAYS,
      poolWith(() => RELAYS.map(() => Promise.resolve("connection failure: refused"))),
    );
    t.setPublishObserver(() => ack.promise);
    const sent = t.publishWrap(wrap(sk));
    // Every relay "resolved" — but as failures, so the send must still be
    // waiting on the only real delivery path left: the P2P receipt.
    expect(await within(sent, 80)).toBe("pending");
    ack.resolve(true);
    expect(await within(sent, 200)).toBe("done");
    t.close();
  });

  test("a P2P receipt returns the send while every relay is still pending", async () => {
    const sk = generateSecretKey();
    const pending = RELAYS.map(() => deferred<string>());
    const t = new SimplePoolPhantomchatTransport(
      sk, RELAYS, poolWith(() => pending.map((d) => d.promise)),
    );
    t.setPublishObserver(() => Promise.resolve(true));
    expect(await within(t.publishWrap(wrap(sk)), 200)).toBe("done");
    for (const d of pending) d.resolve("");
    await t.flush();
    t.close();
  });

  test("with no P2P receipt and relays pending, the send waits for a relay", async () => {
    const sk = generateSecretKey();
    const pending = RELAYS.map(() => deferred<string>());
    const t = new SimplePoolPhantomchatTransport(
      sk, RELAYS, poolWith(() => pending.map((d) => d.promise)),
    );
    t.setPublishObserver(() => Promise.resolve(false));
    const sent = t.publishWrap(wrap(sk));
    expect(await within(sent, 80)).toBe("pending");
    pending[2]!.resolve("");
    expect(await within(sent, 200)).toBe("done");
    for (const d of pending) d.resolve("");
    await t.flush();
    t.close();
  });

  test("every relay failing still returns (never hangs, never rejects)", async () => {
    const sk = generateSecretKey();
    const t = new SimplePoolPhantomchatTransport(
      sk, RELAYS, poolWith(() => RELAYS.map(() => Promise.reject(new Error("publish timed out")))),
    );
    expect(await within(t.publishWrap(wrap(sk)), 200)).toBe("done");
    t.close();
  });

  test("accept latency feeds relay health", async () => {
    const sk = generateSecretKey();
    const t = new SimplePoolPhantomchatTransport(
      sk, RELAYS, poolWith(() => RELAYS.map(() => Promise.resolve(""))),
    );
    await t.publishWrap(wrap(sk));
    await t.flush();
    const samples = t.relayHealth.report().map((r) => r.acceptSamples);
    expect(samples).toEqual([1, 1, 1]);
    t.close();
  });
});
