/**
 * Capability advertisement: the event a node publishes so a peer's PWA can light
 * up its transport ladder. Pins the build/parse contract the phantomchat
 * companion mirrors on ingest.
 *
 * The advert is PLAINTEXT: capability booleans + the ACTUAL bound loopback port.
 * A loopback port bound to 127.0.0.1 is reachable only from this machine, so it
 * is not a secret; publishing it plaintext is what lets a same-machine PWA (a
 * DIFFERENT identity than the node) discover the port and dial `ws://localhost`.
 * LAN IPs are intentionally not advertised — ICE discovers LAN host candidates
 * live on the node↔node WebRTC path.
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
  test("nodeCapabilities advertises localWs + bound port + webrtc, never dht", () => {
    expect(nodeCapabilities(33297)).toEqual({
      localWs: true,
      localWsPort: 33297,
      webrtc: true,
      dht: false,
    });
  });

  test("build then parse round-trips caps + port, signed and addressable", () => {
    const sk = generateSecretKey();
    const event = buildCapabilityEvent(sk, 54321);

    expect(event.kind).toBe(CAPABILITY_KIND);
    expect(event.tags.some((t) => t[0] === "d" && t[1] === CAPABILITY_D_TAG)).toBe(true);
    expect(verifyEvent(event as never)).toBe(true);

    const parsed = parseCapabilityEvent(event);
    expect(parsed).not.toBeNull();
    expect(parsed!.authorHex).toBe(getPublicKey(sk));
    expect(parsed!.caps).toEqual({
      localWs: true,
      localWsPort: 54321,
      webrtc: true,
      dht: false,
    });
  });

  test("the bound port is PLAINTEXT on the wire (no encryption) — a contact reads it", () => {
    const sk = generateSecretKey();
    const contactSk = generateSecretKey();
    const event = buildCapabilityEvent(sk, 54321);

    // The port is public — it's a loopback port, not a secret. No `enc` blob.
    expect(event.content).toContain("54321");
    const plain = JSON.parse(event.content) as Record<string, unknown>;
    expect(plain.localWsPort).toBe(54321);
    expect(plain.enc).toBeUndefined();

    // A different key parses the port just fine — no key material needed.
    const parsed = parseCapabilityEvent(event);
    expect(parsed!.caps.localWsPort).toBe(54321);
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

  test("parse coerces missing fields to safe defaults", () => {
    const sk = generateSecretKey();
    const event = buildCapabilityEvent(sk, 47100);
    // Hand-mangle content to drop fields (parse ignores sig).
    const mangled = { ...event, content: JSON.stringify({ webrtc: true }) } as NTNostrEvent;
    const parsed = parseCapabilityEvent(mangled);
    expect(parsed!.caps).toEqual({
      localWs: false,
      localWsPort: 0,
      webrtc: true,
      dht: false,
    });
  });
});
