/**
 * Matrix message parsing + normalization.
 *
 * Pure functions that turn a (already-decrypted) Matrix timeline event into
 * the channel-neutral `MatrixChannelMessage`. The Matrix analogue of
 * telegram/parse.ts — same job, far simpler input because matrix-bot-sdk has
 * already done the heavy lifting (decryption, type resolution) by the time an
 * event reaches us.
 *
 * Security note: the envelope-sanitization concern from telegram/parse.ts
 * applies identically here. Any attacker-controlled field we interpolate into
 * a bracketed `[...]` prompt marker must be neutralized so it can't forge
 * structure — so we REUSE `sanitizeEnvelopeField` from the Telegram parser
 * rather than reimplement it (single source of truth for that defense).
 */

import type { MatrixChannelMessage, MatrixTimelineEvent } from "./types.ts";

// Re-export the shared envelope sanitizer so Matrix-side callers (group/room
// context rendering, if added later) reach for the same hardened function.
export { sanitizeEnvelopeField } from "../telegram/parse.ts";

/** The Matrix event type for a normal message. */
export const MATRIX_MESSAGE_TYPE = "m.room.message";

/**
 * Decide whether a timeline event is an inbound text message we should hand to
 * the engine, and if so project it to a `MatrixChannelMessage`. Returns
 * undefined for everything we ignore: non-message events, redactions, state
 * events, messages from ourselves, empty bodies, and non-text msgtypes (we
 * only handle `m.text` / `m.notice` bodies for v1 — files/images/voice are a
 * later step, mirroring how Telegram landed text-first).
 *
 * `selfUserId` is the bot's own MXID; messages it sent are skipped so the bot
 * never answers its own echo on /sync.
 *
 * Exported for testing — this is the heart of the parse layer and gets the
 * same exhaustive shape coverage as `parseGetUpdatesResult`.
 */
export function parseTimelineEvent(
  event: MatrixTimelineEvent,
  selfUserId: string | null,
  isRoomEncrypted: boolean,
): MatrixChannelMessage | undefined {
  if (event.getType() !== MATRIX_MESSAGE_TYPE) return undefined;
  if (event.isRedacted?.()) return undefined;

  const sender = event.getSender();
  const roomId = event.getRoomId();
  const eventId = event.getId();
  if (!sender || !roomId || !eventId) return undefined;

  // Never react to our own messages (the SDK echoes them back through the
  // same timeline). Compared as exact MXIDs.
  if (selfUserId && sender === selfUserId) return undefined;

  const content = event.getContent();
  const msgtype = typeof content.msgtype === "string" ? content.msgtype : "";
  // v1: text-shaped bodies only. m.notice is the bot-to-bot convention but a
  // human-sent notice is still text we can read; accept both. Other msgtypes
  // (m.image/m.file/m.audio/m.video) are intentionally skipped for now.
  if (msgtype !== "m.text" && msgtype !== "m.notice") return undefined;

  const body = typeof content.body === "string" ? content.body : "";
  if (body.length === 0) return undefined;

  return {
    conversationId: roomId,
    senderId: sender,
    fromUsername: sender,
    text: body,
    roomId,
    eventId,
    originServerTs: event.getTs(),
    encrypted: isRoomEncrypted,
  };
}
