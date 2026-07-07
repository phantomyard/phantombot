/**
 * Telegram message parsing + normalization.
 *
 * Pure(ish) functions that turn Telegram's raw getUpdates payloads into the
 * channel-agnostic `TelegramMessage` (a `ChannelMessage` superset), plus the
 * attachment / reply-quote extraction, MIME→extension mapping, inbox path
 * helper, chat-type narrowing, and the envelope-sanitization used to keep
 * attacker-controlled fields from forging structured prompt markers.
 *
 * Moved out of the former monolithic `channels/telegram.ts` (#162). Re-exported
 * from there as a barrel so the public API is unchanged.
 */

import { join } from "node:path";

import { xdgDataHome } from "../../config.ts";
import type { ChannelMessage } from "../core/types.ts";

/**
 * Telegram bot-API hard cap on file downloads. `getFile` rejects requests
 * for larger files outright, regardless of attachment type. Documented at
 * https://core.telegram.org/bots/api#getfile. Client-side uploads can be
 * much bigger, but bots literally cannot fetch them through this API —
 * the right user-facing behavior is to surface the size and move on, not
 * to silently drop.
 */
export const TELEGRAM_BOT_DOWNLOAD_CAP_BYTES = 20 * 1024 * 1024;

/**
 * Sanitize a conversation id for use as a single on-disk path segment.
 *
 * Windows forbids `< > : " / \ | ? *` (and control chars) in file names —
 * `:` is the drive/alternate-data-stream separator, so a raw `acp:<hash>`
 * conversation key makes `mkdir` throw `ENOTDIR`. We map every reserved char
 * to `_`. This is a no-op for Telegram's numeric chat ids and phantomchat's
 * hex/npub ids (none contain reserved chars), so existing on-disk paths are
 * unchanged; only ACP's colon-bearing keys are rewritten.
 */
function sanitizePathSegment(id: string): string {
  // eslint-disable-next-line no-control-regex
  return id.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
}

/**
 * Per-chat inbox where Telegram attachments are saved. Takes the
 * channel-neutral STRING conversation id (the engine's `msg.conversationId`);
 * Telegram's numeric chat id was already stringified at ingest, so the on-disk
 * path is byte-identical to the previous `String(chatId)` form. Ids containing
 * Windows-reserved characters (e.g. ACP's `acp:<hash>`) are sanitized so the
 * path is creatable on every platform.
 */
export function inboxDir(conversationId: string): string {
  return join(xdgDataHome(), "phantombot", "inbox", sanitizePathSegment(conversationId));
}

/**
 * Build the user message handed to the harness for an attachment-bearing
 * Telegram message. Caption + a single bracketed line that names the
 * absolute file path (or explains why we couldn't fetch it). The agent
 * decides what to do — read it, ignore it, ask for clarification.
 *
 * Exported for testing.
 */
export function formatAttachmentUserText(args: {
  caption: string | undefined;
  attachment: TelegramAttachment;
  /** Absolute path on disk if the download succeeded. */
  savedPath?: string;
  /** Set when the file was over Telegram's bot-API download cap. */
  oversizeBytes?: number;
  /** Set when getFile or the actual download threw. */
  downloadError?: string;
}): string {
  const captionPart = (args.caption ?? "").trim();
  let line: string;
  if (args.savedPath) {
    line = `[attached: ${args.savedPath}]`;
  } else if (args.oversizeBytes !== undefined) {
    const mb = (args.oversizeBytes / 1024 / 1024).toFixed(1);
    line = `[attached but too large to fetch: ${args.attachment.fileName} (${mb} MB > 20 MB Telegram bot-API cap)]`;
  } else {
    line = `[attached but couldn't download: ${args.attachment.fileName}${args.downloadError ? ` (${args.downloadError})` : ""}]`;
  }
  return captionPart ? `${captionPart}\n\n${line}` : line;
}

