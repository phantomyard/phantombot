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
  createGiftWrap,
  createRumor,
  createSeal,
  wrapGroupMessage,
  wrapV2,
  wrapTypingGiftWrap,
  wrapGroupTypingGiftWrap,
  type NTNostrEvent as WrapEvent,
} from "../../lib/nostrCrypto.ts";
import { encryptFileBytes } from "./fileEncrypt.ts";
import { uploadToBlossom } from "./blossomUpload.ts";
import {
  oggOpusDurationSeconds,
  oggOpusWaveformBase64,
} from "./oggOpusDuration.ts";

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
 * Typing indicators are now gift-wrapped (kind-1059 → kind-14 rumor) for
 * privacy + collision avoidance. The relay only sees kind-1059 + an
 * ephemeral pubkey — no social graph leak, no kind collision.
 */

/**
 * Typing-event content markers. A kind-30001 event's `content` is the lifecycle
 * signal the PWA reads: empty string = "I'm typing now" (start/refresh);
 * `"stop"` = "I've stopped" (cancel immediately). The bot emits a STOP the
 * instant a reply is published so the PWA clears the dots at once instead of
 * waiting out its 6s auto-expiry — the "typing lingers after the answer" fix.
 */
export const TYPING_CONTENT_START = "";
export const TYPING_CONTENT_STOP = "stop";
/**
 * "Recording voice" marker. A kind-20001 with this content tells the PWA to
 * show the native "recording voice" activity (sendMessageRecordAudioAction)
 * instead of the generic "typing" dots — so a voice reply being synthesized
 * reads as a voice action, mirroring Telegram. Same lifecycle as START (the
 * STOP marker still clears it).
 */
export const TYPING_CONTENT_RECORDING = "recording";

/**
 * How far back (seconds) the live gift-wrap subscription's `since` reaches. With
 * truthful (non-backdated) wrap timestamps this only needs to absorb clock skew
 * between sender, relay and us, plus a brief reconnect gap — not the old 48h
 * backdate window. The periodic catch-up poll (see fetchGiftWrapsSince) is what
 * actually guarantees delivery, so this stays small.
 */
export const GIFTWRAP_SINCE_WINDOW_SEC = 120;

/**
 * Hard timeout (ms) for a one-shot `fetchGiftWrapsSince` pull, in case a slow or
 * dead relay never sends EOSE. We resolve with whatever events arrived so far.
 */
const FETCH_GIFTWRAPS_TIMEOUT_MS = 4000;

/**
 * Hard cap on the one-shot kind-0 profile pull (`fetchProfiles`). Kept short:
 * resolving a sender/member profile gates a reply, so a slow or missing relay
 * answer must fall through quickly to the default (treat as human) rather than
 * stall the turn. The persistent relay backlog and re-fetch-on-miss make a
 * missed profile self-healing on the next message anyway.
 */
const FETCH_PROFILES_TIMEOUT_MS = 3000;

/**
 * The Nostr filter shape we subscribe with. Kept minimal: kind-1059 gift-wraps
 * tagged to our pubkey, from roughly now. We deliberately set `since` to a
 * SMALL window (or omit it) because a gift-wrap's `created_at` is randomized up
 * to 48h INTO THE PAST for metadata privacy — a tight `since` would drop fresh
 * messages. Dedup (by wrap id, then rumor id) is the real guard, not `since`.
 */
export interface NostrFilter {
  kinds: number[];
  /** Recipient p-tag filter (gift-wrap subscriptions). Omitted for `authors`. */
  "#p"?: string[];
  /** Author filter — used by the kind-0 profile pull (`fetchProfiles`). */
  authors?: string[];
  since?: number;
}

/**
 * The slice of a NIP-01 kind-0 profile we read. Everything is optional — a
 * remote profile may omit any field, and `bot` is the NIP-24 automation flag we
 * use to recognise sibling bots (so a bot never replies to another bot).
 */
