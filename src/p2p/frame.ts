/**
 * P2P wire-frame contract with the PhantomChat PWA (phantomyard/phantombot#258,
 * phantomyard/phantomchat#61/#62).
 *
 * The PWA and phantombot speak the SAME wire language as a Nostr relay. When the
 * PWA wants to push a message over a direct transport it does NOT invent a
 * bespoke envelope — it ships the EXACT kind-1059 gift-wrap it just published to
 * the relay, framed as a standard relay `["EVENT", wrap]` message (see
 * phantomchat `transport-selector.ts`). The receiver feeds that frame straight
 * into its relay-pool ingest (`NostrRelayPool.ingestP2PEvent`).
 *
 * phantombot's P2P node is therefore a DUMB, ENCRYPTED-WRAP RELAY: it forwards
 * the opaque gift-wrap node-to-node and never decrypts it. All this module does
 * is (a) validate a frame is a well-formed `["EVENT", wrap]`, and (b) read the
 * recipient's real pubkey off the wrap's `p` tag so the node knows which peer to
 * route to. The wrap's inner content stays sealed end-to-end between the two
 * PWAs — the node has no key for it and never needs one.
 */

import type { NTNostrEvent } from "../lib/nostrCrypto.ts";

/**
 * The loopback port the local node exposes for the PWA ws bridge. MUST stay in
 * sync with `DEFAULT_LOCAL_NODE_PORT` in the phantomchat PWA
 * (`src/lib/phantomchat/transport/local-ws-transport.ts`). Changing one without
 * the other silently breaks the Tier-1 localhost path.
 */
export const DEFAULT_LOCAL_NODE_PORT = 47100;

/** The relay-wire kind carried over the bridge: a NIP-59 gift-wrap. */
export const GIFTWRAP_KIND = 1059;

/** A parsed, validated `["EVENT", wrap]` frame. */
export interface ParsedEventFrame {
  /** The opaque gift-wrap event. The node forwards this verbatim. */
  wrap: NTNostrEvent;
  /** The recipient's real pubkey (hex), read from the wrap's `p` tag. */
  recipientHex: string;
}

/**
 * Shape a gift-wrap into the relay wire frame the PWA ingest expects:
 * `["EVENT", wrap]` as a JSON string. Symmetric with `parseEventFrame`.
 */
export function buildEventFrame(wrap: NTNostrEvent): string {
  return JSON.stringify(["EVENT", wrap]);
}

/**
 * Read the recipient's real pubkey off a gift-wrap. NIP-59 wraps address the
 * recipient with a single `["p", <recipientPubHex>]` tag (the outer author is a
 * throwaway ephemeral key, so authorship reveals nothing). Returns the first
 * `p` tag value, or `null` if the wrap carries none.
 */
export function recipientOfWrap(wrap: NTNostrEvent): string | null {
  if (!wrap || !Array.isArray(wrap.tags)) return null;
  for (const tag of wrap.tags) {
    if (Array.isArray(tag) && tag[0] === "p" && typeof tag[1] === "string" && tag[1]) {
      return tag[1];
    }
  }
  return null;
}

/**
 * Minimal structural check that an object is a signed Nostr event we can relay.
 * We do NOT verify the signature here — the node never trusts wrap contents, it
 * only forwards them, and the receiving PWA re-verifies on ingest. We just guard
 * against malformed frames that would poison the transport.
 */
export function looksLikeEvent(value: unknown): value is NTNostrEvent {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.pubkey === "string" &&
    typeof e.sig === "string" &&
    typeof e.content === "string" &&
    typeof e.kind === "number" &&
    typeof e.created_at === "number" &&
    Array.isArray(e.tags)
  );
}

/**
 * Parse a raw ws payload into a validated event frame, or return `null` when it
 * is anything other than a well-formed `["EVENT", <gift-wrap>]`. Never throws:
 * a bad frame is dropped, not fatal. We accept only kind-1059 gift-wraps that
 * carry a recipient `p` tag — that is the entire vocabulary of the bridge, so
 * anything else (a `["REQ", …]`, a `["CLOSE", …]`, junk) is ignored.
 */
export function parseEventFrame(raw: string): ParsedEventFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed[0] !== "EVENT") return null;

  const wrap = parsed[1];
  if (!looksLikeEvent(wrap)) return null;
  if (wrap.kind !== GIFTWRAP_KIND) return null;

  const recipientHex = recipientOfWrap(wrap);
  if (!recipientHex) return null;

  return { wrap, recipientHex };
}
