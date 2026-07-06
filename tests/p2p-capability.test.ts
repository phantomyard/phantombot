/**
 * Capability advertisement: the event a node publishes so a peer's PWA can light
 * up its transport ladder. Pins the build/parse contract the phantomchat
 * companion mirrors on ingest.
 *
 * The advert is TWO-PART: public capability booleans (any contact reads) plus a
 * self-encrypted reachability blob (only the owner's nsec decrypts). These tests
 * pin both halves — that a contact sees the booleans but NOT the port/IP, and
 * that the owner recovers the real bound port.
 */

import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";

import {
  buildCapabilityEvent,
  localLanIps,
  nodeCapabilities,
  parseCapabilityEvent,
  CAPABILITY_D_TAG,
  CAPABILITY_KIND,
} from "../src/p2p/capability.ts";
import type { NTNostrEvent } from "../src/lib/nostrCrypto.ts";

describe("p2p capability advertisement", () => {
  test("nodeCapabilities advertises localWs + webrtc, never dht (booleans only)", () => {
    expect(nodeCapabilities()).toEqual({ localWs: true, webrtc: true, dht: false });
  });

  test("build then parse round-trips public caps, signed and addressable", () => {
    const sk = generateSecretKey();
    const event = buildCapabilityEvent(sk, getPublicKey(sk), 54321);

    expect(event.kind).toBe(CAPABILITY_KIND);
    expect(event.tags.some((t) => t[0] === "d" && t[1] === CAPABILITY_D_TAG)).toBe(true);
    expect(verifyEvent(event as never)).toBe(true);

    const parsed = parseCapabilityEvent(event);
    expect(parsed).not.toBeNull();
    expect(parsed!.authorHex).toBe(getPublicKey(sk));
    expect(parsed!.caps).toEqual({ localWs: true, webrtc: true, dht: false });
  });

  test("port and LAN IPs are NOT in plaintext — only in the encrypted blob", () => {
    const sk = generateSecretKey();
    const event = buildCapabilityEvent(sk, getPublicKey(sk), 54321, {
      lanIps: ["192.168.1.42"],
    });
    // The wire content must not leak the port or IP in the clear.
    expect(event.content).not.toContain("54321");
    expect(event.content).not.toContain("192.168.1.42");
    // Plaintext holds only the booleans + the opaque `enc` field.
    const plain = JSON.parse(event.content) as Record<string, unknown>;
    expect(plain.localWsPort).toBeUndefined();
    expect(typeof plain.enc).toBe("string");
  });

  test("the OWNER decrypts the reachability blob (its own bound port + LAN IPs)", () => {
    const sk = generateSecretKey();
    const event = buildCapabilityEvent(sk, getPublicKey(sk), 54321, {
      lanIps: ["192.168.1.42"],
    });
    // Owner passes its own sk → the self conversation key decrypts `enc`.
    const parsed = parseCapabilityEvent(event, sk);
    expect(parsed!.reachability).toEqual({ localWsPort: 54321, lanIps: ["192.168.1.42"] });
  });

  test("a CONTACT (different key) reads booleans but never the reachability", () => {
    const sk = generateSecretKey();
    const contactSk = generateSecretKey();
    const event = buildCapabilityEvent(sk, getPublicKey(sk), 54321, {
      lanIps: ["192.168.1.42"],
    });
    // A contact's key can't derive the self key → no reachability, caps still read.
    const parsed = parseCapabilityEvent(event, contactSk);
    expect(parsed!.caps).toEqual({ localWs: true, webrtc: true, dht: false });
    expect(parsed!.reachability).toBeUndefined();
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

  test("parse coerces missing booleans to safe defaults", () => {
    const sk = generateSecretKey();
    const event = buildCapabilityEvent(sk, getPublicKey(sk), 47100);
    // Hand-mangle content to drop fields (parse ignores sig).
    const mangled = { ...event, content: JSON.stringify({ webrtc: true }) } as NTNostrEvent;
    const parsed = parseCapabilityEvent(mangled);
    expect(parsed!.caps).toEqual({ localWs: false, webrtc: true, dht: false });
  });

  test("localLanIps returns strings and never throws", () => {
    const ips = localLanIps();
    expect(Array.isArray(ips)).toBe(true);
    for (const ip of ips) expect(typeof ip).toBe("string");
  });
});
