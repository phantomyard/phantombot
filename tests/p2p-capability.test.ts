/**
 * Capability advertisement: the event a node publishes so a peer's PWA can light
 * up its WebRTC transport. Pins the build/parse contract the phantomchat
 * companion mirrors on ingest.
 *
 * Post-#61 the advert is a single PLAINTEXT `{ webrtc: true }` boolean. The
 * former localhost (`localWs`/`localWsPort`) and `dht` fields were removed —
 * there is exactly one direct transport, WebRTC, NAT-traversed via ICE. The
 * boolean is public because a contact must read it before any encrypted channel
 * exists; nothing here is a secret.
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
  test("nodeCapabilities advertises webrtc only", () => {
    expect(nodeCapabilities()).toEqual({ webrtc: true });
  });

  test("build then parse round-trips webrtc, signed and addressable", () => {
    const sk = generateSecretKey();
    const event = buildCapabilityEvent(sk);

    expect(event.kind).toBe(CAPABILITY_KIND);
    expect(event.tags.some((t) => t[0] === "d" && t[1] === CAPABILITY_D_TAG)).toBe(true);
    expect(verifyEvent(event as never)).toBe(true);

    const parsed = parseCapabilityEvent(event);
    expect(parsed).not.toBeNull();
    expect(parsed!.authorHex).toBe(getPublicKey(sk));
    expect(parsed!.caps).toEqual({ webrtc: true });
  });

  test("the advert is PLAINTEXT on the wire (no encryption) — a contact reads it", () => {
    const sk = generateSecretKey();
    const contactSk = generateSecretKey();
    const event = buildCapabilityEvent(sk);

    // The capability boolean is public — not a secret. No `enc` blob.
    const plain = JSON.parse(event.content) as Record<string, unknown>;
    expect(plain.webrtc).toBe(true);
    expect(plain.enc).toBeUndefined();

    // A different key parses it just fine — no key material needed.
    const parsed = parseCapabilityEvent(event);
    expect(parsed!.caps.webrtc).toBe(true);
    void contactSk;
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

  test("parse coerces a missing webrtc flag to false", () => {
    const sk = generateSecretKey();
    const event = buildCapabilityEvent(sk);
    const mangled = { ...event, content: JSON.stringify({}) } as NTNostrEvent;
    const parsed = parseCapabilityEvent(mangled);
    expect(parsed!.caps).toEqual({ webrtc: false });
  });

  test("parse ignores retired localWs/localWsPort/dht fields on a legacy advert", () => {
    const sk = generateSecretKey();
    const event = buildCapabilityEvent(sk);
    const legacy = {
      ...event,
      content: JSON.stringify({ localWs: true, localWsPort: 33297, webrtc: true, dht: false }),
    } as NTNostrEvent;
    const parsed = parseCapabilityEvent(legacy);
    expect(parsed!.caps).toEqual({ webrtc: true });
  });
});
