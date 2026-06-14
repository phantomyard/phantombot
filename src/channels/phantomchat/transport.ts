/**
 * phantomchat transport: the Nostr relay-pool surface — subscribe for inbound
 * gift-wraps, publish outbound ones.
 *
 * Unlike Telegram, the "transport" here is a set of websocket relays rather
 * than a single HTTP API. phantombot is just another Nostr CLIENT (symmetric
 * with the PWA): it SUBSCRIBES to kind-1059 gift-wraps tagged to its own
 * pubkey, and PUBLISHES wrapped replies to the same relays. There is no server.
 *
 * The wrap/unwrap crypto lives in the channel/server layers (so the core only
 * ever sees plaintext — the encryption seam in core/types.ts); this module is
 * purely the relay plumbing plus event dedup.
 */

import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

import { log } from "../../lib/logger.ts";
import type { ChannelTransport } from "../core/types.ts";
import type { NTNostrEvent } from "../../lib/nostrCrypto.ts";
import {
  wrapGroupMessage,
  wrapNip17Message,
  type NTNostrEvent as WrapEvent,
} from "../../lib/nostrCrypto.ts";

/**
 * The five default public relays the PhantomChat PWA uses. phantombot must be
 * on the SAME relays as Andrew's PWA for a DM to reach it, so these are the
 * defaults; the config can override them per deployment.
 *
 * (Source: phantomchat repo, src/lib/phantomchat/nostr-relay-pool.ts.)
 */
export const DEFAULT_PHANTOMCHAT_RELAYS: readonly string[] = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://nostr.mom",
  "wss://nostr.data.haus",
];

/**
 * NIP-16 EPHEMERAL event kind for the typing indicator (range 20000–29999).
 * Relays do NOT store ephemeral events — they only fan them out to currently
 * connected subscribers — so a typing signal cannot be replayed on reconnect
 * and self-expires the moment nobody is listening. The PWA subscribes for this
 * kind p-tagged to itself and injects a native `updateUserTyping` (three-dots,
 * 6s auto-expiry). Must match phantomchat's `NOSTR_KIND_TYPING`.
 */
export const NOSTR_KIND_TYPING = 20001;

/**
 * Typing-event content markers. A kind-20001 event's `content` is the lifecycle
 * signal the PWA reads: empty string = "I'm typing now" (start/refresh);
 * `"stop"` = "I've stopped" (cancel immediately). The bot emits a STOP the
 * instant a reply is published so the PWA clears the dots at once instead of
 * waiting out its 6s auto-expiry — the "typing lingers after the answer" fix.
 */
export const TYPING_CONTENT_START = "";
export const TYPING_CONTENT_STOP = "stop";

/**
 * NIP-38 PARAMETERIZED-REPLACEABLE event kind for user status / presence
 * (range 30000–39999). We use it as a liveness heartbeat: while phantombot's
 * listener is up it republishes one of these every ~60s, p-tagged to each
 * allowlist peer and carrying `["status","online"]` + content `"online"`. The
 * PWA — already subscribed for events p-tagged to itself — resolves the author
 * pubkey to a contact and renders a REAL "Online" badge; when the heartbeats
 * stop (service down / relays unreachable) the PWA flips the contact to
 * "last seen at HH:MM" after its offline threshold. Must match phantomchat's
 * `KIND_STATUS` and the `d`/`status`/content shape its presence engine expects.
 *
 * Being parameterized-replaceable (keyed by author+kind+`d`), each new beat
 * supersedes the last on the relay — no unbounded accumulation.
 */
export const NOSTR_KIND_PRESENCE = 30315;

/**
 * The Nostr filter shape we subscribe with. Kept minimal: kind-1059 gift-wraps
 * tagged to our pubkey, from roughly now. We deliberately set `since` to a
 * SMALL window (or omit it) because a gift-wrap's `created_at` is randomized up
 * to 48h INTO THE PAST for metadata privacy — a tight `since` would drop fresh
 * messages. Dedup (by wrap id, then rumor id) is the real guard, not `since`.
 */
export interface NostrFilter {
  kinds: number[];
  "#p": string[];
  since?: number;
}

/**
 * The slice of nostr-tools' `SimplePool` we depend on. Declaring it as an
 * interface lets tests inject an in-memory fake pool — no real relays, no
 * websockets — exactly the way the Telegram tests inject a fake transport.
 */
