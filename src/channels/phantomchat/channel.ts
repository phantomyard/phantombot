/**
 * phantomchat `Channel` adapter.
 *
 * ===========================================================================
 *  ENCRYPTION SEAM — REAL CRYPTO (unlike Telegram's pass-throughs)
 * ===========================================================================
 * phantomchat is the first ENCRYPTED channel. Per the seam contract in
 * core/types.ts, ALL transport crypto happens at the adapter boundary so the
 * conversational core only ever sees PLAINTEXT:
 *
 *   - listen()  unwraps each inbound NIP-17 gift-wrap, VERIFIES it, parses the
 *               JSON envelope, and yields a plaintext ChannelMessage whose
 *               `senderId` is the cryptographically-proven sender hex pubkey
 *               (rumor.pubkey). The core never sees a gift-wrap.
 *   - encrypt() is the egress seam; for phantomchat the actual wrapping is done
 *               by the transport's sendMessage (it needs our secret key), so
 *               encrypt() stays an identity pass-through and the server calls
 *               transport.sendMessage with the recipient hex + plaintext.
 *
 * The auth allowlist is NOT applied here — listen() yields every verified
 * message and the SERVER (server.ts) gates on `senderId` against the allowlist
 * before running a turn. Keeping the gate in the server mirrors Telegram, whose
 * allowlist check also lives in the engine, not the adapter.
 * ===========================================================================
 */

import { log } from "../../lib/logger.ts";
import type {
  Channel,
  ChannelCapabilities,
  ChannelMessage,
  OutboundMessage,
} from "../core/types.ts";
import {
  GiftWrapVerificationError,
  unwrapNip17Message,
  type NTNostrEvent,
} from "../../lib/nostrCrypto.ts";
import type { PhantomchatTransport } from "./transport.ts";

/**
 * phantomchat's static capabilities. Nostr DMs carry text + a typing indicator
 * (a NIP-16 ephemeral kind-20001 event — see transport.sendTyping); no voice,
 * no attachments. They ARE end-to-end encrypted (NIP-17 gift-wrap), so
 * `encryption: true`. This is the flag a future encrypted channel mirrors.
 */
export const PHANTOMCHAT_CAPABILITIES: ChannelCapabilities = {
  voice: false,
  typing: true,
  attachments: false,
  encryption: true,
};

/**
 * The application-level message envelope carried INSIDE a rumor's `content`,
 * as a JSON string. This is the wire contract with the PWA: the rumor content
 * is NOT the raw text but this object stringified.
 *
 * IMPORTANT compatibility notes (must match the PWA exactly):
 *   - `from` / `to` are 64-char HEX pubkeys (NOT npub).
 *   - `timestamp` is in MILLISECONDS (Date.now()), not Nostr seconds.
 *   - We only handle `type === "text"`; any other type is ignored silently.
 *
 * Security: `from` is attacker-controllable (it's just a field in the
 * plaintext), so it is used ONLY for building the reply destination echo and
 * NEVER for auth. Auth keys off the cryptographic `rumor.pubkey` instead.
 */
export interface PhantomchatEnvelope {
  id: string;
  from: string;
  to: string;
  type: string;
  content: string;
  timestamp: number;
}

export interface PhantomchatChannelInput {
  /** Our secret key — used to unwrap inbound gift-wraps. */
  secretKey: Uint8Array;
  /** Our 64-char hex pubkey — the `#p` value we subscribe for. */
  publicKeyHex: string;
  /** The relay-pool transport (subscribe + publish). */
  transport: PhantomchatTransport;
}

/**
 * Build the phantomchat `Channel`. `listen()` drives the inbound loop:
 * subscribe → unwrap+verify → parse envelope → yield plaintext ChannelMessage.
 *
 * Dedup is two-layered, matching the spec: relays re-deliver the same wrap, and
 * a single logical message also arrives as two wraps (recipient + self) — we
 * skip our OWN self-wraps (sender hex === our hex) and dedup by wrap event id
 * AND by rumor id so neither relay re-delivery nor the self-wrap echo produces
 * a duplicate turn.
 */
