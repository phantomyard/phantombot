/**
 * Matrix channel — shared types + the minimal Matrix-client surface the
 * adapter programs against.
 *
 * Two reasons this file exists separately from `transport.ts`:
 *
 *   1. The real `matrix-js-sdk` `MatrixClient` is enormous and pulls in the
 *      WASM crypto on import. The transport + server should depend on a SMALL,
 *      explicit interface (`MatrixClientLike`) so unit tests can drive the
 *      whole channel with a hand-written fake — no network, no crypto, no
 *      subprocess (mirrors how the Telegram tests use a `FakeTransport`).
 *   2. `MatrixChannelMessage` is the channel-neutral `ChannelMessage`
 *      specialized for Matrix, the analogue of `TelegramMessage`.
 *
 * Matrix ids are ALREADY strings (`@user:hs`, `!room:hs`), so they slot into
 * the channel-neutral `conversationId` / `senderId` contract with no
 * stringify/parse dance — the whole reason the seam in core/types.ts used
 * strings.
 */

import type { ChannelMessage } from "../core/types.ts";

/**
 * A decrypted inbound Matrix message handed to the engine. `conversationId`
 * is the Matrix room id (`!room:hs`); `senderId` is the sender MXID
 * (`@user:hs`). `text` is the PLAINTEXT body — for an encrypted room the
 * Megolm decryption already happened inside the SDK before the event reached
 * us, so the engine (and this type) only ever see plaintext, satisfying the
 * encryption-seam contract.
 */
export interface MatrixChannelMessage extends ChannelMessage {
  /** Matrix room id, e.g. "!abc:matrix.org". Also the `conversationId`. */
  roomId: string;
  /** The event id of this message, for dedup + logging. */
  eventId: string;
  /** Server timestamp (ms) of the event; used to drop pre-startup backlog. */
  originServerTs: number;
  /** True when the room this arrived in is end-to-end encrypted. Informational
   *  for logging — the SDK transparently decrypted it already. */
  encrypted: boolean;
}

/**
 * A single raw timeline event as the adapter consumes it. A thin projection
 * of matrix-js-sdk's `MatrixEvent` exposing only what the parser needs, so the
 * parser stays pure + testable without constructing real SDK events.
 */
export interface MatrixTimelineEvent {
  getId(): string | undefined;
  getType(): string;
  getSender(): string | undefined;
  getRoomId(): string | undefined;
  getTs(): number;
  /** Decrypted (or plaintext) content. `{ body, msgtype }` for m.room.message. */
  getContent(): { body?: string; msgtype?: string } & Record<string, unknown>;
  /** True when this event is a redaction / was redacted — skip those. */
  isRedacted?(): boolean;
}

/**
 * The minimal Matrix client surface the transport + server need. The real
 * `matrix-js-sdk` `MatrixClient` is a structural superset of this, so the
 * production wrapper is a near pass-through; the test fake implements exactly
 * these members.
 */
export interface MatrixClientLike {
  /** The bot's own MXID — used to skip our own echoed messages on /sync. */
  getUserId(): string | null;
  /** Begin syncing. Resolves once the initial sync completes (or rejects). */
  startClient(opts?: { initialSyncLimit?: number }): Promise<void>;
  /** Stop syncing + tear down. */
  stopClient(): void;
  /**
   * Send a plaintext `m.text` message to a room. For an ENCRYPTED room the SDK
   * transparently Megolm-encrypts before it hits the wire — that is the whole
   * "encrypt-on-egress" seam for Matrix; we never hand-roll ciphertext.
   */
  sendTextMessage(roomId: string, body: string): Promise<{ event_id: string }>;
  /** Best-effort typing indicator. */
  sendTyping(roomId: string, isTyping: boolean, timeoutMs: number): Promise<void>;
  /** Whether a room is E2E-encrypted (drives the `encrypted` flag + logging). */
  isRoomEncrypted(roomId: string): boolean;
  /**
   * Register a timeline-event listener. The callback fires for each live
   * event; the server filters to decrypted `m.room.message`s from others.
   * Returns an unsubscribe function.
   */
  onTimelineEvent(cb: (event: MatrixTimelineEvent) => void): () => void;
}