export interface RelayPool {
  /**
   * Subscribe with a SINGLE `filter` across `relays`. `onevent` fires for each
   * matching event (possibly more than once across relays — the caller dedups).
   * Returns a handle whose `close()` tears the subscription down.
   *
   * IMPORTANT — nostr-tools 2.23.3 quirk: `SimplePool.subscribeMany` takes a
   * single filter OBJECT here, not an array. Internally it groups per-relay into
   * the `filters` array the REQ frame needs (see `subscribeMap`). Passing
   * `[filter]` double-wraps it — the wire REQ becomes `["REQ",id,[{...}]]` and
   * strict relays (e.g. primal) reject it with "provided filter is not an
   * object", silently delivering ZERO events. So this is `filter`, singular.
   */
  subscribeMany(
    relays: string[],
    filter: NostrFilter,
    params: { onevent: (event: NTNostrEvent) => void; oneose?: () => void },
  ): { close(): void };
  /** Publish `event` to every relay. Returns one promise per relay. */
  publish(relays: string[], event: NTNostrEvent): Promise<string>[];
  /**
   * Per-relay connection status: a Map of relay-url → connected?. nostr-tools'
   * SimplePool exposes this as `listConnectionStatus()`; a relay that has hard-
   * closed is either absent from the map or present with `false`. Optional so
   * in-memory test fakes (which have no sockets) don't have to implement it.
   */
  listConnectionStatus?(): Map<string, boolean>;
  /** Close all relay connections. */
  close(relays: string[]): void;
}

/**
 * phantomchat's transport surface. It satisfies the channel-agnostic
 * `ChannelTransport` contract — most notably `sendMessage(conversationId,
 * text)`, where `conversationId` is the recipient's 64-char HEX pubkey. The
 * actual NIP-17 wrapping happens INSIDE `sendMessage` so callers (the server)
 * hand it plaintext and a hex destination, mirroring how Telegram callers hand
 * it plaintext and a chat id.
 */
export interface PhantomchatTransport extends ChannelTransport {
  /** The relays this transport publishes to / subscribes on. */
  readonly relays: string[];
  /**
   * Subscribe for inbound kind-1059 gift-wraps addressed to `ourPubHex`.
   * `onWrap` fires per raw wrap event (caller unwraps + dedups). `onEose` fires
   * once the relays have replayed their stored backlog, so the caller can tell
   * historical messages from live ones (see channel.listen's live-gate). Returns
   * a close handle.
   */
  subscribeGiftWraps(
    ourPubHex: string,
    onWrap: (event: NTNostrEvent) => void,
    onEose?: () => void,
  ): { close(): void };
  /** Publish an already-wrapped kind-1059 event to all relays. */
  publishWrap(event: NTNostrEvent): Promise<void>;
  /**
   * Send a plaintext reply into a GROUP. `groupId` is the group identifier from
   * the inbound rumor's `['group', ...]` tag; `memberHexes` is the OTHER group
   * members to broadcast to (every member except us — the self-wrap is added
   * internally). Builds the phantomchat text envelope, group-wraps it (one
   * gift-wrap per member + a self-wrap, with the `['group', groupId]` rumor tag
   * the PWA routes on), and publishes every wrap. A no-op when `memberHexes` is
   * empty (a lone-member group has nobody to reach).
   */
  sendGroupMessage(
    groupId: string,
    memberHexes: string[],
    text: string,
  ): Promise<void>;
  /**
   * Group typing indicator. Publishes ONE kind-20001 ephemeral event carrying a
   * `['group', groupId]` tag plus one `['p', hex]` tag per member, so the PWA
   * routes the dots into the GROUP chat (showing "Lena is typing…", natively
   * aggregated with other members) rather than a 1:1 DM. `stop` true emits the
   * STOP marker to clear the indicator immediately. Best-effort: never throws.
   * A no-op when `memberHexes` is empty.
   */
  /**
   * DM typing tick. `stop` true emits the STOP marker so the PWA clears the
   * dots immediately instead of waiting out its 6s auto-expiry. Widens the base
   * `ChannelTransport.sendTyping(conversationId)` with the optional flag.
   */
  sendTyping(conversationId: string, stop?: boolean): Promise<void>;
  sendGroupTyping(
    groupId: string,
    memberHexes: string[],
    stop?: boolean,
  ): Promise<void>;
  /**
   * Publish a single NIP-38 kind-30315 presence heartbeat, p-tagged to every
   * hex pubkey in `peerHexes`, advertising that we're online. Best-effort: never
   * throws. A no-op when `peerHexes` is empty (no one to advertise to).
   */
  sendPresence(peerHexes: string[]): Promise<void>;
  /**
   * Reply to a presence PING with a PONG: publish a NIP-17 gift-wrapped
   * `{type:"presence-pong", nonce, ...}` envelope to `toHex`, echoing the
   * ping's `nonce` so the sender can correlate it (freshness is by nonce, not
   * timestamp — gift-wrap created_at is backdated). Rides the SAME kind-1059
   * path as real messages, so a pong proves the actual message-delivery path is
   * live (not merely some side-channel). Best-effort: never throws.
   */
  sendPresencePong(toHex: string, nonce: string): Promise<void>;
  /**
   * How many of our relays are currently connected, or `undefined` if the
   * underlying pool can't report it (in-memory test fakes). The channel-layer
   * self-heal watchdog reads this: a count below `relays.length` means a relay
   * dropped and the subscription must be re-armed.
   */
  connectedRelayCount(): number | undefined;
  /** Tear down all relay connections. */
  close(): void;
}

