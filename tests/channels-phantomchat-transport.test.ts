/**
 * Regression test for the phantomchat relay subscription wire shape.
 *
 * THE BUG (caught while dogfooding on Lena, 2026-06-13): the transport passed
 * `[filter]` (an array) to nostr-tools' `SimplePool.subscribeMany`. But in
 * nostr-tools 2.23.3 that method takes a SINGLE filter OBJECT and groups it
 * into the per-relay `filters` array itself. Passing an array double-wrapped
 * it, so the wire REQ became `["REQ",id,[{...}]]`. Strict relays (primal)
 * rejected it with "provided filter is not an object" and — worse — every
 * relay silently delivered ZERO events, so the bot never received a single DM.
 *
 * This test pins the contract: `subscribeGiftWraps` must hand `subscribeMany`
 * a plain filter OBJECT (kinds 1059, #p = our pubkey), never an array.
 */

import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import {
  SimplePoolPhantomchatTransport,
  type NostrFilter,
  type RelayPool,
} from "../src/channels/phantomchat/transport.ts";
import type { NTNostrEvent } from "../src/lib/nostrCrypto.ts";

describe("phantomchat transport subscription wire shape", () => {
  test("subscribeGiftWraps passes a single filter OBJECT, not an array", () => {
    let captured: unknown;
    const fakePool: RelayPool = {
      subscribeMany(_relays, filter, _params) {
        captured = filter;
        return { close() {} };
      },
      publish() {
        return [];
      },
      close() {},
    };

    const sk = generateSecretKey();
    const transport = new SimplePoolPhantomchatTransport(
      sk,
      ["wss://relay.example"],
      fakePool,
    );

    transport.subscribeGiftWraps(getPublicKey(sk), () => {});

    // The crux: a single object, never an array (the double-wrap bug).
    expect(Array.isArray(captured)).toBe(false);
    expect(typeof captured).toBe("object");
    const f = captured as NostrFilter;
    expect(f.kinds).toEqual([1059]);
    expect(f["#p"]).toEqual([getPublicKey(sk)]);
  });

  test("delivered events reach the onWrap callback", () => {
    let onEvent: ((e: NTNostrEvent) => void) | undefined;
    const fakePool: RelayPool = {
      subscribeMany(_relays, _filter, params) {
        onEvent = params.onevent;
        return { close() {} };
      },
      publish() {
        return [];
      },
      close() {},
    };

    const sk = generateSecretKey();
    const transport = new SimplePoolPhantomchatTransport(
      sk,
      ["wss://relay.example"],
      fakePool,
    );

    const seen: string[] = [];
    transport.subscribeGiftWraps(getPublicKey(sk), (e) => seen.push(e.id));
    onEvent?.({ id: "abc", kind: 1059 } as NTNostrEvent);
    expect(seen).toEqual(["abc"]);
  });
});
