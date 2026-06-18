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
 * How often the self-heal watchdog polls relay connection health. A dropped
 * relay's inbound subscription is dead until the next check, so this bounds the
 * worst-case deaf window after a hard relay drop. 20s balances quick recovery
 * against not thrashing re-subscriptions on a transient blip (enablePing's ~30s
 * keepalive means most idle drops never happen in the first place).
 */
export const SUBSCRIPTION_HEAL_CHECK_MS = 20_000;

/**
 * How often the catch-up poll re-queries the relays for recent gift-wraps. This
 * is the delivery backbone: relays sometimes silently fail to PUSH a freshly-
 * published wrap to an already-live subscription (the proven cause of the "first
 * message ghosts" bug), but the wrap still PERSISTS on the relay. Every tick we
 * pull the last `BACKFILL_POLL_WINDOW_SEC` of wraps and run them through the same
 * dedup'd onWrap, so any missed message self-heals within one interval. We no
 * longer depend on the live push for correctness — only for latency.
 */
export const BACKFILL_POLL_MS = 15_000;

/**
 * How far back (seconds) each catch-up poll reaches. Must comfortably exceed the
 * poll interval so consecutive windows overlap and nothing can fall between two
 * polls. Dedup makes the overlap free.
 */
export const BACKFILL_POLL_WINDOW_SEC = 90;

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
  /**
   * Self-heal watchdog poll interval (ms). Defaults to
   * `SUBSCRIPTION_HEAL_CHECK_MS`; overridable so tests can drive the watchdog
   * without a 20s wait.
   */
  healCheckMs?: number;
  /**
   * Catch-up poll interval (ms). Defaults to `BACKFILL_POLL_MS`; overridable so
   * tests can drive the poll without a 15s wait.
   */
  backfillPollMs?: number;
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
  const healCheckMs = input.healCheckMs ?? SUBSCRIPTION_HEAL_CHECK_MS;
  const backfillPollMs = input.backfillPollMs ?? BACKFILL_POLL_MS;

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

        // (5) Parse the JSON envelope. `type === "text"` is a chat message;
        // `presence-ping` / `presence-pong` are legacy types, silently dropped
        // (presence was removed — see drop below); any other type (or malformed
        // JSON) is ignored silently.
        // NIP-17 dual-read. Two accepted shapes:
        //   - Legacy PhantomChat JSON envelope {type, content, id, nonce}.
        //   - Standard NIP-17: rumor.content IS the plain message text (what
        //     0xchat/Amethyst and the aligned PWA send). Resolved below.
        let parsedContent: any = null;
        try {
          const p = JSON.parse(rumor.content);
          if (p && typeof p === "object") parsedContent = p;
        } catch {
          // not JSON → standard NIP-17 plain-text message (handled below)
        }
        // Only OUR text envelope has a string `type`. A plain-text body that
        // happens to be JSON without a `type` falls through to the plain-text path.
        const envelope: {id?: unknown; type?: unknown; content?: unknown; nonce?: unknown} | null =
          parsedContent && typeof parsedContent.type === "string" ? parsedContent : null;

        // Media envelope (voice / image / file): the PWA wraps an encrypted
        // Blossom file as {url, sha256, key, iv, mediaType, duration, waveform}.
        // It carries no `type`, so it isn't caught above — detect it here so the
        // server fetches+decrypts (and, for voice, transcribes) instead of
        // running a turn on the raw metadata JSON.
        let media: ChannelMessage["media"] | undefined;
        if (
          parsedContent &&
          typeof parsedContent.url === "string" &&
          typeof parsedContent.sha256 === "string" &&
          typeof parsedContent.key === "string" &&
          typeof parsedContent.iv === "string" &&
          typeof parsedContent.mediaType === "string"
        ) {
          const mt = parsedContent.mediaType;
          media = {
            kind: mt === "voice" || mt === "image" || mt === "video" ? mt : "file",
            url: parsedContent.url,
            sha256: parsedContent.sha256,
            keyHex: parsedContent.key,
            ivHex: parsedContent.iv,
            mimeType:
              typeof parsedContent.mimeType === "string"
                ? parsedContent.mimeType
                : "application/octet-stream",
            durationS:
              typeof parsedContent.duration === "number" ? parsedContent.duration : undefined,
          };
        }

        // (6) LIVE-GATE. On (re)connect the relays replay up to 49h of stored
        // gift-wraps (the wide `since` we need so live backdated wraps aren't
        // filtered — see transport.subscribeGiftWraps). We must NOT act on that
        // history: a restart would otherwise re-reply to every past DM, and a
        // stale ping's pong is useless (the sender long ago timed that nonce
        // out). So we act only once a message arrives LIVE, i.e. after the
        // relays have signalled EOSE. Everything before EOSE is already marked
        // seen above (wrap id + rumor id), so it's silently consumed — never
        // enqueued, never re-ponged, never reprocessed if re-delivered.
        if (!live) {
          log.debug("phantomchat: skipping backlog gift-wrap (pre-EOSE)");
          return;
        }

        // (7) PRESENCE was removed (the client no longer shows online/last-seen
        // and no longer pings). Drop any stale presence envelope silently — never
        // pong, never enqueue a turn.
        if (envelope?.type === "presence-ping" || envelope?.type === "presence-pong") {
          return;
        }

        // Resolve the message text + id from whichever shape arrived.
        let text: string;
        let messageId: string | undefined;
        if (media) {
          // Voice / media: no text body — the server fetches+decrypts (and, for
          // voice, transcribes) before running the turn. Key the delivery
          // receipt off the rumor id, same as a standard NIP-17 message.
          text = "";
          messageId = rumor.id;
        } else if (envelope) {
          // Legacy envelope: only `text` envelopes become turns (reactions/etc. drop).
          if (envelope.type !== "text" || typeof envelope.content !== "string") {
            return;
          }
          text = envelope.content;
          if (typeof envelope.id === "string" && envelope.id) messageId = envelope.id;
        } else {
          // Standard NIP-17 plain-text DM. Empty bodies (e.g. delivery-receipt
          // rumors carry empty content) are ignored so we never run an empty turn.
          if (typeof rumor.content !== "string" || !rumor.content.trim()) {
            return;
          }
          text = rumor.content;
          messageId = rumor.id; // NIP-17 keys receipts/edits off the rumor id
        }

        // (8) GROUP ROUTING. The PWA wraps a GROUP message with the same text
        // envelope content as a DM, distinguishing it ONLY in the rumor tags: a
        // `['group', <groupId>]` tag plus one `['p', <memberHex>]` tag per OTHER
        // member (see the PWA's wrapGroupMessage). Without reading those tags
        // every group message looks like a DM and the reply goes back 1:1 to
        // the sender instead of into the group — the HQ bug. So: if a group tag
        // is present, thread the turn under a `group:<groupId>` conversation and
        // carry the member hexes so the server can broadcast the reply to the
        // whole group. No group DB is needed: the member list rides inbound.
        const groupTag = rumor.tags.find(
          (t) => t[0] === "group" && typeof t[1] === "string" && t[1].length > 0,
        );
        const groupId = groupTag?.[1];

        if (groupId) {
          // Members the sender wrapped to (everyone but the sender). Lowercased
          // for stable comparison; the sender adds itself back on reply.
          const memberHexes = rumor.tags
            .filter((t) => t[0] === "p" && typeof t[1] === "string")
            .map((t) => t[1]!.toLowerCase());
          queue.push({
            // Key the thread by the group, not the peer, so a group and a 1:1
            // DM with the same person stay distinct conversations.
            conversationId: `group:${groupId}`,
            // senderId stays the proven sender hex — the auth gate is per-person
            // regardless of whether the message came via a group.
            senderId: senderHex,
            text,
            groupId,
            groupMemberHexes: memberHexes,
            ...(media ? { media } : {}),
          });
          wake?.();
          return;
        }

        // Yield a plaintext, channel-neutral message. conversationId and
        // senderId are BOTH the proven sender hex: a DM thread is keyed by the
        // peer, and the trust perimeter gates on this same proven id.
        //
        // messageId carries the envelope's app message id so the SERVER can send
        // a delivery receipt back AFTER the auth gate admits the sender — we do
        // NOT receipt here, or we'd ack (and de-stealth) non-allowlisted
        // strangers the gate is meant to drop silently.
        queue.push({
          conversationId: senderHex,
          senderId: senderHex,
          text,
          ...(messageId ? { messageId } : {}),
          ...(media ? { media } : {}),
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

      let sub = transport.subscribeGiftWraps(publicKeyHex, onWrap, goLive);

      // SELF-HEAL WATCHDOG. `enablePing` (set on the pool) keeps idle sockets
      // warm so they aren't dropped for inactivity — that alone fixes the common
      // "ignores the first DM after idle" case. But a HARD drop (relay restart,
      // network blip, or a ping-timeout force-close) deletes the relay from the
      // pool with reconnect OFF, tearing its gift-wrap subscription down for
      // good. So we poll connection health and, when fewer relays are connected
      // than configured, re-arm a fresh subscription. A fresh subscribeGiftWraps
      // reconnects the dropped relay (nostr-tools' ensureRelay) and re-sends our
      // REQ with the correct WIDE `since` — crucially NOT nostr-tools' own
      // reconnect, which narrows `since` to lastEmitted+1 and would silently drop
      // gift-wraps backdated up to 48h. `live` stays true and the dedup sets
      // persist across the re-arm, so the backlog this replays is silently
      // consumed — never a re-reply. No-op when the pool can't report status
      // (in-memory test fakes return undefined).
      const expectedRelays = transport.relays.length;
      // EDGE-TRIGGERED. Re-arm only when the connected count FELL since the last
      // check, not on every tick a relay stays down. A re-arm reconnects dropped
      // relays (ensureRelay), so a healthy recovery returns the count to
      // `expectedRelays` and no further re-arm fires. But if a relay is
      // persistently dead the count plateaus below expected — level-triggering
      // there would re-subscribe (and replay 49h of backlog on) the HEALTHY
      // relays every interval forever. Edge-triggering re-arms once per drop and
      // then waits for either recovery or a further drop. The surviving relays
      // carry traffic in the meantime (a DM publishes to all of them).
      let lastConnected = expectedRelays;
      const healCheck = (): void => {
        if (closed) return;
        const connected = transport.connectedRelayCount();
        if (connected === undefined) return;
        if (connected < expectedRelays && connected < lastConnected) {
          log.info("phantomchat: relay(s) dropped — re-arming gift-wrap subscription", {
            connected,
            expected: expectedRelays,
          });
          try {
            sub.close();
          } catch {
            // already torn down by the hard close — re-arm anyway.
          }
          sub = transport.subscribeGiftWraps(publicKeyHex, onWrap, goLive);
        }
        lastConnected = connected;
      };
      const healTimer = setInterval(healCheck, healCheckMs);

      // CATCH-UP POLL. The delivery backbone. A relay can silently fail to PUSH
      // a freshly-published wrap to our already-live subscription — the proven
      // cause of the "first message ghosts" bug — yet the wrap still PERSISTS on
      // the relay. So we periodically PULL the last BACKFILL_POLL_WINDOW_SEC of
      // gift-wraps and run each through the SAME onWrap. Dedup (wrap id + rumor
      // id) makes overlap with the live push free, so a message the push dropped
      // self-heals within one interval. Only runs once live (pre-EOSE results
      // would be dropped by the live-gate anyway) and never overlaps itself.
      let polling = false;
      const backfillPoll = async (): Promise<void> => {
        if (closed || !live || polling) return;
        polling = true;
        try {
          const since =
            Math.floor(Date.now() / 1000) - BACKFILL_POLL_WINDOW_SEC;
          const events = await transport.fetchGiftWrapsSince(
            publicKeyHex,
            since,
          );
          for (const event of events) {
            if (closed) break;
            onWrap(event);
          }
        } catch (e) {
          log.debug("phantomchat: catch-up poll failed", {
            error: (e as Error).message,
          });
        } finally {
          polling = false;
        }
      };
      const pollTimer = setInterval(() => {
        void backfillPoll();
      }, backfillPollMs);

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
        clearInterval(healTimer);
        clearInterval(pollTimer);
        if (signal) signal.removeEventListener("abort", onAbort);
        sub.close();
      }
    },
  };
}