export interface TelegramAttachment {
  /** Telegram file_id; pass to getFile + the resulting file_path URL. */
  fileId: string;
  /** Filename to use on disk. Either Telegram's `file_name` (documents,
   *  audio, video) or synthesized from the message id + kind + mime. */
  fileName: string;
  /** Bytes if Telegram included it. Used to skip the download when the
   *  file is over Telegram's bot-API cap (getFile rejects > 20 MB). */
  fileSize?: number;
  /** MIME type if Telegram included one. */
  mimeType?: string;
  /** The Telegram message field this came from — useful for log clarity. */
  kind:
    | "document"
    | "photo"
    | "audio"
    | "video"
    | "video_note"
    | "animation"
    | "sticker";
}

/**
 * Quoted-message metadata when the user taps "Reply" on a previous
 * Telegram message and sends a new one. Carried alongside the new
 * message so the agent can disambiguate which earlier message the
 * user is actually replying to — without this, a "merge" / "yes"
 * lands with no referent and the agent assumes it's a response to
 * the most recent assistant turn (which is wrong if the user
 * deliberately scrolled up to reply to something older).
 */
export interface TelegramReplyTo {
  /** Telegram's `message_id` of the quoted message. */
  messageId: number;
  /** Text snippet of the quoted message, truncated for prompt sanity.
   *  Empty when the quoted message had no text (e.g. media without
   *  caption). */
  text: string;
  /** True when the quoted message was sent by the bot (i.e. the
   *  assistant itself). Lets the agent distinguish "user replied to
   *  my earlier turn" vs "user quoted their own earlier message". */
  fromBot: boolean;
}

export interface TelegramMessage extends ChannelMessage {
  updateId: number;
  /** Telegram chat type: "private" for DMs, "group"/"supergroup" for
   *  group chats, "channel" for channels. Drives group-only behaviour
   *  like stripping the bot's @username mention from the text. Absent
   *  when Telegram didn't include it (older/odd payloads) — callers treat
   *  the absence as "not a group" (i.e. no mention stripping). */
  chatType?: "private" | "group" | "supergroup" | "channel";
  /** For text messages — the text. For voice messages — empty string until
   *  STT runs. For attachment-only messages — empty until processChatMessage
   *  rewrites it to "<caption>\n\n[attached: <path>]". */
  text: string;
  /** Caption accompanying media (Telegram delivers `caption` not `text`
   *  for media messages). Empty when absent. */
  caption?: string;
  /** Set when the incoming message was a voice note. Voice keeps its
   *  dedicated STT path; it is NOT carried via `attachment`. */
  voice?: {
    fileId: string;
    mimeType: string;
    durationS: number;
  };
  /** Any non-voice attachment (photo, document, audio, video, etc.).
   *  Downloaded to the per-chat inbox and surfaced to the harness as
   *  an absolute path the agent can `read`. */
  attachment?: TelegramAttachment;
  /** Populated when this message was sent as a Telegram reply (the
   *  user tapped "Reply" on an earlier message). Forwarded into the
   *  agent's user-message envelope so it can disambiguate which past
   *  turn the new text is actually about. */
  replyTo?: TelegramReplyTo;
}

export interface TelegramRawFile {
  file_id?: string;
  file_size?: number;
  mime_type?: string;
  file_name?: string;
}

export interface TelegramRawPhotoSize {
  file_id?: string;
  file_size?: number;
  width?: number;
  height?: number;
}

export interface TelegramRawReplyToMessage {
  message_id?: number;
  text?: string;
  caption?: string;
  from?: { id?: number; is_bot?: boolean; username?: string };
}

export interface TelegramRawUpdate {
  update_id?: number;
  message?: {
    message_id?: number;
    chat?: { id?: number; type?: string };
    from?: { id?: number; username?: string };
    text?: string;
    caption?: string;
    voice?: {
      duration?: number;
      mime_type?: string;
      file_id?: string;
    };
    document?: TelegramRawFile;
    audio?: TelegramRawFile;
    video?: TelegramRawFile;
    video_note?: TelegramRawFile;
    animation?: TelegramRawFile;
    sticker?: TelegramRawFile;
    photo?: TelegramRawPhotoSize[];
    /** Populated by Telegram when the sender used the "Reply" UI on a
     *  prior message. Only a small subset of fields is actually relayed
     *  through to the agent — see {@link extractReplyTo}. */
    reply_to_message?: TelegramRawReplyToMessage;
  };
}

