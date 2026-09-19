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
  rewrapV2,
  wrapV2,
  type NTNostrEvent as WrapEvent,
} from "../../lib/nostrCrypto.ts";
import { encryptFileBytes } from "./fileEncrypt.ts";
import { uploadToBlossom } from "./blossomUpload.ts";
import {
  makeRelayAuthSigner,
  type RelayAuthSigner,
} from "./relayAuth.ts";
import { RelayHealthTracker } from "./relayHealth.ts";
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
 * Publish read-back verification (issue #368). A relay can answer a publish
 * with `OK:true` and still never store the event — observed in production on
 * nostr-rs-relay with `nip42_auth = true`, where the unauthenticated publish
 * was acknowledged and silently dropped. After each publish of a STORABLE
 * event we therefore re-query each relay for the event id; a relay that
 * doesn't return it gets named in a warning instead of failing silently.
 *
 * `PUBLISH_READBACK_SETTLE_MS` gives the relay a beat to index before we ask
 * (avoids false positives on relays that store asynchronously);
 * `PUBLISH_READBACK_TIMEOUT_MS` caps the per-relay query so a dead relay
 * can't stall the check. The whole verification runs detached — it only ever
 * logs, never blocks or rejects the send path.
 */
export const PUBLISH_READBACK_SETTLE_MS = 750;
/**
 * Raised 2500 → 5000 with issue #359. The read-back result is no longer just a
 * log line — it now drives quarantine — so a false negative has a real cost (a
 * merely SLOW relay could be scored as a DROPPING one). 5s is well clear of
 * observed p99 index+query latency on the healthy relays, and the check is
 * detached, so the extra patience costs the send path nothing.
 */
export const PUBLISH_READBACK_TIMEOUT_MS = 5000;

/** Two independently verified relay copies are enough to call delivery confirmed. */
export const PUBLISH_CONFIRM_QUORUM = 2;

/**
 * Outbound delivery retry (issue #542).
 *
 * The delivery guarantee used to be ONE-WAY. PWA→bot has the full double tick:
 * the bot sends a NIP-17 delivery receipt and the PWA's DeliveryTracker retries
 * with a fresh outer wrap at 8s/20s/45s until it lights. bot→PWA had neither —
 * `verifyStored` re-queried each relay and, on a miss, only warned and fed the
 * quarantine. An agent reply that landed on no readable relay was lost
 * silently and permanently, with the PWA's 15s catch-up poll (reading the SAME
 * relay set that just failed) as the only backstop.
 *
 * These are the PWA's own schedule, deliberately: the two sides of one
 * conversation should give up at the same point, and 8/20/45 is already tuned
 * against real relay recovery times.
 *
 * A retry fires ONLY when the read-back proves the wrap is readable from ZERO
 * relays AND the peer did not acknowledge it over P2P — i.e. only when the
 * message is genuinely lost. Each attempt re-envelopes the SAME rumor
 * (`rewrapV2`), so relays see a new event id while the recipient dedups on the
 * unchanged rumor id.
 */
export const OUTBOUND_RETRY_DELAYS_MS = [8_000, 20_000, 45_000] as const;

export interface PublishWrapOptions {
  /**
   * Build a FRESH outer envelope around the same inner rumor, for delivery
   * retry (issue #542). Supplying it opts this publish into the retry ladder;
   * omitting it keeps the pre-#542 fire-and-warn behaviour, which is what
   * every non-message publish (profiles, receipts, typing) wants.
   */
  rewrap?: () => Promise<NTNostrEvent>;
  /** Human label for the give-up log, e.g. "dm" or "group". */
  label?: string;
}

/**
 * Warm-spare probe cadence. The channel's existing 15-second catch-up loop
 * offers the opportunity, while this gate limits actual probes to roughly one
 * per minute with ±25% jitter. Publish volume never enters this calculation.
 */
export const RELAY_HEALTH_PROBE_INTERVAL_MS = 60_000;
export const RELAY_HEALTH_PROBE_JITTER = 0.25;

/**
 * nostr-tools' `SimplePool.publish` does NOT reject when it can't reach a
 * relay: it RESOLVES that relay's promise with the string
 * `"connection failure: …"`. Counting every fulfilled promise as an accept
 * therefore scored a dead relay as a success. This is the one place that tells
 * a real accept from that.
 */
export function isRelayConnectionFailure(reason: unknown): boolean {
  return typeof reason === "string" && reason.startsWith("connection failure");
}

/**
 * The Nostr filter shape we subscribe with. Kept minimal: kind-1059 gift-wraps
 * tagged to our pubkey, from roughly now. We deliberately set `since` to a
 * SMALL window (or omit it) because a gift-wrap's `created_at` is randomized up
 * to 48h INTO THE PAST for metadata privacy — a tight `since` would drop fresh
 * messages. Dedup (by wrap id, then rumor id) is the real guard, not `since`.
 */
export interface NostrFilter {
  kinds?: number[];
  /** Recipient p-tag filter (gift-wrap subscriptions). Omitted for `authors`. */
  "#p"?: string[];
  /** Author filter — used by the kind-0 profile pull (`fetchProfiles`). */
  authors?: string[];
  /** Event-id filter — used by the publish read-back check (issue #368). */
  ids?: string[];
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
    params: {
      onevent: (event: NTNostrEvent) => void;
      oneose?: () => void;
      /**
       * NIP-42 signer for relays that close the subscription demanding AUTH
       * (`auth-required:`). nostr-tools authenticates and re-subscribes. Optional
       * so in-memory test fakes don't have to implement it; the real SimplePool
       * passes it straight through.
       */
      onauth?: RelayAuthSigner;
    },
  ): { close(): void };
  /**
   * Publish `event` to every relay. Returns one promise per relay. `onauth`
   * is the NIP-42 signer used when a relay rejects the publish with
   * `auth-required:` — nostr-tools then authenticates and retries the publish
   * once. Optional for test fakes; the real SimplePool honours it.
   */
  publish(
    relays: string[],
    event: NTNostrEvent,
    params?: { onauth?: RelayAuthSigner },
  ): Promise<string>[];
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
  /**
   * Subscribe for inbound events addressed to `ourPubHex`. This ONE p-tagged
   * subscription carries kind-1059 gift-wrapped DMs AND plaintext emoji-reaction
   * signals — NIP-25 kind-7 reactions and NIP-09 kind-5 deletions — because they
   * all target us by `#p` and folding them into a single REQ reuses the whole
   * self-heal / re-arm / catch-up machinery instead of duplicating it. `onWrap`
   * fires per raw event; the caller branches on `event.kind` (7/5 = reaction,
   * else gift-wrap) and dedups by event id.
   */
  subscribeGiftWraps(
    ourPubHex: string,
    onWrap: (event: NTNostrEvent) => void | Promise<void>,
    onEose?: () => void,
  ): { close(): void };
  /**
   * Register a recorder invoked after each text message we publish with
   * `(recipientHex, rumorId, text)`. The server wires this to its
   * `RecentOutbound` map so an inbound kind-7 reaction — which names the
   * reacted-to message by its rumor id in an `['e', ...]` tag — can be
   * correlated back to the message text. Optional; in-memory test fakes omit it.
   */
  setOutboundRecorder?(
    fn: (recipientHex: string, rumorId: string, text: string) => void,
  ): void;
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
  /**
   * Publish an already-wrapped event to the relays. Resolves as soon as ONE
   * relay accepted it or the recipient peer acknowledged it over P2P —
   * whichever is first — or once every relay has failed. The remaining relays
   * keep publishing in the background. Never rejects.
   */
  publishWrap(event: NTNostrEvent, opts?: PublishWrapOptions): Promise<void>;
  /**
   * Wait for every background relay publish still in flight to settle. A
   * one-shot caller (notify) calls this before close(), so returning early
   * from publishWrap never cuts the redundant relay copies short.
   */
  flush?(): Promise<void>;
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
 * Tee for every published event, wired to the P2P bridge. May resolve true to
 * report that the recipient peer ACKNOWLEDGED the wrap over the data channel.
 */
export type PublishObserver = (
  event: NTNostrEvent,
) => boolean | void | Promise<boolean | void>;

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
  /**
   * Flipped by close(). The publish read-back (verifyStored) is deliberately
   * detached from the send path so it never blocks delivery, but a one-shot
   * caller (e.g. `notify`) must be able to fully tear the pool down and exit:
   * once closed, the read-back must not re-open relay connections — doing so
   * leaves a live WebSocket in the pool that keeps the process alive forever.
   */
  private closed = false;
  /** Our 64-char hex pubkey — the `from` field of every reply envelope. */
  private readonly ourPubHex: string;
  /**
   * Optional tee for every published gift-wrap, wired to the P2P bridge so a
   * reply also goes out over WebRTC (see channelBridge.routeOutbound). Fires for
   * BOTH the recipient wrap and the multi-device self-wrap; the node drops the
   * self-wrap (recipient === us). Null when P2P is disabled.
   */
  private publishObserver: PublishObserver | null = null;

  /** Background relay publishes still settling — drained by flush(). */
  private readonly inflight = new Set<Promise<void>>();

  /**
   * Pending outbound-retry sleeps (issue #542), so `close()` can cancel them.
   *
   * Retries are deliberately NOT in `inflight`: `flush()` is what a one-shot
   * caller (`phantombot notify`) awaits before tearing the pool down, and a
   * full retry ladder is ~73s — long enough to look like a hung CLI. A
   * one-shot send therefore keeps its pre-#542 behaviour (publish, read-back,
   * warn) while the long-lived listener, which is what the issue is about,
   * gets the ladder.
   */
  private readonly retryTimers = new Map<
    ReturnType<typeof setTimeout>,
    () => void
  >();

  /**
   * Set by the server (see setOutboundRecorder) to record each sent text
   * message's rumor id → text into its RecentOutbound map, so an inbound emoji
   * reaction can be correlated to the message it targets. Null until wired.
   */
  private outboundRecorder:
    | ((recipientHex: string, rumorId: string, text: string) => void)
    | null = null;

  /**
   * The NIP-42 signer for this persona (issue #368). Handed to the pool on
   * every publish and subscription so a relay that demands AUTH — whether by
   * rejecting the publish with `auth-required:` or by closing the REQ — gets
   * a signed kind-22242 response and the operation is retried authenticated.
   * Without this a `nip42_auth = true` relay silently drops everything we
   * publish (it answers `OK:true` and never stores the event).
   */
  private readonly authSigner: RelayAuthSigner;

  /**
   * Per-relay read-back health (issue #359). Consulted on every publish to pick
   * the target set, and fed by the read-back pass that already runs after each
   * publish. Quarantine is PUBLISH-ONLY: `this.relays` — the subscription set —
   * is never narrowed, so a quarantined relay keeps its socket and its reads,
   * and promoting it back later costs nothing. See relayHealth.ts.
   */
  readonly relayHealth: RelayHealthTracker;
  /** Last event each relay independently proved it stores, used by probes. */
  private readonly lastConfirmedEventByRelay = new Map<string, string>();
  private nextRelayHealthProbeAt = 0;
  private relayHealthProbeRunning = false;
  private relayHealthProbeCursor = 0;

  constructor(
    private readonly ourSecretKey: Uint8Array,
    relays: string[],
    private readonly pool: RelayPool,
    private readonly probeJitter: () => number = () =>
      1 + (Math.random() * 2 - 1) * RELAY_HEALTH_PROBE_JITTER,
    /**
     * Timing overrides — TESTS ONLY, same seam convention as `probeJitter`
     * above. Production uses the PWA's 8s/20s/45s ladder and the standard
     * read-back timings; a test can wait for neither. `readback` applies to
     * EVERY read-back this transport runs, including the one after the first
     * publish — otherwise a test asserting that NO retry happened would pass
     * simply by finishing before the 750ms settle, which is no assertion at
     * all.
     */
    private readonly testTiming: {
      retryDelaysMs?: readonly number[];
      readback?: { settleMs?: number; timeoutMs?: number };
    } = {},
  ) {
    this.relays = [...relays];
    this.ourPubHex = getPublicKey(ourSecretKey);
    this.authSigner = makeRelayAuthSigner(ourSecretKey);
    this.relayHealth = new RelayHealthTracker(this.relays, {
      info: (msg, meta) => log.info(msg, meta as Record<string, unknown>),
      debug: (msg, meta) => log.debug(msg, meta as Record<string, unknown>),
    });
  }

  /**
   * Register (or clear) a tee invoked with every wrap passed to `publishWrap`,
   * fired BEFORE the relay round-trip so P2P delivery isn't gated on relay
   * latency. Best-effort: a throwing observer must never break a publish.
   */
  setPublishObserver(observer: PublishObserver | null): void {
    this.publishObserver = observer;
  }

  setOutboundRecorder(
    fn: (recipientHex: string, rumorId: string, text: string) => void,
  ): void {
    this.outboundRecorder = fn;
  }

  subscribeGiftWraps(
    ourPubHex: string,
    onWrap: (event: NTNostrEvent) => void | Promise<void>,
    onEose?: () => void,
  ): { close(): void } {
    const filter: NostrFilter = {
      // 1059 = gift-wrapped DM; 7 = NIP-25 emoji reaction; 5 = NIP-09 deletion
      // (a reaction removed). All three target us by `#p`, so one subscription
      // carries them and the caller branches on `event.kind`. Reactions are
      // plaintext (not wrapped) — see the channel's onWrap dispatch.
      kinds: [1059, 7, 5],
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
      // NIP-42: relays that gate reads behind AUTH close the REQ with
      // `auth-required:` — the signer lets nostr-tools authenticate and
      // re-subscribe instead of silently delivering nothing.
      onauth: this.authSigner,
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
      // Mirror subscribeGiftWraps: 1059 = gift-wrapped DM; 7 = NIP-25 emoji
      // reaction; 5 = NIP-09 deletion (a reaction removed). The catch-up poll
      // must carry the SAME kinds as the live subscription, otherwise a
      // reaction/deletion missed by the live push is never recovered by the
      // periodic self-heal. Results flow through the caller's onWrap, which
      // branches on event.kind (reactions → handleReaction, dedup'd by id).
      kinds: [1059, 7, 5],
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
        // The catch-up poll owns cadence, so probe traffic cannot scale with
        // publishes. Detached: health recovery never delays inbound delivery.
        void this.probeQuarantinedRelay().catch((e) => {
          log.debug("phantomchat: relay health probe failed", {
            error: (e as Error).message,
          });
        });
      };
      // Resolve on EOSE (all relays replayed their match set) or the hard
      // timeout, whichever comes first.
      const timer = setTimeout(finish, FETCH_GIFTWRAPS_TIMEOUT_MS);
      sub = this.pool.subscribeMany(this.relays, filter, {
        onauth: this.authSigner,
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
        onauth: this.authSigner,
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

  /**
   * How many retry sleeps are pending. Read by the test that proves `close()`
   * actually cancels them — cancellation is otherwise invisible, since a retry
   * that wakes after close is turned away by the `closed` check either way and
   * publishes nothing in both cases. What differs is whether the timer held
   * the event loop open until it fired.
   */
  get pendingRetries(): number {
    return this.retryTimers.size;
  }

  /**
   * Sleep, resolving `false` if the transport closes first. Every retry delay
   * goes through here so a shutdown never has to wait out a 45s backoff, and a
   * pending retry can't hold a relay socket open past `close()`.
   */
  private wait(ms: number): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.retryTimers.delete(timer);
        resolve(true);
      }, ms);
      this.retryTimers.set(timer, () => resolve(false));
    });
  }

  /**
   * Re-send a wrap the relays did not store (issue #542), on the PWA's own
   * 8s/20s/45s ladder.
   *
   * Each attempt re-envelopes the SAME rumor: relays see a new event id (so
   * they don't dedup the retry away) while the recipient sees the same rumor id
   * (so it dedups a copy it already has instead of rendering it twice). Stops
   * the moment ANY relay confirms storage — one readable copy is all the
   * recipient's catch-up poll needs.
   *
   * Never throws. Exhausting the ladder is logged at ERROR, because at that
   * point a reply the user is waiting for is genuinely gone and the only other
   * evidence would have been silence.
   */
  private async retryOutbound(
    rewrap: () => Promise<NTNostrEvent>,
    originalEventId: string,
    label: string,
  ): Promise<void> {
    const delays = this.testTiming.retryDelaysMs ?? OUTBOUND_RETRY_DELAYS_MS;
    for (let attempt = 0; attempt < delays.length; attempt++) {
      const delay = delays[attempt]!;
      if (!(await this.wait(delay))) return;
      if (this.closed) return;

      let fresh: NTNostrEvent;
      try {
        fresh = await rewrap();
      } catch (err) {
        log.warn("phantomchat: could not re-wrap for delivery retry", {
          originalEventId,
          error: (err as Error).message,
        });
        return;
      }
      // rewrap() is async (fresh ephemeral key + AES). A close() during it must
      // not be followed by relay work: publishing into a closed pool re-opens
      // sockets after teardown.
      if (this.closed) return;

      const targets = this.relayHealth.publishTargets();
      log.info("phantomchat: retrying undelivered wrap", {
        label,
        originalEventId,
        eventId: fresh.id,
        attempt: attempt + 1,
        of: delays.length,
        relays: targets.length,
      });
      await Promise.all(this.publishToTargets(fresh, targets));
      // Same again on the other side of publish settlement, before the
      // read-back arms its settle timer and re-queries every relay. Today
      // verifyStored() re-checks `closed` on entry too, so this line is
      // belt-and-braces — it keeps the ladder correct on its own terms rather
      // than relying on a callee's internal guard, which is the kind of
      // dependency that breaks silently when the callee is refactored.
      if (this.closed) return;
      const missing = await this.verifyStored(
        fresh,
        this.testTiming.readback,
        targets,
      );
      if (this.closed) return;
      if (targets.length > 0 && missing.length < targets.length) {
        log.info("phantomchat: undelivered wrap recovered on retry", {
          label,
          originalEventId,
          eventId: fresh.id,
          attempt: attempt + 1,
          confirmed: targets.length - missing.length,
        });
        return;
      }
    }
    log.error("phantomchat: outbound message LOST after every retry", {
      label,
      originalEventId,
      attempts: delays.length,
    });
  }

  /**
   * Publish one event to `targets` and score each relay's answer. Returns one
   * promise per target: did that relay really accept?
   *
   * Extracted so the retry ladder (#542) republishes through EXACTLY the same
   * path as a first attempt — same NIP-42 signer, same accept-latency scoring,
   * same connection-failure classification. A second, drifting copy of this is
   * how a retry quietly stops feeding relay health.
   */
  private publishToTargets(
    event: NTNostrEvent,
    targets: readonly string[],
  ): Promise<boolean>[] {
    const startedAt = Date.now();
    let perRelay: Promise<string>[];
    try {
      perRelay = this.pool.publish([...targets], event, {
        onauth: this.authSigner,
      });
    } catch (err) {
      perRelay = targets.map(() => Promise.reject(err));
    }
    return perRelay.map((p, i) => {
      const relay = targets[i];
      const score = (accepted: boolean): boolean => {
        if (relay) {
          this.relayHealth.recordAccept(relay, Date.now() - startedAt, accepted);
        }
        return accepted;
      };
      return p.then(
        (reason) => score(!isRelayConnectionFailure(reason)),
        () => score(false),
      );
    });
  }

  async publishWrap(
    event: NTNostrEvent,
    opts?: PublishWrapOptions,
  ): Promise<void> {
    // Tee to the P2P bridge FIRST so a reply races out over WebRTC in parallel
    // with the relay publish, not after it. The bridge answers with whether the
    // peer ACKNOWLEDGED the wrap (a P2P delivery receipt). Guarded so a bridge
    // fault can never break relay delivery — the relay is the floor.
    let p2pAcked: Promise<boolean> = Promise.resolve(false);
    if (this.publishObserver) {
      try {
        const result = this.publishObserver(event);
        p2pAcked = Promise.resolve(result).then(
          (v) => v === true,
          () => false,
        );
      } catch (err) {
        log.debug("phantomchat: publish observer threw", {
          error: (err as Error).message,
        });
      }
    }
    // Publish only to relays currently trusted to store what we send, and not
    // consistently slow (issue #359 + slow-relay quarantine). Never fewer than
    // MIN_PUBLISH_RELAYS: the floor outranks the quarantine. `onauth` is the
    // NIP-42 signer (issue #368).
    const targets = this.relayHealth.publishTargets();
    const outcomes = this.publishToTargets(event, targets);

    // THE FIX for "every send waits for the slowest relay". We used to
    // `await Promise.allSettled(...)` here, so one bad relay cost each message
    // its full connect + ack timeout (up to ~16s with a NIP-42 retry), and each
    // bubble of a multi-bubble reply stacked it again. Now the send returns on
    // the FIRST relay accept; the others carry on in the background for
    // redundancy, history and multi-device, and still feed health + read-back.
    const firstAccept = new Promise<boolean>((resolve) => {
      let pending = outcomes.length;
      if (pending === 0) {
        resolve(false);
        return;
      }
      for (const o of outcomes) {
        void o.then((ok) => {
          if (ok) resolve(true);
          else if (--pending === 0) resolve(false);
        });
      }
    });

    const settled = Promise.all(outcomes).then(async (accepted) => {
      if (!accepted.some(Boolean)) {
        const viaP2P = await p2pAcked;
        log.warn("phantomchat: publish failed on all relays", {
          relays: targets.length,
          eventId: event.id,
          deliveredOverP2P: viaP2P,
        });
      }
      // Read-back verification (issue #368): even an `OK:true` publish may
      // never be stored — re-query each relay for the event id and warn,
      // naming the relays. Detached, and started only once every relay has
      // answered, so a merely SLOW relay isn't scored as a dropping one.
      //
      // Delivery retry (issue #542) hangs off the read-back, and stays DETACHED
      // with it. `settled` is what `flush()` drains, so awaiting the read-back
      // here would make a one-shot send wait out its settle + per-relay timeout
      // — and the retry ladder on top of that.
      void this.verifyStored(event, this.testTiming.readback, targets)
        .then(async (missing) => {
          const rewrap = opts?.rewrap;
          if (!rewrap) return;
          // Only when the wrap is readable from ZERO relays: one surviving copy
          // is all the recipient's catch-up poll needs, and re-sending on a
          // partial miss would multiply traffic for nothing.
          if (targets.length === 0 || missing.length < targets.length) return;
          if (await p2pAcked) {
            // The peer acknowledged the wrap over WebRTC, so it HAS the
            // message. Relay storage failing after that is a redundancy
            // problem, not a delivery one, and the quarantine already
            // recorded it.
            log.debug("phantomchat: relays dropped a wrap the peer already has", {
              eventId: event.id,
            });
            return;
          }
          await this.retryOutbound(rewrap, event.id, opts?.label ?? "wrap");
        })
        .catch((err: unknown) => {
          log.debug("phantomchat: delivery retry chain threw", {
            eventId: event.id,
            error: (err as Error).message,
          });
        });
    });
    const tracked: Promise<void> = settled
      .catch(() => {})
      .finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);

    // Return on whichever lands first: a relay accept, or a P2P receipt from
    // the recipient. If one side comes back empty, wait for the other — so a
    // P2P-only delivery during a relay outage still counts, and every relay
    // failing is still reported. Both sides are bounded (nostr-tools publish
    // timeouts; the node's ack window), so this can't hang.
    await Promise.race([
      firstAccept.then((ok) => ok || p2pAcked),
      p2pAcked.then((ok) => ok || firstAccept),
    ]);
  }

  async flush(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.all([...this.inflight]);
    }
  }

  /**
   * Read-back check for a freshly published event (issue #368). For every
   * relay, query `{ids: [event.id]}` after a short settle delay; a relay that
   * doesn't return the event within the timeout never stored it — warn and
   * name it. Returns the list of relays where the event was NOT confirmed, so
   * tests can assert directly. Never throws; a failed read-back is itself just
   * a debug log (the relay may simply be slow, and the periodic catch-up poll
   * remains the delivery backstop).
   *
   * Skipped for EPHEMERAL events (kinds 20000–29999, NIP-16 — typing ticks):
   * relays don't store those by design, so a read-back would always "fail".
   *
   * `timing` overrides the settle delay / query timeout — tests only.
   */
  async verifyStored(
    event: NTNostrEvent,
    timing?: { settleMs?: number; timeoutMs?: number },
    targets: readonly string[] = this.relays,
  ): Promise<string[]> {
    if (this.closed) return [];
    if (event.kind >= 20000 && event.kind < 30000) return [];
    const missing: string[] = [];
    await new Promise((r) =>
      setTimeout(r, timing?.settleMs ?? PUBLISH_READBACK_SETTLE_MS),
    );
    // close() may have run while we settled — a one-shot caller closes the pool
    // right after the send resolves, and the read-back settle is intentionally
    // slower than that. Re-opening connections now would leak a live socket
    // past teardown and keep the process alive; bail out instead.
    if (this.closed) return [];
    await Promise.all(
      targets.map(async (relay) => {
        const found = await this.readBackOne(relay, event.id, timing?.timeoutMs);
        if (!found) missing.push(relay);
        else this.lastConfirmedEventByRelay.set(relay, event.id);
        // Feed the quarantine tracker (issue #359). This is the ONLY health
        // signal in the system — derived from traffic we were already sending,
        // so relay health costs zero additional requests.
        this.relayHealth.record(relay, found);
      }),
    );
    const confirmed = targets.length - missing.length;
    if (confirmed >= PUBLISH_CONFIRM_QUORUM) {
      log.info(`phantomchat: publish confirmed delivered via ${confirmed} relays`, {
        eventId: event.id,
        kind: event.kind,
        confirmed,
        relays: targets.length,
      });
    } else if (missing.length === 0) {
      log.warn(
        `phantomchat: publish confirmed by ${confirmed} relay — below quorum`,
        {
          eventId: event.id,
          kind: event.kind,
          confirmed,
          quorum: PUBLISH_CONFIRM_QUORUM,
          relays: targets.length,
        },
      );
    } else {
      log.warn(
        "phantomchat: publish NOT confirmed stored — relay quorum not met",
        {
          eventId: event.id,
          kind: event.kind,
          confirmed,
          quorum: PUBLISH_CONFIRM_QUORUM,
          missing,
          relays: targets.length,
        },
      );
    }
    return missing;
  }

  /**
   * Probe at most one quarantined warm spare per jittered cadence window using
   * an event that relay previously confirmed. Called by the fixed-rate inbound
   * catch-up loop, never by publishWrap, so heavy send traffic creates no extra
   * probes. Returns whether a query was attempted (test/diagnostic seam).
   */
  async probeQuarantinedRelay(now = Date.now()): Promise<boolean> {
    if (this.closed || this.relayHealthProbeRunning) return false;
    if (this.nextRelayHealthProbeAt === 0) {
      this.nextRelayHealthProbeAt = now + Math.round(
        RELAY_HEALTH_PROBE_INTERVAL_MS * this.probeJitter(),
      );
      return false;
    }
    if (now < this.nextRelayHealthProbeAt) return false;
    this.nextRelayHealthProbeAt = now + Math.round(
      RELAY_HEALTH_PROBE_INTERVAL_MS * this.probeJitter(),
    );

    const candidates = this.relayHealth.probeEligibleRelays(now).filter(
      (relay) => this.lastConfirmedEventByRelay.has(relay),
    );
    if (candidates.length === 0) return false;
    const relay = candidates[this.relayHealthProbeCursor % candidates.length]!;
    this.relayHealthProbeCursor++;
    const eventId = this.lastConfirmedEventByRelay.get(relay)!;
    this.relayHealthProbeRunning = true;
    try {
      const found = await this.readBackOne(relay, eventId);
      if (found) this.relayHealth.releaseFromProbe(relay, now);
      else {
        log.debug("phantomchat: quarantined relay probe missed", {
          relay,
          eventId,
        });
      }
      return true;
    } finally {
      this.relayHealthProbeRunning = false;
    }
  }

  /**
   * One-shot `{ids: [id]}` query against a SINGLE relay for the read-back
   * check. Resolves true the moment the relay returns the event; false on the
   * hard timeout or any error. Querying per-relay (instead of one pooled REQ)
   * is what lets the warning NAME the relay that dropped the event.
   */
  private readBackOne(
    relay: string,
    eventId: string,
    timeoutMs?: number,
  ): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let sub: { close(): void } | undefined;
      const finish = (found: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          sub?.close();
        } catch {
          // already torn down — nothing to do.
        }
        resolve(found);
      };
      const timer = setTimeout(
        () => finish(false),
        timeoutMs ?? PUBLISH_READBACK_TIMEOUT_MS,
      );
      try {
        sub = this.pool.subscribeMany([relay], { ids: [eventId] }, {
          onauth: this.authSigner,
          onevent: () => finish(true),
          oneose: () => finish(false),
        });
      } catch (e) {
        log.debug("phantomchat: read-back query failed", {
          relay,
          eventId,
          error: (e as Error).message,
        });
        finish(false);
      }
    });
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
    const { event, rumorId, rumor } = await wrapV2(
      this.ourSecretKey,
      conversationId,
      text,
    );
    // Remember rumorId → text so an inbound kind-7 reaction (whose `['e', ...]`
    // tag references this rumor id) can be correlated back to what we said.
    // Best-effort: a throwing recorder must never break the send.
    if (this.outboundRecorder) {
      try {
        this.outboundRecorder(conversationId, rumorId, text);
      } catch (e) {
        log.debug("phantomchat: outbound recorder threw", {
          error: (e as Error).message,
        });
      }
    }
    // #542: opt this send into the delivery-retry ladder. The rumor is
    // captured, not rebuilt — a second `wrapV2` would mint a NEW rumor id and
    // the recipient would render the retry as a duplicate bubble instead of
    // dropping it.
    await this.publishWrap(event as unknown as NTNostrEvent, {
      label: "dm",
      rewrap: () => rewrapV2(this.ourSecretKey, conversationId, rumor),
    });
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
    // Multi-mirror write (≥2 when possible). Primary URL + every successful
    // mirror go on the envelope so the PWA can multi-GET if a host dies.
    const uploaded = await uploadToBlossom(
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
      url: uploaded.url,
      sha256: enc.sha256Hex,
      mimeType,
      size: audio.length,
      key: enc.keyHex,
      iv: enc.ivHex,
      // Authoritative media class so the receiver never re-guesses voice vs file.
      mediaType: "voice",
      // Multi-mirror list (phantomchat #88). Primary first; receivers multi-GET.
      servers: uploaded.mirrors,
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
    const { event, rumor } = await wrapV2(
      this.ourSecretKey,
      conversationId,
      envelope,
    );
    await this.publishWrap(event as unknown as NTNostrEvent, {
      label: "voice",
      rewrap: () => rewrapV2(this.ourSecretKey, conversationId, rumor),
    });
  }

  /**
   * "Recording voice" indicator. Same ephemeral kind-20001 tick as typing, but
   * the content marker is `"recording"` so the PWA renders the native
   * "recording voice" activity instead of the generic dots. Best-effort; never
   * throws (the engine fires this every couple seconds while synthesizing).
   */
  async sendRecording(conversationId: string): Promise<void> {
    try {
      const event = finalizeEvent(
        {
          kind: NOSTR_KIND_TYPING,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["p", conversationId]],
          content: TYPING_CONTENT_RECORDING,
        },
        this.ourSecretKey,
      );
      await this.publishWrap(event as unknown as NTNostrEvent);
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

    const { wraps, rewraps } = wrapGroupMessage(
      this.ourSecretKey,
      others,
      payload,
      groupId,
    );
    // Per-member delivery retry (issue #542): each member wrap carries its own
    // rewrap thunk — a re-gift-wrap of THAT member's seal — so publishWrap's
    // 8/20/45s ladder fires only for a member whose wrap is readable from zero
    // relays and only re-sends to that member. A partial failure (A's wrap
    // stored, B's dropped) retries B alone. The self-wrap stays fire-and-warn:
    // it is multi-device recovery, not delivery, so losing it loses nothing
    // the recipient was waiting for.
    for (let i = 0; i < rewraps.length; i++) {
      await this.publishWrap(wraps[i] as unknown as NTNostrEvent, {
        rewrap: rewraps[i],
        label: "group",
      });
    }
    await this.publishWrap(wraps[rewraps.length] as unknown as NTNostrEvent);
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
    if (this.closed) return;
    this.closed = true;
    // Wake every pending retry sleep so the ladder unwinds immediately instead
    // of holding the process alive for up to 45s after teardown.
    for (const [timer, cancel] of this.retryTimers) {
      clearTimeout(timer);
      cancel();
    }
    this.retryTimers.clear();
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
