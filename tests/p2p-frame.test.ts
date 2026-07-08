/**
 * Wire-frame contract with the PhantomChat PWA. The PWA ships an outgoing
 * message as a Nostr relay frame `["EVENT", <gift-wrap>]`; the node parses it,
 * reads the recipient off the wrap's p-tag, and forwards the sealed wrap. These
 * tests pin that contract — a mismatch silently breaks the Tier-1 path.
 */

import { describe, expect, test } from "bun:test";

import {
  buildEventFrame,
  looksLikeEvent,
  parseEventFrame,
  recipientOfWrap,
  GIFTWRAP_KIND,
} from "../src/p2p/frame.ts";
import type { NTNostrEvent } from "../src/lib/nostrCrypto.ts";

function wrap(overrides: Partial<NTNostrEvent> = {}): NTNostrEvent {
  return {
    id: "a".repeat(64),
    pubkey: "b".repeat(64),
    sig: "c".repeat(128),
    kind: GIFTWRAP_KIND,
    created_at: 1_700_000_000,
    tags: [["p", "d".repeat(64)]],
    content: "sealed",
    ...overrides,
  };
}

describe("p2p frame contract", () => {
  test("build then parse round-trips a gift-wrap", () => {
    const w = wrap();
    const frame = buildEventFrame(w);
    const parsed = parseEventFrame(frame);
    expect(parsed).not.toBeNull();
    expect(parsed!.recipientHex).toBe("d".repeat(64));
    expect(parsed!.wrap.id).toBe(w.id);
  });

  test("recipientOfWrap reads the first p-tag", () => {
    expect(recipientOfWrap(wrap())).toBe("d".repeat(64));
    expect(
      recipientOfWrap(wrap({ tags: [["e", "x"], ["p", "e".repeat(64)]] })),
    ).toBe("e".repeat(64));
    expect(recipientOfWrap(wrap({ tags: [["e", "x"]] }))).toBeNull();
  });

  test("looksLikeEvent guards structure", () => {
    expect(looksLikeEvent(wrap())).toBe(true);
    expect(looksLikeEvent({})).toBe(false);
    expect(looksLikeEvent(null)).toBe(false);
    expect(looksLikeEvent({ ...wrap(), id: 123 })).toBe(false);
  });

  test("parseEventFrame rejects non-EVENT frames and junk", () => {
    expect(parseEventFrame("not json")).toBeNull();
    expect(parseEventFrame(JSON.stringify(["REQ", "sub", {}]))).toBeNull();
    expect(parseEventFrame(JSON.stringify(["CLOSE", "sub"]))).toBeNull();
    expect(parseEventFrame(JSON.stringify(["EVENT"]))).toBeNull();
    expect(parseEventFrame(JSON.stringify(["EVENT", { bad: true }]))).toBeNull();
  });

  test("parseEventFrame rejects a non-gift-wrap kind", () => {
    const frame = buildEventFrame(wrap({ kind: 1 }));
    expect(parseEventFrame(frame)).toBeNull();
  });

  test("parseEventFrame rejects a wrap with no recipient p-tag", () => {
    const frame = buildEventFrame(wrap({ tags: [["e", "x"]] }));
    expect(parseEventFrame(frame)).toBeNull();
  });
});