/**
 * Walk a raw message looking for an attachment. Photos are an array of
 * sizes; we pick the largest. Voice is intentionally skipped — it has its
 * own STT path. Returns undefined when the message has nothing
 * attachment-shaped.
 *
 * Exported for testing.
 */
export function extractAttachment(
  msg: NonNullable<TelegramRawUpdate["message"]>,
): TelegramAttachment | undefined {
  const msgId = typeof msg.message_id === "number" ? msg.message_id : 0;

  // Documents/audio/video/etc. all have the same shape: file_id + optional
  // file_name, mime_type, file_size. Walked in priority order.
  const simpleKinds: Array<{
    field: TelegramAttachment["kind"];
    raw: TelegramRawFile | undefined;
  }> = [
    { field: "document", raw: msg.document },
    { field: "audio", raw: msg.audio },
    { field: "video", raw: msg.video },
    { field: "video_note", raw: msg.video_note },
    { field: "animation", raw: msg.animation },
    { field: "sticker", raw: msg.sticker },
  ];
  for (const { field, raw } of simpleKinds) {
    if (raw && typeof raw.file_id === "string") {
      return {
        fileId: raw.file_id,
        fileName: raw.file_name ?? synthesizeFileName(msgId, field, raw.mime_type),
        fileSize: typeof raw.file_size === "number" ? raw.file_size : undefined,
        mimeType: raw.mime_type,
        kind: field,
      };
    }
  }

  // Photos: pick the largest size. file_size may be missing on some
  // sizes; rank by (file_size ?? width*height ?? 0) descending.
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const sized = msg.photo
      .filter((p): p is TelegramRawPhotoSize & { file_id: string } =>
        typeof p?.file_id === "string",
      )
      .map((p) => ({
        p,
        rank:
          p.file_size ??
          (typeof p.width === "number" && typeof p.height === "number"
            ? p.width * p.height
            : 0),
      }))
      .sort((a, b) => b.rank - a.rank);
    const best = sized[0]?.p;
    if (best) {
      return {
        fileId: best.file_id,
        fileName: synthesizeFileName(msgId, "photo", "image/jpeg"),
        fileSize: typeof best.file_size === "number" ? best.file_size : undefined,
        mimeType: "image/jpeg",
        kind: "photo",
      };
    }
  }

  return undefined;
}

function synthesizeFileName(
  msgId: number,
  kind: TelegramAttachment["kind"],
  mimeType: string | undefined,
): string {
  return `${msgId}-${kind}${extensionFromMime(mimeType)}`;
}

/** Max chars of quoted text we forward into the agent prompt. Long
 *  enough to disambiguate, short enough not to bloat the context when a
 *  user replies to a wall of earlier text. */
export const REPLY_TO_SNIPPET_MAX = 280;

/**
 * Pull the subset of `reply_to_message` we want to forward into the
 * agent's user-message envelope. Returns `undefined` when the raw field
 * is missing or the quoted message has no `message_id` we can latch
 * onto. We prefer `text`; if absent (media reply), fall back to
 * `caption`; if still absent, the snippet is the empty string and only
 * the message id + bot flag are forwarded — still enough for the agent
 * to tell "user replied to message N from me" from "user replied to a
 * media message they sent earlier".
 *
 * Exported for testing.
 */
export function extractReplyTo(
  raw: TelegramRawReplyToMessage | undefined,
): TelegramReplyTo | undefined {
  if (!raw || typeof raw.message_id !== "number") return undefined;
  const source =
    typeof raw.text === "string" && raw.text.length > 0
      ? raw.text
      : typeof raw.caption === "string"
        ? raw.caption
        : "";
  const truncated =
    source.length > REPLY_TO_SNIPPET_MAX
      ? `${source.slice(0, REPLY_TO_SNIPPET_MAX)}…`
      : source;
  return {
    messageId: raw.message_id,
    text: truncated,
    fromBot: Boolean(raw.from?.is_bot),
  };
}

