/**
 * MEDIA → CAPTION COALESCER (receive side).
 *
 * THE DEFECT THIS FIXES. A phantomchat client that stages an attachment and
 * then publishes the typed text as a second event delivers TWO inbound
 * messages: a media-only message (no text) and the sentence that explains it.
 * The server runs a turn per inbound message, so the phantom answers the
 * attachment FIRST — with no idea what was asked — and only then reads the
 * question. The wire already carries the answer to this: a media envelope has a
 * caption field (DM: `content.caption`, group: `envelope.content`), surfaced by
 * channel.ts as `text` on a media message and rendered by the server as
 * `"<caption>\n\n[attached: <path>]"`. Clients that stage the text on the
 * attachment (the composer fix in phantomchat) never hit this at all; this is
 * the receive-side safety net for every client that sends the two events
 * separately.
 *
 * WHAT IT DOES. Hold a BARE attachment (media, no caption, not a voice note)
 * for a short window. If an ordinary message from the same sender in the same
 * conversation lands inside that window, dispatch ONE message carrying both:
 * the attachment's media plus the new text, which the server already renders as
 * a caption. On expiry the attachment is dispatched alone — exactly today's
 * behaviour, just up to `windowMs` later.
 *
 * WHAT IT DELIBERATELY DOES NOT DO.
 *   - Voice notes are never held: their transcript is the message, and delaying
 *     STT buys nothing.
 *   - A caption that never arrives is not invented. Nothing here guesses at
 *     context; it only stops a question and its attachment from being split
 *     into two turns.
 *   - Only the FIRST attachment of a burst is captioned. `ChannelMessage`
 *     carries a single `media`, so a multi-file send still runs its extra files
 *     as their own (uncaptioned) turns, dispatched immediately behind the
 *     captioned one.
 *   - A caption from a DIFFERENT sender is never merged (two people in a group
 *     sending independent messages) — the held attachment is flushed alone.
 *
 * The window is measured from the FIRST held attachment, so a burst of files
 * cannot extend the hold indefinitely.
 */

import type { ChannelMessage } from "../core/types.ts";

/**
 * How long a bare attachment waits for its caption. Well under a typing pause,
 * well over the gap between two publish round-trips of the same send.
 */
export const DEFAULT_MEDIA_CAPTION_WINDOW_MS = 2_000;

export interface MediaCaptionCoalescerOptions {
  /** Override the hold window (milliseconds). Defaults to the constant above. */
  windowMs?: number;
  /** Called for every message that must be dispatched now, in order. */
  dispatch: (msg: ChannelMessage) => void;
  /**
   * Whether `msg` can carry a held attachment as its caption. Defaults to "any
   * message with text of its own and no media". The server narrows this to
   * exclude control commands, whose handler never runs a turn.
   */
  canCarryCaption?: (msg: ChannelMessage) => boolean;
}

interface Held {
  /** Sender of the first held attachment; captions only merge within it. */
  senderId: string;
  messages: ChannelMessage[];
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * A bare attachment: media with no caption of its own. Voice notes are excluded
 * (see the header) — their transcript is the message.
 */
export function isBareAttachment(msg: ChannelMessage): boolean {
  return (
    !msg.reaction &&
    msg.media !== undefined &&
    msg.media.kind !== "voice" &&
    msg.text.trim().length === 0
  );
}

export class MediaCaptionCoalescer {
  private readonly windowMs: number;
  private readonly dispatchNow: (msg: ChannelMessage) => void;
  private readonly canCarryCaption: (msg: ChannelMessage) => boolean;
  private readonly held = new Map<string, Held>();

  constructor(opts: MediaCaptionCoalescerOptions) {
    this.windowMs = opts.windowMs ?? DEFAULT_MEDIA_CAPTION_WINDOW_MS;
    this.dispatchNow = opts.dispatch;
    this.canCarryCaption =
      opts.canCarryCaption ??
      ((msg) => msg.media === undefined && msg.text.trim().length > 0);
  }

  /** Number of conversations currently holding a bare attachment (tests). */
  get heldConversations(): number {
    return this.held.size;
  }

  /** Route one inbound message. May dispatch zero, one or several messages. */
  accept(msg: ChannelMessage): void {
    // A reaction is a wake-but-silent side channel, not a message in the
    // conversation's turn sequence: it neither carries a caption nor ends
    // an attachment's hold.
    if (msg.reaction) {
      this.dispatchNow(msg);
      return;
    }

    const key = msg.conversationId;

    if (isBareAttachment(msg)) {
      const pending = this.held.get(key);
      if (pending) {
        // Same sender: extend the burst — the timer keeps running from the
        // first arrival. Different sender: two people sending independently,
        // so flush what we hold and start a fresh hold for this one.
        if (pending.senderId === msg.senderId) {
          pending.messages.push(msg);
          return;
        }
        this.release(key);
      }
      const entry: Held = { senderId: msg.senderId, messages: [msg] };
      const timer = setTimeout(() => this.release(key), this.windowMs);
      // A pending caption must never keep the process alive on shutdown;
      // flushAll() dispatches whatever is still held.
      timer.unref?.();
      entry.timer = timer;
      this.held.set(key, entry);
      return;
    }

    const pending = this.take(key);
    if (!pending) {
      this.dispatchNow(msg);
      return;
    }

    const [first, ...rest] = pending.messages;
    const canCaption =
      first !== undefined &&
      first.media !== undefined &&
      pending.senderId === msg.senderId &&
      this.canCarryCaption(msg);

    if (!canCaption) {
      // Nothing to merge: flush the held attachments in arrival order, then
      // the message itself.
      for (const held of pending.messages) this.dispatchNow(held);
      this.dispatchNow(msg);
      return;
    }

    // ONE turn: the attachment carries the typed text as its caption, exactly
    // as a client-side caption would have arrived.
    this.dispatchNow({ ...msg, media: first.media });
    // Extra files from the same burst keep today's behaviour — their own
    // (uncaptioned) turns, queued behind the captioned one.
    for (const extra of rest) this.dispatchNow(extra);
  }

  /** Dispatch everything still held, oldest first. Call on shutdown. */
  flushAll(): void {
    for (const key of [...this.held.keys()]) this.release(key);
  }

  /** Drop everything still held, oldest first, without dispatching. */
  discardAll(): void {
    for (const key of [...this.held.keys()]) {
      const pending = this.take(key);
      if (pending === undefined) continue;
      pending.messages.length = 0;
    }
  }

  /** Remove a held entry (clearing its timer) without dispatching it. */
  private take(key: string): Held | undefined {
    const pending = this.held.get(key);
    if (!pending) return undefined;
    this.held.delete(key);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    return pending;
  }

  /** Dispatch every message held for `key`, in arrival order, then forget it. */
  private release(key: string): void {
    const pending = this.take(key);
    if (!pending) return;
    for (const held of pending.messages) this.dispatchNow(held);
  }
}
