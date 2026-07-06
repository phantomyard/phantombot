/**
 * Nostr signaling: SDP/ICE exchange over an encrypted ephemeral event kind,
 * separate from the chat gift-wrap plane. Real NIP-44 crypto; the relay pool is
 * an in-memory fake so no sockets are touched.
 */

import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

import {
  NostrSignaling,
  decodeSignal,
  encodeSignal,
  isSignalMessage,
  NOSTR_KIND_P2P_SIGNAL,
  type SignalMessage,
} from "../src/p2p/signaling.ts";
import type { NostrFilter, RelayPool } from "../src/channels/phantomchat/transport.ts";
import type { NTNostrEvent } from "../src/lib/nostrCrypto.ts";

describe("p2p signaling crypto", () => {
  test("encode → decode round-trips each signal type between two nodes", () => {
    const aSk = generateSecretKey();
    const bSk = generateSecretKey();
    const bHex = getPublicKey(bSk);
    const aHex = getPublicKey(aSk);

    const messages: SignalMessage[] = [
      { t: "offer", sdp: "v=0\r\no=- offer" },
      { t: "answer", sdp: "v=0\r\no=- answer" },
      { t: "candidate", candidate: "candidate:1 1 udp ...", sdpMid: "0", sdpMLineIndex: 0 },
      { t: "hello" },
      { t: "bye" },
    ];

    for (const msg of messages) {
      const event = encodeSignal(aSk, bHex, msg);
      expect(event.kind).toBe(NOSTR_KIND_P2P_SIGNAL);
      expect(event.tags).toContainEqual(["p", bHex]);
      // B decodes it and learns A is the sender.
      const decoded = decodeSignal(bSk, event);
      expect(decoded).not.toBeNull();
      expect(decoded!.senderHex).toBe(aHex);
      expect(decoded!.msg).toEqual(msg);
    }
  });

  test("a third party cannot decrypt a signal", () => {
    const aSk = generateSecretKey();
    const bSk = generateSecretKey();
    const eveSk = generateSecretKey();
    const event = encodeSignal(aSk, getPublicKey(bSk), { t: "offer", sdp: "secret" });
    expect(decodeSignal(eveSk, event)).toBeNull();
  });

  test("decodeSignal rejects a wrong kind and malformed payload", () => {
    const aSk = generateSecretKey();
    const bSk = generateSecretKey();
    const good = encodeSignal(aSk, getPublicKey(bSk), { t: "offer", sdp: "x" });
    expect(decodeSignal(bSk, { ...good, kind: 1 })).toBeNull();
    expect(decodeSignal(bSk, { ...good, content: "garbage" })).toBeNull();
  });

  test("isSignalMessage validates shape", () => {
    expect(isSignalMessage({ t: "offer", sdp: "x" })).toBe(true);
    expect(isSignalMessage({ t: "candidate", candidate: "x" })).toBe(true);
    expect(isSignalMessage({ t: "hello" })).toBe(true);
    expect(isSignalMessage({ t: "offer" })).toBe(false);
    expect(isSignalMessage({ t: "nope" })).toBe(false);
    expect(isSignalMessage(null)).toBe(false);
  });
});

describe("NostrSignaling over the relay-pool seam", () => {
  function fakePool() {
    const published: NTNostrEvent[] = [];
    let onevent: ((e: NTNostrEvent) => void) | undefined;
    let capturedFilter: NostrFilter | undefined;
    const pool: RelayPool = {
      subscribeMany(_relays, filter, params) {
        capturedFilter = filter;
        onevent = params.onevent;
        return { close() {} };
      },
      publish(_relays, event) {
        published.push(event);
        return [Promise.resolve("ok")];
      },
      close() {},
    };
    return {
      pool,
      published,
      emit: (e: NTNostrEvent) => onevent?.(e),
      filter: () => capturedFilter,
    };
  }

  test("subscribes with the signal kind + our p-tag, single filter object", () => {
    const sk = generateSecretKey();
    const f = fakePool();
    const sig = new NostrSignaling(sk, ["wss://r"], f.pool);
    sig.start();
    const filter = f.filter()!;
    expect(Array.isArray(filter)).toBe(false);
    expect(filter.kinds).toEqual([NOSTR_KIND_P2P_SIGNAL]);
    expect(filter["#p"]).toEqual([getPublicKey(sk)]);
  });

  test("send publishes an encrypted event the peer can decode", async () => {
    const aSk = generateSecretKey();
    const bSk = generateSecretKey();
    const f = fakePool();
    const sig = new NostrSignaling(aSk, ["wss://r"], f.pool);
    await sig.send(getPublicKey(bSk), { t: "offer", sdp: "hello-sdp" });
    expect(f.published).toHaveLength(1);
    const decoded = decodeSignal(bSk, f.published[0]!);
    expect(decoded!.msg).toEqual({ t: "offer", sdp: "hello-sdp" });
  });

  test("inbound events reach the handler, deduped by id", () => {
    const aSk = generateSecretKey();
    const bSk = generateSecretKey();
    const f = fakePool();
    const bSig = new NostrSignaling(bSk, ["wss://r"], f.pool);
    const got: { senderHex: string; msg: SignalMessage }[] = [];
    bSig.onMessage((senderHex, msg) => got.push({ senderHex, msg }));
    bSig.start();

    const event = encodeSignal(aSk, getPublicKey(bSk), { t: "candidate", candidate: "c" });
    f.emit(event);
    f.emit(event); // duplicate delivery from a second relay
    expect(got).toHaveLength(1);
    expect(got[0]!.senderHex).toBe(getPublicKey(aSk));
    expect(got[0]!.msg).toEqual({ t: "candidate", candidate: "c" });
  });

  test("undecryptable inbound events are ignored, not thrown", () => {
    const bSk = generateSecretKey();
    const eveSk = generateSecretKey();
    const otherSk = generateSecretKey();
    const f = fakePool();
    const bSig = new NostrSignaling(bSk, ["wss://r"], f.pool);
    let calls = 0;
    bSig.onMessage(() => calls++);
    bSig.start();
    // Encrypted to someone else — B can't decode it.
    f.emit(encodeSignal(eveSk, getPublicKey(otherSk), { t: "bye" }));
    expect(calls).toBe(0);
  });
});