/**
 * Neutralize untrusted text before it goes INSIDE one of our bracketed
 * `[...]` envelope markers (#161, item f).
 *
 * We frame attachments, reply-quotes and group catch-up as `[in reply to …]`
 * / `[Recent group messages … ]` so the agent reads them as TRUSTED STRUCTURE,
 * not free-form user prose. But the fields we interpolate — a quoted message
 * body, a Telegram display name / @username — are ATTACKER-CONTROLLED. A name
 * or quote containing a literal `]` (or a newline, in the multi-line group
 * envelope) could close our marker early and forge a fake one after it,
 * smuggling spoofed "system" structure into the agent's context.
 *
 * So in untrusted fields we (a) collapse all whitespace incl. newlines to a
 * single space, and (b) swap ASCII square brackets for their fullwidth
 * look-alikes ［］ — visually identical to a human, but they can NOT be parsed
 * as our ASCII envelope delimiters. Content meaning is preserved; the ability
 * to forge structure is removed.
 */
export function sanitizeEnvelopeField(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\[/g, "［")
    .replace(/\]/g, "］")
    .trim();
}

/**
 * Render a single bracketed line describing the message the user
 * tapped "Reply" on. Mirrors the `[attached: <path>]` convention so the
 * agent reads it as a structured envelope marker, not as free-form
 * prose from the user. Exported for testing.
 */
export function formatReplyToContext(replyTo: TelegramReplyTo): string {
  const who = replyTo.fromBot
    ? `your earlier message #${replyTo.messageId}`
    : `user's earlier message #${replyTo.messageId}`;
  if (replyTo.text.length === 0) {
    return `[in reply to ${who} (no text content)]`;
  }
  // Sanitize: collapse whitespace AND neutralize brackets so a crafted quote
  // can't forge envelope structure. (#161, item f)
  const snippet = sanitizeEnvelopeField(replyTo.text);
  return `[in reply to ${who}: "${snippet}"]`;
}

/**
 * Map a MIME to a file extension. Conservative: handles the common ones
 * we'll actually see from Telegram (photo, voice, audio, video, common
 * documents); unknown → ".bin" so we still write *something* the agent
 * can `read`. Exported for testing.
 */
export function extensionFromMime(mime: string | undefined): string {
  if (!mime) return ".bin";
  const m = mime.toLowerCase().split(";")[0]!.trim();
  switch (m) {
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/heic":
      return ".heic";
    case "application/pdf":
      return ".pdf";
    case "text/plain":
      return ".txt";
    case "text/markdown":
      return ".md";
    case "text/csv":
      return ".csv";
    case "application/json":
      return ".json";
    case "application/zip":
      return ".zip";
    case "audio/ogg":
      return ".ogg";
    case "audio/mpeg":
      return ".mp3";
    case "audio/mp4":
      return ".m4a";
    case "video/mp4":
      return ".mp4";
    case "video/quicktime":
      return ".mov";
    case "video/webm":
      return ".webm";
    default:
      // Generic fallback: take everything after the slash, strip
      // anything non-alphanumeric, cap at 8 chars. So "application/
      // vnd.openxmlformats-officedocument.wordprocessingml.document"
      // becomes ".vndopenx" — ugly but unique-ish, and the absolute
      // path the agent gets includes the kind, so it's fine.
      const sub = m.split("/")[1] ?? "";
      const cleaned = sub.replace(/[^a-z0-9]/g, "").slice(0, 8);
      return cleaned ? `.${cleaned}` : ".bin";
  }
}

/**
 * Narrow Telegram's free-string `chat.type` to the set we model. Unknown
 * / missing values return undefined, which downstream code treats as
 * "not a group" — the safe default (no mention stripping). Exported for
 * testing.
 */
export function normalizeChatType(
  raw: string | undefined,
): TelegramMessage["chatType"] | undefined {
  switch (raw) {
    case "private":
    case "group":
    case "supergroup":
    case "channel":
      return raw;
    default:
      return undefined;
  }
}

/**
 * Strip the bot's own `@username` mention from a group message so the
 * harness sees the user's actual words, not the addressing noise. With
 * Telegram privacy mode ON, the ONLY way a group message reaches the bot
 * (short of a slash command or a reply) is by mentioning its @username —
 * so the literal "@robbie_agh_bot " is present in essentially every group
 * turn and would otherwise pollute the prompt.
 *
 * Removes every standalone, case-insensitive occurrence of `@username`
 * (Telegram usernames are case-insensitive), then collapses the
 * whitespace the removal leaves behind. A mention glued to other word
 * characters (e.g. an email-like "x@usernamey") is NOT a Telegram mention
 * and is left untouched via the word-boundary guards.
 *
 * No-ops when `username` is unknown (getMe failed at startup) or the text
 * doesn't contain the mention. Exported for testing.
 */