export interface NostrProfileMeta {
  /** The handle/addressing token (`name`), e.g. "lena". */
  name?: string;
  /** A prettier label (`display_name`); falls back to `name` for addressing. */
  display_name?: string;
  /** NIP-24: the account is (partly) automated. PhantomChat bots publish this. */
  bot?: boolean;
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
    onWrap: (event: NTNostrEvent) => void | Promise<void>,
    onEose?: () => void,
  ): { close(): void };
  /**
   * ONE-SHOT catch-up pull: query the relays for kind-1059 gift-wraps addressed
   * to `ourPubHex` with `created_at >= sinceSec`, resolving with the collected
   * events once the relays signal EOSE (or a short hard timeout fires). This is
   * the delivery backbone: a relay may silently fail to PUSH a freshly-published
   * wrap to an already-live subscription (the proven cause of the "first message
   * ghosts" bug), but the wrap still PERSISTS on the relay, so a periodic pull
   * with a tight `since` recovers it. Caller feeds each event through the same
   * dedup'd `onWrap`, so overlap with the live subscription is harmless. Relies
   * on truthful (non-backdated) wrap timestamps — see nostrCrypto.createGiftWrap.
   */
  fetchGiftWrapsSince(
    ourPubHex: string,
    sinceSec: number,
  ): Promise<NTNostrEvent[]>;
  /**
   * ONE-SHOT profile pull: query the relays for the kind-0 metadata of every
   * pubkey in `authors`, resolving with a hex→profile map once the relays signal
   * EOSE (or a short hard timeout fires). kind-0 is replaceable, so per author we
   * keep the event with the newest `created_at` across relays. Used to recognise
   * which group members / DM senders are bots (NIP-24 `bot` flag) and to derive
   * their addressing names — so a bot replies by name to humans but never to
   * another bot. Best-effort: a missing/unreachable profile simply isn't in the
   * returned map (caller treats absence as "human / unknown"). Never throws.
   */
  fetchProfiles(authors: string[]): Promise<Map<string, NostrProfileMeta>>;
  /** Publish an already-wrapped kind-1059 event to all relays. */
  publishWrap(event: NTNostrEvent): Promise<void>;
  /**
   * Publish (or replace) this identity's NIP-01 kind-0 profile metadata so the
   * PhantomChat PWA shows a real display name for the persona instead of a raw
   * npub, and flags the account as automated. kind 0 is a replaceable event, so
   * re-publishing on each start just supersedes the previous one. Best-effort.
   */
  publishProfile(metadata: { name: string; bot?: boolean; about?: string }): Promise<void>;
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
   * Send a voice note to a 1:1 DM. `audio` is the synthesized OGG/Opus bytes;
   * the transport AES-256-GCM encrypts them, uploads the ciphertext to Blossom,
   * and gift-wraps a `type:"voice"` envelope so the PWA renders a playable
   * bubble. DM-only — group voice is not supported.
   */
  sendVoice(conversationId: string, audio: Buffer, mime: string): Promise<void>;
  /** Show a "recording voice" activity indicator (best-effort). */
  sendRecording(conversationId: string): Promise<void>;
  /**
   * Send a NIP-17 delivery receipt for a received DM back to its sender so the
   * sender's PWA lights the second ("delivered") tick AND stops its always-on
   * resend. `originalMessageId` is the app message id carried in the DM
   * envelope's `id` field — the value the PWA's DeliveryTracker keys on, NOT
   * the Nostr rumor id. Best-effort: never throws into the receive loop.
   */
  sendDeliveryReceipt(toHex: string, originalMessageId: string): Promise<void>;
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
    onWrap: (event: NTNostrEvent) => void | Promise<void>,
    onEose?: () => void,
  ): { close(): void } {
    const filter: NostrFilter = {
      kinds: [1059],
      "#p": [ourPubHex],
      // `since` is now a TIGHT window. Gift-wraps are no longer backdated (see
      // nostrCrypto.createGiftWrap) — a wrap's `created_at` is its real send
      // time — so we no longer need the old 49h window that compensated for the
      // 0–48h backdate. A tight window means a (re)connect replays only the last
      // few minutes instead of 49h of history, which kills the backlog-replay
      // flood that re-ran on every watchdog re-arm. Any message the live push
      // drops is recovered by the periodic fetchGiftWrapsSince poll, not by a
      // wide `since`.
      since: Math.floor(Date.now() / 1000) - GIFTWRAP_SINCE_WINDOW_SEC,
    };
    // Single filter object — NOT `[filter]`. See the RelayPool.subscribeMany
    // doc: nostr-tools wraps it into the per-relay filters array itself, and
    // double-wrapping produces a malformed REQ that delivers nothing.
    return this.pool.subscribeMany(this.relays, filter, {
      onevent: (event) => {
        try {
          const result = onWrap(event);
          // Handle async callbacks — catch errors from the promise
          if (result && typeof result === "object" && "catch" in result) {
            result.catch((e) => {
              log.warn("phantomchat: onWrap handler rejected", {
                error: (e as Error).message,
              });
            });
          }
        } catch (e) {
          log.warn("phantomchat: onWrap handler threw", {
            error: (e as Error).message,
          });
        }
      },
      oneose: onEose,
    });
  }

  fetchGiftWrapsSince(
    ourPubHex: string,
    sinceSec: number,
  ): Promise<NTNostrEvent[]> {
    const filter: NostrFilter = {
      kinds: [1059],
      "#p": [ourPubHex],
      since: sinceSec,
    };
    return new Promise<NTNostrEvent[]>((resolve) => {
      const events: NTNostrEvent[] = [];
      let settled = false;
      let sub: { close(): void } | undefined;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          sub?.close();
        } catch {
          // already torn down — nothing to do.
        }
        resolve(events);
      };
      // Resolve on EOSE (all relays replayed their match set) or the hard
      // timeout, whichever comes first.
      const timer = setTimeout(finish, FETCH_GIFTWRAPS_TIMEOUT_MS);
      sub = this.pool.subscribeMany(this.relays, filter, {
        onevent: (event) => {
          events.push(event);
        },
        oneose: finish,
      });
    });
  }

  fetchProfiles(authors: string[]): Promise<Map<string, NostrProfileMeta>> {
    const out = new Map<string, NostrProfileMeta>();
    // De-dup + lowercase the author list; an empty list resolves immediately.
    const wanted = [...new Set(authors.map((a) => a.toLowerCase()))].filter(
      (a) => a.length > 0,
    );
    if (wanted.length === 0) return Promise.resolve(out);
    // Newest kind-0 wins per author (replaceable event, multiple relays).
    const seenAt = new Map<string, number>();
    const filter: NostrFilter = { kinds: [0], authors: wanted };
    return new Promise<Map<string, NostrProfileMeta>>((resolve) => {
      let settled = false;
      let sub: { close(): void } | undefined;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          sub?.close();
        } catch {
          // already torn down — nothing to do.
        }
        resolve(out);
      };
      const timer = setTimeout(finish, FETCH_PROFILES_TIMEOUT_MS);
      sub = this.pool.subscribeMany(this.relays, filter, {
        onevent: (event) => {
          const author = (event.pubkey ?? "").toLowerCase();
          if (!author) return;
          const at = event.created_at ?? 0;
          if ((seenAt.get(author) ?? -1) >= at) return; // older — keep newest
          let meta: NostrProfileMeta;
          try {
            const parsed = JSON.parse(event.content) as Record<string, unknown>;
            meta = {
              name: typeof parsed.name === "string" ? parsed.name : undefined,
              display_name:
                typeof parsed.display_name === "string"
                  ? parsed.display_name
                  : undefined,
              bot: parsed.bot === true,
            };
          } catch {
            return; // unparseable content — ignore this event
          }
          seenAt.set(author, at);
          out.set(author, meta);
        },
        oneose: finish,
      });
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
   * Publish this identity's NIP-01 kind-0 profile. The content is the standard
   * metadata JSON: `name`/`display_name` (so the PWA shows e.g. "Lena" not the
   * npub) plus NIP-24 `bot: true` to mark the account automated, and optionally
   * a `commands` array so the PWA can render the slash-command `/`-typeahead
   * menu (the decentralized setMyCommands). Signed with our key and published to
   * all relays the same best-effort way as a wrap.
   */
  async publishProfile(metadata: {
    name: string;
    bot?: boolean;
    about?: string;
    /**
     * Slash commands to advertise, `{command, description}` with the bare
     * command name (no leading slash) — the same shape Telegram's setMyCommands
     * / bot_info uses. Published in the kind-0 content under a `commands` key so
     * a client (the PhantomChat PWA) can render the `/`-typeahead menu. This is
     * the decentralized analogue of setMyCommands: the bot owns the list. kind-0
     * content is freeform JSON, so other Nostr clients simply ignore the field.
     */
    commands?: Array<{ command: string; description: string }>;
  }): Promise<void> {
    const content = JSON.stringify({
      name: metadata.name,
      display_name: metadata.name,
      // NIP-24: flags the account as (partly) automated so clients can badge it.
      bot: metadata.bot ?? true,
      ...(metadata.about ? { about: metadata.about } : {}),
      ...(metadata.commands && metadata.commands.length > 0
        ? { commands: metadata.commands }
        : {}),
    });
    const event = finalizeEvent(
      { kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [], content },
      this.ourSecretKey,
    );
    await this.publishWrap(event as unknown as NTNostrEvent);
  }

  /**
   * ChannelTransport egress. `conversationId` is the recipient's 64-char hex
   * pubkey, `text` the plaintext reply.
   *
   * The rumor `content` on the wire is the PLAIN reply text — standard NIP-17,
   * so 0xchat/Amethyst can read Lena's replies. (We used to wrap it in the
   * phantomchat JSON envelope `{id, from, to, type, content, timestamp}`, but
   * every field there is redundant with native rumor fields: from=rumor.pubkey,
   * to=p-tag, timestamp=created_at, id=rumor id — and the PWA dual-reads plain
   * text.) Groups keep the envelope (see sendGroupMessage) — they don't interop
   * with stock clients and the PWA's GroupAPI still expects that shape.
   */
  async sendMessage(conversationId: string, text: string): Promise<void> {
    const { event } = await wrapV2(
      this.ourSecretKey,
      conversationId,
      text,
    );
    await this.publishWrap(event as unknown as NTNostrEvent);
  }

  /**
   * Voice egress (1:1 DM). Mirrors the PWA's send-file pipeline in reverse of
   * blossomFetch: AES-256-GCM encrypt the audio, upload the ciphertext to
   * Blossom, then NIP-17-wrap a `type:"voice"` DM envelope whose `content` is
   * the JSON file-metadata blob the PWA's extractFileMetadata reads
   * (`{url, sha256, key, iv, mimeType, size, mediaType:"voice"}`). The rumor is
   * a kind-14 like text (the PWA's receive path accepts kind-14 media — see
   * chat-api-receive.ts extractFileMetadata). `conversationId` is the recipient
   * hex pubkey.
   */
  async sendVoice(
    conversationId: string,
    audio: Buffer,
    mime: string,
  ): Promise<void> {
    const mimeType = mime || "audio/ogg";
    const enc = encryptFileBytes(audio);
    const { url } = await uploadToBlossom(
      enc.ciphertext,
      enc.sha256Hex,
      this.ourSecretKey,
      mimeType,
    );
    // File metadata travels INSIDE the envelope's `content` (a JSON string), so
    // the recipient JSON.parses the envelope, then JSON.parses content → meta.
    // `size` is the PLAINTEXT byte count (matches the PWA's blob.size).
    // Playback duration (seconds) so the recipient's bubble shows the real
    // length instead of 0:00. 0 ⇒ unparseable; omit and let the player fall
    // back rather than stamp a bogus length.
    const durationS = oggOpusDurationSeconds(audio);
    // Amplitude envelope (base64, 5-bit Telegram packing) so the bubble draws
    // the little bars. Derived from Opus packet sizes — a cheap container walk,
    // no decode. "" ⇒ unparseable; omit and let the bubble show length-only.
    const waveform = oggOpusWaveformBase64(audio);
    const fileMeta = JSON.stringify({
      url,
      sha256: enc.sha256Hex,
      mimeType,
      size: audio.length,
      key: enc.keyHex,
      iv: enc.ivHex,
      // Authoritative media class so the receiver never re-guesses voice vs file.
      mediaType: "voice",
      ...(durationS > 0 ? { duration: durationS } : {}),
      ...(waveform ? { waveform } : {}),
    });
    const envelope = JSON.stringify({
      id: `pc-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`,
      from: this.ourPubHex,
      to: conversationId,
      type: "voice",
      content: fileMeta,
      timestamp: Date.now(),
    });
    const { event } = await wrapV2(this.ourSecretKey, conversationId, envelope);
    await this.publishWrap(event as unknown as NTNostrEvent);
  }

  /**
   * "Recording voice" indicator. Same ephemeral kind-20001 tick as typing, but
   * the content marker is `"recording"` so the PWA renders the native
   * "recording voice" activity instead of the generic dots. Best-effort; never
   * throws (the engine fires this every couple seconds while synthesizing).
   */
  async sendRecording(conversationId: string): Promise<void> {
    try {
      const wrap = wrapTypingGiftWrap(
        this.ourSecretKey,
        conversationId,
        TYPING_CONTENT_RECORDING,
        conversationId,
      );
      await this.publishWrap(wrap);
    } catch (e) {
      log.debug("phantomchat: sendRecording publish failed", {
        error: (e as Error).message,
      });
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
   * Typing indicator. Publishes a NIP-17 gift-wrapped (kind-1059) typing tick.
   * The inner kind-14 rumor carries the typing content and ['d', conversationId]
   * tag; the outer kind-1059 is signed with an ephemeral key (NIP-17 parity).
   * The relay only sees kind-1059 + an ephemeral pubkey — no social graph leak,
   * no kind collision. Late reconnects replay via backfill (relays store
   * kind-1059 events), and client-side 6s auto-expiry handles stale cleanup.
   *
   * Best-effort: the engine calls this on every harness chunk (throttled to
   * ~2s), so a single failed publish is harmless and must never throw into the
   * turn loop.
   */
  async sendTyping(conversationId: string, stop?: boolean): Promise<void> {
    try {
      const content = stop ? TYPING_CONTENT_STOP : TYPING_CONTENT_START;
      const wrap = wrapTypingGiftWrap(
        this.ourSecretKey,
        conversationId,
        content,
        conversationId,
      );
      await this.publishWrap(wrap);
    } catch (e) {
      log.debug("phantomchat: sendTyping publish failed", {
        error: (e as Error).message,
      });
    }
  }

  /**
   * Group typing tick. Gift-wraps (kind-1059) the typing rumor separately for
   * each group member. The inner kind-14 rumor carries ['d', groupId] and
   * ['group', groupId] tags; each outer kind-1059 is signed with its own
   * ephemeral key. The `['group', groupId]` tag is what makes the PWA render
   * the dots inside the group chat — without it a group-message reply-in-progress
   * shows as a 1:1 DM typing indicator (the HQ mis-routing).
   *
   * Best-effort; mirrors sendTyping's never-throw contract.
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
      const content = stop ? TYPING_CONTENT_STOP : TYPING_CONTENT_START;
      const wraps = wrapGroupTypingGiftWrap(
        this.ourSecretKey,
        others,
        content,
        groupId,
      );
      for (const wrap of wraps) {
        await this.publishWrap(wrap);
      }
    } catch (e) {
      log.debug("phantomchat: sendGroupTyping publish failed", {
        error: (e as Error).message,
      });
    }
  }

  /**
   * Send a NIP-17 delivery receipt for a received DM back to its sender. The
   * PWA's DeliveryTracker keys outgoing messages by the app message id carried
   * in the envelope's `id` field, so `originalMessageId` MUST be that value
   * (NOT the Nostr rumor id). The receipt is a kind-14 rumor with empty content
   * and tags `[['e', originalMessageId], ['receipt-type','delivery'], ['p', toHex]]`,
   * gift-wrapped to the sender only (no self-wrap — we never read our own
   * receipts). This is what lights the second tick on Andrew's side AND lets the
   * PWA's retry layer stop re-sending once we've actually got the message.
   * Best-effort: a failed publish must never throw into the receive loop.
   */
  async sendDeliveryReceipt(toHex: string, originalMessageId: string): Promise<void> {
    try {
      const rumor = createRumor("", this.ourSecretKey, [
        ["e", originalMessageId],
        ["receipt-type", "delivery"],
        ["p", toHex],
      ]);
      const seal = createSeal(rumor, this.ourSecretKey, toHex);
      const giftWrap = createGiftWrap(seal, toHex);
      await this.publishWrap(giftWrap as unknown as NTNostrEvent);
    } catch (e) {
      log.debug("phantomchat: sendDeliveryReceipt failed", {
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