/**
 * Real relay-pool transport over nostr-tools' `SimplePool`.
 *
 * `sendMessage` is the `ChannelTransport` egress entry point: it takes the
 * recipient hex pubkey as `conversationId`, NIP-17-wraps the plaintext with our
 * secret key, and publishes BOTH the recipient wrap and the self wrap (the PWA
 * reads its own sent messages back from the self wrap). Typing / voice /
 * attachments are no-ops — Nostr DMs carry none of those (see capabilities).
 */
export class SimplePoolPhantomchatTransport implements PhantomchatTransport {
  readonly relays: string[];
  /** Our 64-char hex pubkey — the `from` field of every reply envelope. */
  private readonly ourPubHex: string;

  constructor(
    private readonly ourSecretKey: Uint8Array,
    relays: string[],
    private readonly pool: RelayPool,
  ) {
    this.relays = [...relays];
    this.ourPubHex = getPublicKey(ourSecretKey);
  }

  subscribeGiftWraps(
    ourPubHex: string,
    onWrap: (event: NTNostrEvent) => void,
    onEose?: () => void,
  ): { close(): void } {
    const filter: NostrFilter = {
      kinds: [1059],
      "#p": [ourPubHex],
      // CRITICAL: `since` MUST cover the gift-wrap backdate window. NIP-59
      // randomizes a gift-wrap's `created_at` up to 48h INTO THE PAST for
      // metadata privacy, and relays (strfry/damus/primal) apply `since` to
      // LIVE events too — not just the stored backlog. A tight `since` (e.g.
      // now-60s) therefore silently drops essentially every real DM, because a
      // brand-new message's wrap is timestamped hours ago. We widen to 49h
      // (48h max backdate + 1h slack) so live wraps are never filtered out.
      // History this pulls in on connect is discarded by channel.listen's
      // live-gate (it ignores everything before EOSE), so a restart never
      // replays old conversations.
      since: Math.floor(Date.now() / 1000) - (49 * 60 * 60),
    };
    // Single filter object — NOT `[filter]`. See the RelayPool.subscribeMany
    // doc: nostr-tools wraps it into the per-relay filters array itself, and
    // double-wrapping produces a malformed REQ that delivers nothing.
    return this.pool.subscribeMany(this.relays, filter, {
      onevent: (event) => {
        try {
          onWrap(event);
        } catch (e) {
          log.warn("phantomchat: onWrap handler threw", {
            error: (e as Error).message,
          });
        }
      },
      oneose: onEose,
    });
  }

  async publishWrap(event: NTNostrEvent): Promise<void> {
    // SimplePool.publish returns one promise per relay; a publish that fails on
    // some relays but lands on others is still a success from our side. We wait
    // on all of them (allSettled) so a single dead relay can't reject the send,
    // and log if EVERY relay rejected.
    const results = await Promise.allSettled(this.pool.publish(this.relays, event));
    const ok = results.some((r) => r.status === "fulfilled");
    if (!ok) {
      log.warn("phantomchat: publish failed on all relays", {
        relays: this.relays.length,
        eventId: event.id,
      });
    }
  }