export function stripBotMention(
  text: string,
  username: string | undefined,
): string {
  if (!username || text.length === 0) return text;
  // Escape any regex-special chars in the username (usernames are
  // [A-Za-z0-9_] so this is belt-and-braces) and match it only when
  // preceded by start/whitespace and followed by end/whitespace/punct —
  // i.e. a real standalone mention, not a substring of a larger token.
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|\\s)@${escaped}\\b`, "gi");
  const stripped = text.replace(re, "$1");
  // Collapse the doubled whitespace a mid-string removal can leave, and
  // trim the edges. Keep internal single spaces/newlines otherwise intact.
  return stripped.replace(/[ \t]{2,}/g, " ").trim();
}

/**
 * Pure parser exposed for testing. Consumes Telegram getUpdates result
 * objects and returns the messages we care about — text or voice.
 */
export function parseGetUpdatesResult(
  raw: TelegramRawUpdate[],
  fallbackOffset: number,
): { updates: TelegramMessage[]; nextOffset: number } {
  const updates: TelegramMessage[] = [];
  let nextOffset = fallbackOffset;
  for (const u of raw) {
    if (typeof u.update_id === "number") {
      nextOffset = Math.max(nextOffset, u.update_id + 1);
    }
    const msg = u.message;
    if (
      typeof u.update_id !== "number" ||
      !msg ||
      typeof msg.chat?.id !== "number" ||
      typeof msg.from?.id !== "number"
    ) {
      continue;
    }

    // `reply_to_message` is parsed once and attached to whichever
    // envelope we end up pushing — it's orthogonal to text vs voice vs
    // attachment, but all three paths benefit from carrying it through.
    const replyTo = extractReplyTo(msg.reply_to_message);

    // Chat type drives group-only behaviour (mention stripping). Parsed
    // once and spread into whichever envelope we push, like replyTo.
    const chatType = normalizeChatType(msg.chat?.type);

    // Attachments take priority over plain text, but if BOTH text and an
    // attachment are present (rare; Telegram normally uses `caption` not
    // `text` for media), use text as the caption.
    const attachment = extractAttachment(msg);
    if (attachment) {
      const captionFromMedia =
        typeof msg.caption === "string" ? msg.caption : undefined;
      const captionFromText =
        typeof msg.text === "string" && msg.text.length > 0
          ? msg.text
          : undefined;
      updates.push({
        updateId: u.update_id,
        // Stringify Telegram's numeric ids at the adapter boundary so the
        // core only ever sees channel-neutral string ids. `String()` (not
        // parseInt) round-trips negative group ids and large ids exactly.
        conversationId: String(msg.chat.id),
        senderId: String(msg.from.id),
        fromUsername: msg.from.username,
        text: "", // filled by processChatMessage after download
        caption: captionFromMedia ?? captionFromText,
        attachment,
        ...(replyTo ? { replyTo } : {}),
        ...(chatType ? { chatType } : {}),
      });
      continue;
    }
    if (typeof msg.text === "string" && msg.text.length > 0) {
      updates.push({
        updateId: u.update_id,
        conversationId: String(msg.chat.id),
        senderId: String(msg.from.id),
        fromUsername: msg.from.username,
        text: msg.text,
        ...(replyTo ? { replyTo } : {}),
        ...(chatType ? { chatType } : {}),
      });
      continue;
    }
    if (msg.voice && typeof msg.voice.file_id === "string") {
      updates.push({
        updateId: u.update_id,
        conversationId: String(msg.chat.id),
        senderId: String(msg.from.id),
        fromUsername: msg.from.username,
        text: "", // filled by STT before harness dispatch
        voice: {
          fileId: msg.voice.file_id,
          mimeType: msg.voice.mime_type ?? "audio/ogg",
          durationS: msg.voice.duration ?? 0,
        },
        ...(replyTo ? { replyTo } : {}),
        ...(chatType ? { chatType } : {}),
      });
    }
  }
  return { updates, nextOffset };
}