export function createPhantomchatChannel(
  input: PhantomchatChannelInput,
): Channel<PhantomchatTransport> {
  const { secretKey, publicKeyHex, transport } = input;

  return {
    id: "phantomchat",
    capabilities: PHANTOMCHAT_CAPABILITIES,
    transport,

    // ENCRYPTION SEAM (egress) — identity. The real wrapping needs our secret
    // key and happens in transport.sendMessage; the server hands plaintext +
    // recipient hex straight to that. Keeping this an identity pass-through
    // satisfies the Channel contract without duplicating the wrap path.
    encrypt(outbound: OutboundMessage): OutboundMessage {
      return outbound;
    },

    // ENCRYPTION SEAM (ingest) — identity at this hook because listen() already
    // produces fully-decrypted plaintext ChannelMessages (the unwrap happens
    // there, where it can also verify + drop forgeries). Present for contract
    // symmetry with the seam doc.
    decrypt(inbound: ChannelMessage): ChannelMessage {
      return inbound;
    },

    async *listen(signal?: AbortSignal): AsyncIterable<ChannelMessage> {
      // Bridge the callback-style relay subscription into an async iterator.
      // Inbound wraps land in `queue`; the generator drains it, parking on a
      // promise when empty and resuming when a wrap (or abort) wakes it.
      const queue: ChannelMessage[] = [];
      let wake: (() => void) | undefined;
      let closed = false;

      // Dedup state. Relays re-deliver; one message = two wraps (recipient +
      // self). Bound both sets so a long-lived listener can't grow unbounded.
      const seenWrapIds = new Set<string>();
      const seenRumorIds = new Set<string>();
      const remember = (set: Set<string>, id: string): boolean => {
        if (set.has(id)) return false;
        set.add(id);
        // Cheap cap: drop the oldest insertion when we cross the bound. Sets
        // iterate in insertion order, so the first key is the oldest.
        if (set.size > 5000) {
          const oldest = set.values().next().value;
          if (oldest !== undefined) set.delete(oldest);
        }
        return true;
      };

      const onWrap = (event: NTNostrEvent): void => {
        // (1) Dedup by wrap event id — relays re-deliver the identical wrap.
        if (!remember(seenWrapIds, event.id)) return;

        let rumor: ReturnType<typeof unwrapNip17Message>;
        try {
          // (2) Verifying unwrap. Throws GiftWrapVerificationError on any
          // forged/tampered layer — we drop those silently (debug-logged):
          // a hostile relay or attacker shouldn't produce noise, let alone
          // a turn.
          rumor = unwrapNip17Message(event, secretKey);
        } catch (e) {
          if (e instanceof GiftWrapVerificationError) {
            log.debug("phantomchat: dropping unverifiable gift-wrap", {
              code: e.code,
            });
          } else {
            log.debug("phantomchat: gift-wrap unwrap failed", {
              error: (e as Error).message,
            });
          }
          return;
        }

        // (3) Skip our OWN self-wrap. wrapNip17Message publishes a self-copy
        // for multi-device recovery; on the bot that self-copy would otherwise
        // look like an inbound message from ourselves. The sender is the
        // cryptographic rumor.pubkey.
        const senderHex = rumor.pubkey.toLowerCase();
        if (senderHex === publicKeyHex.toLowerCase()) return;

        // (4) Dedup by rumor id — the SAME logical message can arrive via more
        // than one wrap; the rumor id is stable across them.
        if (!remember(seenRumorIds, rumor.id)) return;

        // (5) Parse the JSON envelope. Only `type === "text"` is handled; any
        // other type (or malformed JSON) is ignored silently per the spec.
        let envelope: { type?: unknown; content?: unknown };
        try {
          envelope = JSON.parse(rumor.content) as {
            type?: unknown;
            content?: unknown;
          };
        } catch {
          log.debug("phantomchat: rumor content is not valid JSON; ignoring");
          return;
        }
        if (envelope.type !== "text" || typeof envelope.content !== "string") {
          return;
        }

        // (6) LIVE-GATE. On (re)connect the relays replay up to 49h of stored
        // gift-wraps (the wide `since` we need so live backdated wraps aren't
        // filtered — see transport.subscribeGiftWraps). We must NOT answer that
        // history: a restart would otherwise re-reply to every past DM. So we
        // process a message only once it arrives LIVE, i.e. after the relays
        // have signalled EOSE (end of stored events). Everything before EOSE is
        // already marked seen above (wrap id + rumor id), so it's silently
        // consumed — never enqueued, and never reprocessed if re-delivered.
        if (!live) {
          log.debug("phantomchat: skipping backlog gift-wrap (pre-EOSE)");
          return;
        }

        // Yield a plaintext, channel-neutral message. conversationId and
        // senderId are BOTH the proven sender hex: a DM thread is keyed by the
        // peer, and the trust perimeter gates on this same proven id.
        queue.push({
          conversationId: senderHex,
          senderId: senderHex,
          text: envelope.content,
        });
        wake?.();
      };

      // The live-gate flag (see onWrap step 6). Flipped true on EOSE — or after
      // a fallback timeout, in case a slow/dead relay never sends EOSE and would
      // otherwise wedge the bot in "backlog mode" forever (deaf to new DMs).
      let live = false;
      const goLive = (): void => {
        if (!live) {
          live = true;
          log.info("phantomchat: backlog drained — now live");
        }
      };
      const liveFallback = setTimeout(goLive, 8000);

      const sub = transport.subscribeGiftWraps(publicKeyHex, onWrap, goLive);

      const onAbort = (): void => {
        closed = true;
        wake?.();
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      try {
        while (!closed) {
          while (queue.length > 0) {
            yield queue.shift()!;
          }
          if (closed) break;
          // Park until a wrap arrives or we're aborted.
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
        // Drain anything that landed between the last check and abort.
        while (queue.length > 0) {
          yield queue.shift()!;
        }
      } finally {
        clearTimeout(liveFallback);
        if (signal) signal.removeEventListener("abort", onAbort);
        sub.close();
      }
    },
  };
}