  /**
   * ChannelTransport egress. `conversationId` is the recipient's 64-char hex
   * pubkey, `text` the plaintext reply.
   *
   * The rumor `content` on the wire is NOT the raw text — it's the phantomchat
   * JSON envelope `{id, from, to, type, content, timestamp}` the PWA expects
   * (hex pubkeys, ms timestamp). We build that here, then NIP-17-wrap it and
   * publish both the recipient and self wraps.
   */
  async sendMessage(conversationId: string, text: string): Promise<void> {
    const envelope = JSON.stringify({
      id: crypto.randomUUID(),
      from: this.ourPubHex,
      to: conversationId,
      type: "text",
      content: text,
      timestamp: Date.now(),
    });
    const { wraps } = wrapNip17Message(
      this.ourSecretKey,
      conversationId,
      envelope,
    );
    for (const wrap of wraps) {
      await this.publishWrap(wrap as unknown as NTNostrEvent);
    }
  }

  /**
   * Group egress. Mirrors the PWA's `GroupAPI.sendMessage` wire contract so a
   * reply we send into a group is indistinguishable from a PWA-sent one.
   *
   * The rumor `content` is the GROUP message payload `{content, type, id,
   * timestamp}` — NOT the DM envelope `{id, from, to, type, content,
   * timestamp}`. Two differences vs the DM path, both load-bearing:
   *   - There is NO `from`/`to`: a group rumor has multiple recipients, so the
   *     PWA's `parseGroupRumorContent` ignores those fields entirely.
   *   - `id` is a `grp-<ms>-<rand>` string (the PWA's messageId shape). It MUST
   *     be non-empty: the PWA's `parseGroupRumorContent` returns null (drops the
   *     message) when `id` is falsy.
   * `type` is always "text" — phantombot only sends text.
   *
   * The `['group', groupId]` rumor tag (added by wrapGroupMessage) is what the
   * PWA's inbound router keys on to thread the reply into the group instead of a
   * 1:1 DM — so getting the wrap right is exactly what makes Lena's reply land
   * in HQ rather than her DM.
   */
  async sendGroupMessage(
    groupId: string,
    memberHexes: string[],
    text: string,
  ): Promise<void> {
    // Defensively drop our own hex and dedupe: wrapGroupMessage adds the
    // self-wrap, and a member list that included us would double-wrap to
    // ourselves. (callers pass everyone-but-us, but the inbound p-tags are
    // attacker-adjacent data so we don't trust them to already exclude us.)
    const ourHexLower = this.ourPubHex.toLowerCase();
    const others = [
      ...new Set(memberHexes.map((h) => h.toLowerCase())),
    ].filter((h) => h !== ourHexLower);

    // Nobody to reach (we'd only build a self-wrap). Skip — matches the PWA's
    // otherMembers-empty case being a no-broadcast.
    if (others.length === 0) return;

    const timestampMs = Date.now();
    const messageId = `grp-${timestampMs}-${crypto.randomUUID().slice(0, 6)}`;
    const payload = JSON.stringify({
      content: text,
      type: "text",
      id: messageId,
      timestamp: timestampMs,
    });

    const { wraps } = wrapGroupMessage(
      this.ourSecretKey,
      others,
      payload,
      groupId,
    );
    for (const wrap of wraps) {
      await this.publishWrap(wrap as unknown as NTNostrEvent);
    }
  }

