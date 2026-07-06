/**
 * Capability advertisement: the event a node publishes so a peer's PWA can light
 * up its transport ladder. Pins the build/parse contract the phantomchat
 * companion mirrors on ingest.
 */

import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";

import {
  buildCapabilityEvent,
  nodeCapabilities,
  parseCapabilityEvent,
  CAPABILITY_D_TAG,
  CAPABILITY_KIND,
} from "../src/p2p/capability.ts";
import type { NTNostrEvent } from "../src/lib/nostrCrypto.ts";

describe("p2p capability advertisement", () => {
  test("nodeCapabilities advertises localWs + webrtc, never dht", () => {
    const caps = nodeCapabilities(47100);
    expect(caps).toEqual({ localWs: true, localWsPort: 47100, webrtc: true, dht: false });
  });

  test("build then parse round-trips, signed and addressable", () => {
    const sk = generateSecretKey();
    const caps = nodeCapabilities(47100);
    const event = buildCapabilityEvent(sk, caps);

    expect(event.kind).toBe(CAPABILITY_KIND);
    expect(event.tags.some((t) => t[0] === "d" && t[1] === CAPABILITY_D_TAG)).toBe(true);
    expect(verifyEvent(event as never)).toBe(true);

    const parsed = parseCapabilityEvent(event);
    expect(parsed).not.toBeNull();
    expect(parsed!.authorHex).toBe(getPublicKey(sk));
    expect(parsed!.caps).toEqual(caps);
  });

  test("parseCapabilityEvent rejects the wrong kind / missing d-tag / junk", () => {
    const base = { pubkey: "a".repeat(64), created_at: 1, sig: "", id: "" };
    expect(
      parseCapabilityEvent({ ...base, kind: 1, tags: [["d", CAPABILITY_D_TAG]], content: "{}" } as NTNostrEvent),
    ).toBeNull();
    expect(
      parseCapabilityEvent({ ...base, kind: CAPABILITY_KIND, tags: [], content: "{}" } as NTNostrEvent),
    ).toBeNull();
    expect(
      parseCapabilityEvent({
        ...base,
        kind: CAPABILITY_KIND,
        tags: [["d", CAPABILITY_D_TAG]],
        content: "not json",
      } as NTNostrEvent),
    ).toBeNull();
  });

  test("parse coerces missing fields to safe defaults", () => {
    const sk = generateSecretKey();
    const event = buildCapabilityEvent(sk, {
      localWs: true,
      localWsPort: 47100,
      webrtc: true,
      dht: false,
    });
    // Hand-mangle content to drop fields, re-sign not needed (parse ignores sig).
    const mangled = { ...event, content: JSON.stringify({ webrtc: true }) } as NTNostrEvent;
    const parsed = parseCapabilityEvent(mangled);
    expect(parsed!.caps).toEqual({ localWs: false, localWsPort: 0, webrtc: true, dht: false });
  });
});
