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
 *     captioned one — queued, not interrupting (see `MediaCaptionDispatchOptions`).
 *   - A caption from a DIFFERENT sender is never merged (two people in a group
 *     sending independent messages) — the held attachment is flushed alone,
 *     and the arrival keeps its own interrupt rights (see `accept`).
 *   - A message that carries an ATTACHMENT OF ITS OWN never captures a held
 *     one: an attachment always ends the hold. Otherwise `first.media` would
 *     replace `msg.media` and the second file would vanish without a trace
 *     (a photo followed by a voice note inside the window is ordinary usage).
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

/**
 * Per-dispatch instructions.
 *
 * ONE USER ACTION CAN PRODUCE SEVERAL MESSAGES. A burst of files, or a held
 * attachment plus the text that ends its hold, is a single arrival, and the
 * messages it produced are that arrival's parts. Only the FIRST of them may
 * interrupt a turn that is already running: interrupting also flushes whatever
 * is queued behind that turn (see ConversationBacklog), so a follower that
 * interrupted would discard the message the burst just delivered — which is
 * exactly how the typed question was lost when a file trail followed it.
 *
 * A follower is therefore only ever a message from the SAME arrival as its
 * head: the extra files of one multi-file send, or the tail of one held burst.
 * Two things decide "same arrival" where the messages themselves cannot: a hold
 * only ever contains ONE sender's files, so a message that ends a hold is part
 * of that arrival exactly when it comes from the same sender. A message from
 * somebody else is a separate action and keeps its normal rights — otherwise a
 * named "stop" could lose the ability to interrupt just because it met a hold.
 */
export interface MediaCaptionDispatchOptions {
  /**
   * Set `false` for every message after the first of one arrival, so it QUEUES
   * behind the turn the burst started instead of superseding it. Omitted on
   * the first, where the channel's normal interrupt rules apply.
   */
  interrupt?: boolean;
}

/** Shared instance for every message after the first of one arrival. */
const AS_FOLLOWER: MediaCaptionDispatchOptions = { interrupt: false };

export interface MediaCaptionCoalescerOptions {
  /** Override the hold window (milliseconds). Defaults to the constant above. */
  windowMs?: number;
  /**
   * Called for every message that must be dispatched now, in order.
   *
   * `alsoReceipt` lists the ORIGINATING message ids of held messages that were
   * absorbed into this one. A merge keeps only the caption's `messageId`, so
   * without this the absorbed attachment would never be acknowledged and the
   * remote's delivery tracker would resend it. The server receipts each id
   * behind the same auth gate it applies to the message itself.
   */
  dispatch: (
    msg: ChannelMessage,
    alsoReceipt?: string[],
    opts?: MediaCaptionDispatchOptions,
  ) => void;
  /**
   * Whether `msg` can carry a held attachment as its caption. Defaults to "any
   * message with text of its own and no media". The server narrows this to
   * exclude control commands, whose handler never runs a turn.
   *
   * An override can only ever NARROW: this class independently refuses to merge
   * into a message that has media of its own (see `canCaption`), so a caller
   * whose predicate forgets that clause cannot make the merge drop a file.
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
  private readonly dispatchNow: (
    msg: ChannelMessage,
    alsoReceipt?: string[],
    opts?: MediaCaptionDispatchOptions,
  ) => void;
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
    // `msg.media === undefined` is checked here, not only inside the default
    // predicate: `canCarryCaption` is a caller-supplied override, and the merge
    // below overwrites `msg.media` with the held one. A message that brought
    // its own attachment must therefore always flush the hold instead.
    const canCaption =
      first !== undefined &&
      first.media !== undefined &&
      msg.media === undefined &&
      pending.senderId === msg.senderId &&
      this.canCarryCaption(msg);

    if (!canCaption) {
      // Nothing to merge: flush the held attachments in arrival order, then the
      // message itself. The held attachments are one delayed burst, so only
      // their head interrupts.
      pending.messages.forEach((held, index) => {
        this.dispatchNow(held, undefined, index === 0 ? undefined : AS_FOLLOWER);
      });
      // The SENDER decides what `msg` is. Same sender: still one arrival, so it
      // queues behind the burst it ended — letting it interrupt here would flush
      // the attachment enqueued a moment earlier, silently losing a file, which
      // is the very defect this class exists to remove. Different sender: a
      // separate user action, so it keeps its own interrupt evaluation — a
      // "lena, stop, do Z instead" that happens to meet somebody else's hold
      // must still abort the running turn. (Its interrupt then flushes the held
      // file from the other sender; that is the channel's ordinary
      // last-message-wins, and it is visible to the sender who interrupted.)
      //
      // DECIDED (#739), same sender only: a message that cannot take a caption
      // queues behind the burst rather than interrupting it. That covers a
      // message with media of its own (a voice note naming this bot) and a
      // "/…" line. Letting it interrupt would flush the held file; dispatching
      // it AHEAD of the held file would keep both but run a "what is in this
      // photo?" voice note before the photo it is about. A delayed start is
      // the cheaper cost. A "/…" line that resolves is handled by runSlash,
      // off-chain, and never interrupts. One that does NOT resolve falls through
      // to enqueue, and the server carries this follower mark through that
      // fall-through (#742), so it cannot flush the held file either.
      const follower = pending.senderId === msg.senderId ? AS_FOLLOWER : undefined;
      this.dispatchNow(msg, undefined, follower);
      return;
    }

    // ONE turn: the attachment carries the typed text as its caption, exactly
    // as a client-side caption would have arrived. The absorbed attachment's
    // id rides along so the server can still acknowledge it.
    const alsoReceipt =
      first.messageId !== undefined && first.messageId !== msg.messageId
        ? [first.messageId]
        : undefined;
    this.dispatchNow({ ...msg, media: first.media }, alsoReceipt);
    // Extra files from the same burst keep today's behaviour — their own
    // (uncaptioned) turns, QUEUED behind the captioned one. They must not
    // interrupt: a follower's interrupt flushes the merged message enqueued a
    // moment earlier, so the file would run alone and the question just
    // delivered with it would be dropped without a trace.
    for (const extra of rest) this.dispatchNow(extra, undefined, AS_FOLLOWER);
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
    // One arrival again: the burst interrupts once, its tail queues.
    pending.messages.forEach((held, index) => {
      this.dispatchNow(held, undefined, index === 0 ? undefined : AS_FOLLOWER);
    });
  }
}