  /**
   * Typing indicator. Publishes a NIP-16 EPHEMERAL kind-20001 event signed by
   * our key and p-tagged to the recipient hex. The PWA, subscribed for this
   * kind addressed to itself, injects a native `updateUserTyping` (three-dots,
   * 6s auto-expiry). Because ephemeral events aren't stored by relays, there's
   * nothing to replay on reconnect — no boomerang risk.
   *
   * Best-effort: the engine calls this on every harness chunk (throttled to
   * ~2s), so a single failed publish is harmless and must never throw into the
   * turn loop. `content` is empty — the kind + `#p` tag carry all the meaning.
   *
   * NOTE: unlike `sendMessage`, this is intentionally NOT gift-wrapped. A
   * typing tick is bot→you only, fires every 2s, and self-expires; wrapping it
   * would double-encrypt a throwaway signal. The tradeoff (the relay learns
   * "bot ↔ you active now") matches the posture the app already has for its
   * plaintext kind-7 reactions / kind-5 deletes.
   */
  async sendTyping(conversationId: string, stop?: boolean): Promise<void> {
    try {
      const event = finalizeEvent(
        {
          kind: NOSTR_KIND_TYPING,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["p", conversationId]],
          content: stop ? TYPING_CONTENT_STOP : TYPING_CONTENT_START,
        },
        this.ourSecretKey,
      );
      await this.publishWrap(event as unknown as NTNostrEvent);
    } catch (e) {
      log.debug("phantomchat: sendTyping publish failed", {
        error: (e as Error).message,
      });
    }
  }

  /**
   * Group typing tick. One ephemeral kind-20001 event tagged with the group id
   * and every member's `#p` (so the PWA's `#p:[self]` subscription delivers it to
   * each member). The `['group', groupId]` tag is what makes the PWA render the
   * dots inside the group chat — without it a group-message reply-in-progress
   * shows as a 1:1 DM typing indicator (the HQ mis-routing). `stop` emits the
   * STOP marker. Best-effort; mirrors sendTyping's never-throw contract.
   */
  async sendGroupTyping(
    groupId: string,
    memberHexes: string[],
    stop?: boolean,
  ): Promise<void> {
    const ourHexLower = this.ourPubHex.toLowerCase();
    const others = [
      ...new Set(memberHexes.map((h) => h.toLowerCase())),
    ].filter((h) => h !== ourHexLower);
    if (others.length === 0) return;
    try {
      const event = finalizeEvent(
        {
          kind: NOSTR_KIND_TYPING,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["group", groupId],
            ...others.map((hex) => ["p", hex]),
          ],
          content: stop ? TYPING_CONTENT_STOP : TYPING_CONTENT_START,
        },
        this.ourSecretKey,
      );
      await this.publishWrap(event as unknown as NTNostrEvent);
    } catch (e) {
      log.debug("phantomchat: sendGroupTyping publish failed", {
        error: (e as Error).message,
      });
    }
  }

  /**
   * Presence heartbeat. Publishes ONE NIP-38 kind-30315 event signed by our key,
   * p-tagged to every recipient in `peerHexes`, with `["status","online"]` and
   * content `"online"` — the exact shape phantomchat's presence engine consumes.
   * Like `sendTyping` it is intentionally NOT gift-wrapped (it's a liveness
   * beacon, not private content) and is fully best-effort: a failed publish must
   * never throw into the heartbeat loop. A no-op when there are no peers.
   */
  async sendPresence(peerHexes: string[]): Promise<void> {
    if (peerHexes.length === 0) return;
    try {
      const event = finalizeEvent(
        {
          kind: NOSTR_KIND_PRESENCE,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["d", "general"],
            ["status", "online"],
            ...peerHexes.map((hex) => ["p", hex]),
          ],
          content: "online",
        },
        this.ourSecretKey,
      );
      await this.publishWrap(event as unknown as NTNostrEvent);
    } catch (e) {
      log.debug("phantomchat: sendPresence publish failed", {
        error: (e as Error).message,
      });
    }
  }

  /**
   * Reply to a presence ping. Builds the phantomchat envelope with
   * `type:"presence-pong"` carrying the ping's `nonce`, NIP-17-wraps it to the
   * pinger, and publishes ONLY the recipient wrap (no self-wrap — the bot never
   * reads its own pongs). Best-effort: a failed publish must never throw into
   * the receive loop.
   */
  async sendPresencePong(toHex: string, nonce: string): Promise<void> {
    try {
      const envelope = JSON.stringify({
        id: crypto.randomUUID(),
        from: this.ourPubHex,
        to: toHex,
        type: "presence-pong",
        nonce,
        content: "",
        timestamp: Date.now(),
      });
      const { wraps } = wrapNip17Message(this.ourSecretKey, toHex, envelope);
      // wraps = [recipientWrap, selfWrap]; only the recipient needs the pong.
      const recipientWrap = wraps[0];
      if (recipientWrap) {
        await this.publishWrap(recipientWrap as unknown as NTNostrEvent);
      }
    } catch (e) {
      log.debug("phantomchat: sendPresencePong failed", {
        error: (e as Error).message,
      });
    }
  }

  connectedRelayCount(): number | undefined {
    const status = this.pool.listConnectionStatus?.();
    if (!status) return undefined;
    let n = 0;
    for (const connected of status.values()) if (connected) n++;
    return n;
  }

  close(): void {
    try {
      this.pool.close(this.relays);
    } catch (e) {
      log.warn("phantomchat: pool close threw", { error: (e as Error).message });
    }
  }
}

// Re-export the wrap event type so server/channel code can name it without
// reaching back into nostrCrypto for this one alias.
export type { WrapEvent };
