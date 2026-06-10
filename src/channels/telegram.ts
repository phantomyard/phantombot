/**
 * Telegram channel adapter.
 *
 * Long-polls Telegram's getUpdates, dispatches each text message through
 * runTurn, and sends the assistant reply back via sendMessage. Per-chat
 * memory uses conversation key `telegram:<chatId>` so DMs and groups are
 * isolated from the CLI's `cli:default` history.
 *
 * Streaming: we send `sendChatAction(typing)` at the start of each turn
 * and refresh it on every harness chunk. Text before a tool call is
 * classified as progress narration, but it is posted only on a timer so
 * many tool calls coalesce into one bubble. Final answers stream through
 * a markdown-aware segmenter that cuts into smaller Telegram bubbles at
 * sentence/char boundaries without splitting code fences or tables.
 *
 * Voice-out skips text streaming; after the full reply is known, it is
 * split into short voice clips.
 *
 * Token-by-token live edits would be nicer still but Telegram
 * rate-limits edits at ~1/sec — not worth the complexity.
 *
 * Auth gating: if `allowedUserIds` is empty, anyone who DMs the bot is
 * answered. We log a warning at startup so this isn't accidental.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  DEFAULT_TELEGRAM_STREAMING,
  type Config,
  xdgDataHome,
} from "../config.ts";
import type { Harness } from "../harnesses/types.ts";
import {
  type AudioSupport,
  replyModalityOverride,
  sttSupport,
  synthesize,
  transcribe,
  ttsSupported,
} from "../lib/audio.ts";
import { DEFAULT_STT_TIMEOUT_MS } from "../lib/voice.ts";
import type { WriteSink } from "../lib/io.ts";
import { log } from "../lib/logger.ts";
import { timeoutSignal } from "../lib/fetchTimeout.ts";
import type { ServiceControl } from "../lib/systemd.ts";
import type { MemoryStore } from "../memory/store.ts";
import { runTurn } from "../orchestrator/turn.ts";
import { generateRecoveryReply } from "../orchestrator/recovery.ts";
import { makeRetriever } from "../orchestrator/retrieval.ts";
import { makeTurnIndexer } from "../orchestrator/turnIndexer.ts";
import { makeScreener } from "../orchestrator/screen.ts";
import {
  type ActiveTurnHandle,
  handleSlashCommand,
  slashCommandTarget,
  TELEGRAM_BOT_COMMANDS,
} from "./commands.ts";
import { telegramGetMe } from "../lib/telegramApi.ts";
import { markdownToTelegramHtml } from "./telegramFormat.ts";
import {
  splitIntoSegments,
  StreamSegmenter,
} from "./streamSegmenter.ts";
import type {
  ChannelMessage,
  ChannelTransport,
} from "./core/types.ts";

/**
 * Telegram bot-API hard cap on file downloads. `getFile` rejects requests
 * for larger files outright, regardless of attachment type. Documented at
 * https://core.telegram.org/bots/api#getfile. Client-side uploads can be
 * much bigger, but bots literally cannot fetch them through this API —
 * the right user-facing behavior is to surface the size and move on, not
 * to silently drop.
 */
const TELEGRAM_BOT_DOWNLOAD_CAP_BYTES = 20 * 1024 * 1024;

/** Per-chat inbox where Telegram attachments are saved. */
export function inboxDir(chatId: number): string {
  return join(xdgDataHome(), "phantombot", "inbox", String(chatId));
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

export interface TelegramTransport extends ChannelTransport {
  /**
   * Long-poll Telegram for updates from `offset`. Returns parsed updates
   * and the new offset. The optional `signal` cancels the in-flight HTTP
   * call so SIGINT during a 30-second long-poll exits in milliseconds
   * instead of waiting out the full timeout.
   */
  getUpdates(
    offset: number,
    timeoutS: number,
    signal?: AbortSignal,
  ): Promise<{ updates: TelegramMessage[]; nextOffset: number }>;
  /**
   * Confirm to Telegram that all updates with `update_id < offset` have
   * been processed, so the next long-poll won't re-deliver them. Per the
   * Bot API: "An update is considered confirmed as soon as getUpdates is
   * called with an offset higher than its update_id." This is a fire-
   * and-forget short-timeout getUpdates whose only purpose is to commit
   * the offset before we do something that would kill the process (e.g.
   * /restart). Without it, SIGTERM during the long-poll window means
   * Telegram never sees the offset advance, and the freshly-started
   * process gets the same /restart again — restart loop.
   */
  ackUpdates(offset: number): Promise<void>;
  sendMessage(chatId: number, text: string): Promise<void>;
  sendTyping(chatId: number): Promise<void>;
  /** Send an OGG-Opus voice note. */
  sendVoice(chatId: number, audio: Buffer, mime: string): Promise<void>;
  /** Send the "recording voice" status indicator. */
  sendRecording(chatId: number): Promise<void>;
  /** Download a file by Telegram file_id; returns audio bytes + content-type. */
  downloadFile(fileId: string): Promise<{ data: Buffer; mime: string }>;
  /**
   * Fetch the bot's own identity. Used once at startup to learn the
   * bot's @username so group messages that mention it can have the
   * mention stripped before dispatch. Optional so lightweight test
   * transports don't have to implement it — callers guard with `?.`.
   */
  getMe?(): Promise<{ ok: true; username: string } | { ok: false }>;
  /**
   * Register the bot's slash-command menu with Telegram (the `/`
   * typeahead). Called once at startup to OVERWRITE any commands a human
   * set in BotFather — including ghost commands phantombot has no handler
   * for. Optional for the same reason as getMe.
   */
  setMyCommands?(
    commands: Array<{ command: string; description: string }>,
  ): Promise<void>;
}

/**
 * Hard timeouts for Telegram Bot API requests. Without these, a wedged
 * upstream (a stalled file download, a control-plane call that never
 * returns) hangs the per-chat serial chain indefinitely — the #135-class
 * wedge. AbortSignal-backed (see lib/fetchTimeout.ts) so the socket is
 * actually cancelled, not just a promise abandoned.
 *
 *   - CONTROL: sendMessage / sendVoice / sendChatAction / getFile /
 *     getMe / setMyCommands / ackUpdates. These are small JSON or short
 *     uploads; 30s is already pathological for them.
 *   - DOWNLOAD: the file-body GET in downloadFile. Files can be up to the
 *     ~20MB bot-API cap over a slow link, so it gets a longer ceiling —
 *     but still bounded, so a non-voice attachment can't stall the chat
 *     forever (it degrades to a graceful "download failed" instead).
 *   - getUpdates is NOT covered here: it is a long-poll whose own
 *     timeoutS bounds it, composed with the caller's /stop signal below.
 */
const TELEGRAM_CONTROL_TIMEOUT_MS = 30_000;
const TELEGRAM_DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * Real HTTP transport against api.telegram.org.
 */
export class HttpTelegramTransport implements TelegramTransport {
  constructor(private readonly token: string) {}

  async getUpdates(
    offset: number,
    timeoutS: number,
    signal?: AbortSignal,
  ): Promise<{ updates: TelegramMessage[]; nextOffset: number }> {
    const url = `https://api.telegram.org/bot${this.token}/getUpdates?offset=${offset}&timeout=${timeoutS}&allowed_updates=%5B%22message%22%5D`;
    let res: Response;
    try {
      // Long-poll: bound by Telegram's own `timeout=` plus a margin for
      // the round-trip, composed with the caller's /stop signal. If the
      // poll overstays its own deadline (proxy/socket wedge), the timeout
      // fires and we return empty so the loop re-polls cleanly.
      res = await fetch(url, {
        signal: timeoutSignal(timeoutS * 1000 + 10_000, signal),
      });
    } catch (e) {
      // AbortError (Ctrl-C / external signal) and TimeoutError (poll
      // overstayed) are both expected; return empty so the caller's next
      // signal check exits the loop or it simply re-polls.
      if (
        (e as Error).name === "AbortError" ||
        (e as Error).name === "TimeoutError"
      ) {
        return { updates: [], nextOffset: offset };
      }
      log.warn("telegram: getUpdates fetch failed", {
        error: (e as Error).message,
      });
      return { updates: [], nextOffset: offset };
    }
    if (!res.ok) {
      log.warn("telegram: getUpdates non-OK", { status: res.status });
      return { updates: [], nextOffset: offset };
    }
    const body = (await res.json()) as {
      ok?: boolean;
      result?: TelegramRawUpdate[];
      description?: string;
    };
    if (!body.ok) {
      log.warn("telegram: getUpdates not ok", { description: body.description });
      return { updates: [], nextOffset: offset };
    }
    return parseGetUpdatesResult(body.result ?? [], offset);
  }

  /**
   * Commit `offset` to Telegram by making a zero-timeout getUpdates call.
   * Best-effort: failures are logged and swallowed because the caller is
   * about to do something destructive (e.g. systemctl restart) and the
   * worst case of a missed ack is a single duplicate delivery — not
   * something to crash the channel for. Uses timeout=0 so this returns
   * in tens of milliseconds; no long-poll involved.
   */
  async ackUpdates(offset: number): Promise<void> {
    const url = `https://api.telegram.org/bot${this.token}/getUpdates?offset=${offset}&timeout=0&limit=1&allowed_updates=%5B%22message%22%5D`;
    try {
      const res = await fetch(url, {
        signal: timeoutSignal(TELEGRAM_CONTROL_TIMEOUT_MS),
      });
      if (!res.ok) {
        log.warn("telegram: ackUpdates non-OK", {
          status: res.status,
          offset,
        });
      }
    } catch (e) {
      log.warn("telegram: ackUpdates fetch failed", {
        error: (e as Error).message,
        offset,
      });
    }
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    // Telegram caps message length at 4096 chars. Truncate the SOURCE
    // markdown to stay clear of the cap after HTML conversion adds
    // tags. ~3500 source chars leaves comfortable headroom for the
    // tag overhead a heavily-formatted reply could introduce.
    const safe =
      text.length > 3500 ? text.slice(0, 3500) + "\n…[truncated]" : text;
    const html = markdownToTelegramHtml(safe);

    // First try: rendered HTML. If Telegram rejects with 400 (parse
    // error from a converter bug we haven't seen yet), retry once as
    // plain text so the user always gets *some* reply rather than the
    // assistant going silent on a malformed conversion.
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: html,
        parse_mode: "HTML",
      }),
      signal: timeoutSignal(TELEGRAM_CONTROL_TIMEOUT_MS),
    });
    if (res.ok) return;

    if (res.status === 400) {
      log.warn(
        "telegram: HTML sendMessage rejected, falling back to plain text",
        {
          chatId,
          status: res.status,
          // First 200 chars helps a future contributor reproduce the
          // converter bug without pulling the full transcript.
          htmlPreview: html.slice(0, 200),
        },
      );
      const fallback = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: safe }),
        signal: timeoutSignal(TELEGRAM_CONTROL_TIMEOUT_MS),
      });
      if (!fallback.ok) {
        log.warn("telegram: plain-text fallback also failed", {
          chatId,
          status: fallback.status,
        });
      }
      return;
    }

    log.warn("telegram: sendMessage non-OK", {
      chatId,
      status: res.status,
    });
  }

  async sendTyping(chatId: number): Promise<void> {
    const url = `https://api.telegram.org/bot${this.token}/sendChatAction`;
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
      signal: timeoutSignal(TELEGRAM_CONTROL_TIMEOUT_MS),
    }).catch(() => {
      /* typing indicator is best-effort */
    });
  }

  async sendRecording(chatId: number): Promise<void> {
    const url = `https://api.telegram.org/bot${this.token}/sendChatAction`;
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "record_voice" }),
      signal: timeoutSignal(TELEGRAM_CONTROL_TIMEOUT_MS),
    }).catch(() => {});
  }

  async sendVoice(
    chatId: number,
    audio: Buffer,
    mime: string,
  ): Promise<void> {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set(
      "voice",
      new Blob([audio], { type: mime || "audio/ogg" }),
      "voice.ogg",
    );
    const res = await fetch(
      `https://api.telegram.org/bot${this.token}/sendVoice`,
      {
        method: "POST",
        body: form,
        signal: timeoutSignal(TELEGRAM_DOWNLOAD_TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      log.warn("telegram: sendVoice non-OK", {
        chatId,
        status: res.status,
      });
    }
  }

  async downloadFile(
    fileId: string,
  ): Promise<{ data: Buffer; mime: string }> {
    // Two-step: getFile to get file_path, then GET the file URL.
    const meta = await fetch(
      `https://api.telegram.org/bot${this.token}/getFile?file_id=${encodeURIComponent(fileId)}`,
      { signal: timeoutSignal(TELEGRAM_CONTROL_TIMEOUT_MS) },
    );
    const metaBody = (await meta.json()) as {
      ok?: boolean;
      result?: { file_path?: string };
    };
    if (!metaBody.ok || !metaBody.result?.file_path) {
      throw new Error(`getFile failed for ${fileId}`);
    }
    // The file-body GET is the #135 wedge site: a non-voice attachment
    // download that never returns would stall this chat's serial chain
    // forever. The bounded signal makes a wedged download throw instead,
    // which the caller catches and degrades to "[attachment download
    // failed]".
    const file = await fetch(
      `https://api.telegram.org/file/bot${this.token}/${metaBody.result.file_path}`,
      { signal: timeoutSignal(TELEGRAM_DOWNLOAD_TIMEOUT_MS) },
    );
    const data = Buffer.from(await file.arrayBuffer());
    const mime =
      file.headers.get("content-type") ?? guessMimeFromPath(metaBody.result.file_path);
    return { data, mime };
  }

  async getMe(): Promise<{ ok: true; username: string } | { ok: false }> {
    const r = await telegramGetMe(this.token);
    return r.ok ? { ok: true, username: r.username } : { ok: false };
  }

  async setMyCommands(
    commands: Array<{ command: string; description: string }>,
  ): Promise<void> {
    const url = `https://api.telegram.org/bot${this.token}/setMyCommands`;
    // No `scope` → Telegram's default scope (BotCommandScopeDefault),
    // which is the one BotFather's manual /setcommands writes to. Passing
    // our full list here replaces whatever was there, so ghost commands
    // vanish from the `/` menu in both DMs and groups.
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commands }),
      signal: timeoutSignal(TELEGRAM_CONTROL_TIMEOUT_MS),
    }).catch((e) => {
      log.warn("telegram: setMyCommands fetch failed", {
        error: (e as Error).message,
      });
      return undefined;
    });
    if (res && !res.ok) {
      log.warn("telegram: setMyCommands non-OK", { status: res.status });
    }
  }
}

function guessMimeFromPath(path: string): string {
  if (path.endsWith(".oga") || path.endsWith(".ogg")) return "audio/ogg";
  if (path.endsWith(".mp3")) return "audio/mpeg";
  if (path.endsWith(".m4a")) return "audio/mp4";
  return "audio/ogg";
}

/**
 * Render an AbortSignal.reason as a short string for logging.
 * Callers pass plain strings ("stop", "reset", "interrupt"); the DOM
 * default for a parameterless abort() is a DOMException — fold it down
 * to its message so journalctl stays readable.
 */
function abortReasonString(reason: unknown): string {
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  return "aborted";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface TelegramRawFile {
  file_id?: string;
  file_size?: number;
  mime_type?: string;
  file_name?: string;
}

interface TelegramRawPhotoSize {
  file_id?: string;
  file_size?: number;
  width?: number;
  height?: number;
}

interface TelegramRawReplyToMessage {
  message_id?: number;
  text?: string;
  caption?: string;
  from?: { id?: number; is_bot?: boolean; username?: string };
}

interface TelegramRawUpdate {
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
 * Find which of `names` are addressed in `text`. A name matches
 * case-insensitively when bounded by non-letters, so "robbie" matches
 * inside "@robbie_agh_bot", "Robbie," or "robbie!" but NOT "robbiee" or
 * "scrobbie". Returns the matched names in the order they appear in
 * `names` (deduped, original casing preserved). Exported for testing.
 */
export function matchPersonaNames(text: string, names: string[]): string[] {
  if (text.length === 0 || names.length === 0) return [];
  const out: string[] = [];
  for (const name of names) {
    if (name.length === 0 || out.some((n) => n.toLowerCase() === name.toLowerCase())) {
      continue;
    }
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Letter boundaries (not \b, which treats "_" as a word char and so
    // would fail to match "robbie" inside "robbie_agh_bot").
    const re = new RegExp(`(?<![a-z])${escaped}(?![a-z])`, "i");
    if (re.test(text)) out.push(name);
  }
  return out;
}

/**
 * Decide whether THIS bot (persona `self`) should reply to a group message,
 * and what the chat's "last addressed" set becomes afterwards.
 *
 * Rules (all computed locally — Telegram never shows a bot another bot's
 * messages, so this must work from the human message stream alone, which
 * every bot in the group sees identically):
 *   - One or more persona names are in the message → those bots are now
 *     "addressed". I reply iff my own name is among them. Multiple names →
 *     each named bot replies independently.
 *   - No persona name at all → the message continues the current thread, so
 *     only the bot(s) addressed last reply. I reply iff I'm in lastAddressed.
 *   - No name AND nobody has ever been addressed (lastAddressed empty) →
 *     silence, full stop.
 *
 * Exported for testing.
 */
export function decideGroupReply(input: {
  self: string;
  matched: string[];
  lastAddressed: string[];
}): { reply: boolean; nextLastAddressed: string[] } {
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (input.matched.length > 0) {
    return {
      reply: input.matched.some((n) => eq(n, input.self)),
      nextLastAddressed: input.matched,
    };
  }
  return {
    reply: input.lastAddressed.some((n) => eq(n, input.self)),
    nextLastAddressed: input.lastAddressed,
  };
}

/**
 * Render the human messages a bot OBSERVED but didn't reply to (because they
 * were aimed at another bot or were thread chatter) into a context preamble.
 * Privacy-OFF means every bot sees every human message, so this is how a bot
 * catches up on the conversation it stayed quiet through before it's finally
 * addressed. Returns "" when there's nothing buffered. Exported for testing.
 */
export function formatGroupContext(
  entries: { from: string; text: string }[],
): string {
  // Both the sender label and the body are attacker-controlled; sanitize each
  // so a crafted username or message can't inject a newline + forged `]` that
  // closes this multi-line envelope early. (#161, item f)
  const lines = entries
    .map((e) => `${sanitizeEnvelopeField(e.from)}: ${sanitizeEnvelopeField(e.text)}`.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return "";
  return [
    "[Recent group messages you saw but didn't reply to, for context:",
    ...lines,
    "]",
  ].join("\n");
}

/** In-memory per-chat group routing state. Lives for the process lifetime;
 *  intentionally not persisted (it's cheap to rebuild from the live stream
 *  and bounded to GROUP_BUFFER_MAX entries per chat). */
interface GroupChatState {
  /** Persona names addressed by the most recent name-bearing message. */
  lastAddressed: string[];
  /** Rolling buffer of recent human messages for context catch-up. */
  buffer: { from: string; text: string; delivered: boolean }[];
}

/** Cap on buffered human messages retained per group chat. */
export const GROUP_BUFFER_MAX = 100;

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
        chatId: msg.chat.id,
        fromUserId: msg.from.id,
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
        chatId: msg.chat.id,
        fromUserId: msg.from.id,
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
        chatId: msg.chat.id,
        fromUserId: msg.from.id,
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

export interface RunTelegramServerInput {
  config: Config;
  memory: MemoryStore;
  harnesses: Harness[];
  agentDir: string;
  persona: string;
  transport: TelegramTransport;
  /**
   * Telegram account this listener is bound to. When omitted, falls
   * back to `config.channels.telegram` (single-bot legacy path).
   * `runRun()` always passes this explicitly so multi-persona listeners
   * each see their own token / allowlist / poll timeout.
   */
  account?: import("../config.ts").TelegramAccount;
  /** Stop after one polling cycle. For tests. */
  oneShot?: boolean;
  /** Signal to stop the loop cleanly. */
  signal?: AbortSignal;
  /**
   * Minimum gap between two `sendChatAction` calls (ms). Used to throttle
   * the per-chunk refresh so a fast stream-json burst doesn't fire
   * dozens of typing actions per second. Default 2000ms — well under
   * Telegram's ~5s chat-action lifetime, so the indicator stays solid
   * during continuous activity but vanishes within ~5s when the harness
   * goes silent (the truthful "frozen / no signal" cue). Tests pass a
   * smaller value for determinism.
   */
  typingThrottleMs?: number;
  out?: WriteSink;
  err?: WriteSink;
  /**
   * Optional override for the service control passed to /restart's
   * afterSend. Tests inject a stub so they can verify the channel
   * layer's "ack offset before fatal callback" ordering without
   * actually invoking systemctl on the developer's host. Production
   * leaves this undefined and /restart picks up the host backend.
   */
  serviceControl?: ServiceControl;
}

/**
 * The long-poll loop. Returns when signal is aborted, or after one
 * iteration if oneShot is set. Otherwise runs forever.
 *
 * Concurrency model:
 *
 *   - The polling loop never `await`s a turn directly. That was the
 *     bug that broke /stop in the old design — a hung tool call inside
 *     the harness blocked the polling loop, so even the next slash
 *     command from the same user couldn't be picked up off the wire.
 *
 *   - Slash commands are handled INLINE in the polling loop, so they
 *     respond immediately even when an LLM turn is running.
 *
 *   - Regular messages are queued onto a per-chat promise chain. Same
 *     chat → still serial (the LLM's history would get scrambled
 *     otherwise). Different chats → parallel.
 *
 *   - Each in-flight turn registers an AbortController under
 *     `activeTurns[chatId]` so /stop can abort it.
 *
 *   - On `oneShot`, we drain in-flight workers before returning so tests
 *     can assert on `transport.sent` without racing the workers.
 */
export async function runTelegramServer(
  input: RunTelegramServerInput,
): Promise<void> {
  const serverStartedAt = Date.now();
  // Prefer the explicit per-listener account passed by runRun(); fall
  // back to the legacy single-bot field for older callers (tests, and
  // anyone embedding runTelegramServer directly).
  const tg = input.account ?? input.config.channels.telegram!;
  const allowedSet = new Set(tg.allowedUserIds);
  const checkAllowed = (userId: number): boolean =>
    allowedSet.size === 0 || allowedSet.has(userId);

  // /harness reorders this in place — keep a local mutable copy so we
  // don't mutate the caller's array.
  const harnesses: Harness[] = [...input.harnesses];

  // Active turns per chat — keyed by chatId. Read by /stop and /status.
  const activeTurns = new Map<number, ActiveTurnHandle>();

  // Per-chat promise chain so messages within one chat stay ordered.
  // We chain `next = prev.then(work)` and store `next` here. When the
  // next message arrives, it chains off the latest entry.
  const chatChains = new Map<number, Promise<void>>();
  // Set of every in-flight worker promise — drained at shutdown / oneShot.
  const inFlight = new Set<Promise<void>>();

  // Per-chat group routing state (last-addressed bot + recent-message
  // buffer). Only touched for group/supergroup chats; DMs never key in.
  const groupChats = new Map<number, GroupChatState>();
  // This bot's own addressing token in groups is its persona name, which
  // must appear in the configured group_persona_names list (shared verbatim
  // across every bot in the group). Native @mentions route through the same
  // name matcher because a persona name embedded in the @username — "robbie"
  // in "@robbie_agh_bot" — matches on letter boundaries. The getMe @username
  // (botUsername, below) is used ONLY to strip the mention from dispatched
  // text, never for routing, so all bots decide from the same shared signal.
  const selfName = input.persona;
  const groupPersonaNames = (() => {
    const configured = tg.groupPersonaNames ?? [];
    // Always include our own persona name so a single-bot group works with
    // zero config; dedup case-insensitively, preserve configured order.
    const merged = [...configured];
    if (!merged.some((n) => n.toLowerCase() === selfName.toLowerCase())) {
      merged.push(selfName);
    }
    return merged;
  })();

  if (allowedSet.size === 0) {
    log.warn(
      "telegram: no allowed_user_ids configured — anyone who DMs the bot is answered",
    );
  }

  // One-time startup handshake (best-effort, never blocks the loop):
  //   1. getMe → learn our own @username so group messages that address
  //      us by mention can have the "@bot" stripped before dispatch.
  //   2. setMyCommands → register the real command menu, overwriting any
  //      ghost commands a human left in BotFather (e.g. /activation).
  // Both are wrapped so a transient Telegram hiccup at boot can't keep
  // the listener out of its poll loop.
  let botUsername: string | undefined;
  try {
    const me = await input.transport.getMe?.();
    if (me?.ok) {
      botUsername = me.username;
      log.info("telegram: identified self", {
        username: botUsername,
        persona: input.persona,
      });
    }
  } catch (e) {
    log.warn("telegram: getMe failed at startup", {
      error: (e as Error).message,
    });
  }
  try {
    if (input.transport.setMyCommands) {
      await input.transport.setMyCommands(TELEGRAM_BOT_COMMANDS);
      log.info("telegram: registered command menu", {
        count: TELEGRAM_BOT_COMMANDS.length,
        persona: input.persona,
      });
    }
  } catch (e) {
    log.warn("telegram: setMyCommands failed at startup", {
      error: (e as Error).message,
    });
  }

  let offset = 0;

  try {
    do {
      if (input.signal?.aborted) return;

      const { updates, nextOffset } = await input.transport.getUpdates(
        offset,
        tg.pollTimeoutS,
        input.signal,
      );
      // DELIBERATE DESIGN CHOICE — at-most-once delivery, not at-least-once.
      //
      // We advance the offset HERE, before the loop below enqueues per-chat
      // turns fire-and-forget. The next getUpdates therefore acks these updates
      // to Telegram even though their turns may still be in flight. A crash or
      // SIGTERM with turns unfinished will drop those messages: Telegram
      // considers them delivered and they are never reprocessed.
      //
      // This is intentional and is the RIGHT trade-off for this product. A
      // phantom is a conversational agent, not a durable task queue. Users are
      // mid-conversation with their agent — they are not submitting jobs to a
      // waterfall worklist that must each be guaranteed to run exactly once.
      // What matters here is concurrency and responsiveness: advancing the
      // offset immediately lets us poll the next batch and fan messages out to
      // independent per-chat turns without serializing the whole bot behind the
      // slowest in-flight turn. Blocking the poller until every turn durably
      // completed — or building a persistent inbox / ack-watermark + dedup
      // layer to get true at-least-once — would buy crash-replay of the rare
      // dropped message at the cost of the snappy, concurrent, fire-and-forget
      // experience that defines the agent. We choose the experience.
      //
      // In the worst case (process dies mid-turn) a user re-sends "you there?"
      // and the conversation continues. That is an acceptable, calculated loss.
      // Do NOT "fix" this by moving the offset advance below the loop or gating
      // it on turn completion without first re-litigating this trade-off.
      offset = nextOffset;

      for (const msg of updates) {
        if (input.signal?.aborted) return;

        if (!checkAllowed(msg.fromUserId)) {
          log.info("telegram: rejecting unauthorized user", {
            fromUserId: msg.fromUserId,
            fromUsername: msg.fromUsername,
          });
          continue;
        }

        const isVoice = Boolean(msg.voice);
        log.info("telegram: incoming", {
          chatId: msg.chatId,
          fromUserId: msg.fromUserId,
          fromUsername: msg.fromUsername,
          textLength: msg.text.length,
          persona: input.persona,
          voice: isVoice,
          voiceDurationS: msg.voice?.durationS,
          attachment: msg.attachment
            ? {
                kind: msg.attachment.kind,
                fileName: msg.attachment.fileName,
                fileSize: msg.attachment.fileSize,
                mimeType: msg.attachment.mimeType,
              }
            : undefined,
          captionLength: msg.caption?.length,
        });

        const isGroupChat =
          msg.chatType === "group" || msg.chatType === "supergroup";

        // Slash commands: handled INLINE so they bypass the per-chat queue
        // and any in-flight turn. Voice messages are never slash commands
        // (the body is empty until STT runs, by which point we've already
        // committed to the LLM path).
        if (!isVoice && msg.text.startsWith("/")) {
          // Group addressing applies to slash commands too. With privacy
          // mode off, EVERY bot in the group receives the command, so an
          // ungated /reset, /stop, /restart would fan out and act on every
          // bot at once. Decide eligibility the same way we gate normal
          // messages, but using the slash-specific `@BotName` target:
          //   - `/cmd@thisbot`   → only this bot acts.
          //   - `/cmd@otherbot`  → another bot's command; stay silent.
          //   - `/cmd` (no @)    → only the bot the thread is currently
          //                        with acts (sticky). If nobody is sticky
          //                        yet, stay silent — the user can target a
          //                        bot explicitly with `/cmd@botname`.
          // (DMs skip all of this; isGroupChat is false there.)
          if (isGroupChat) {
            const target = slashCommandTarget(msg.text);
            if (target) {
              if (
                !botUsername ||
                target.toLowerCase() !== botUsername.toLowerCase()
              ) {
                log.info("telegram: slash for another bot — ignoring", {
                  chatId: msg.chatId,
                  persona: input.persona,
                  target,
                });
                continue;
              }
            } else {
              const sticky = (
                groupChats.get(msg.chatId)?.lastAddressed ?? []
              ).some((n) => n.toLowerCase() === selfName.toLowerCase());
              if (!sticky) {
                log.info("telegram: untargeted group slash, not sticky — ignoring", {
                  chatId: msg.chatId,
                  persona: input.persona,
                });
                continue;
              }
            }
          }
          const result = await handleSlashCommand(msg.text, {
            chatId: msg.chatId,
            persona: input.persona,
            conversation: `telegram:${msg.chatId}`,
            memory: input.memory,
            harnesses,
            startedAt: serverStartedAt,
            activeTurn: activeTurns.get(msg.chatId),
            config: input.config,
            serviceControl: input.serviceControl,
            botUsername,
          });
          if (result) {
            try {
              await input.transport.sendMessage(msg.chatId, result.reply);
            } catch (e) {
              log.error("telegram: slash reply send failed", {
                error: (e as Error).message,
                chatId: msg.chatId,
              });
            }
            // afterSend runs strictly after sendMessage so heads-up
            // text lands before any side-effect that could kill us
            // (used by /update and /restart to trigger systemctl
            // restart). Before firing it, ack the current offset to
            // Telegram so a SIGTERM mid-restart doesn't leave the just-
            // handled command on the wire — without this, the next
            // process's long-poll re-delivers the same /restart and
            // the user gets two restarts from one tap. Ack is best-
            // effort: failures are logged inside ackUpdates and we
            // proceed regardless.
            if (result.afterSend) {
              await input.transport.ackUpdates(offset);
              try {
                await result.afterSend();
              } catch (e) {
                log.error("telegram: slash afterSend failed", {
                  error: (e as Error).message,
                  chatId: msg.chatId,
                });
              }
            }
            continue;
          }
          // Unrecognized /command — fall through to the LLM.
        }

        // Group reply gate. In a group/supergroup, privacy mode is OFF so
        // we receive every human message — but we must only SPEAK when
        // addressed (by name) or when we're the bot the thread is currently
        // with. Messages aimed at another bot are still buffered (for later
        // context) but produce no reply. DMs skip this entirely.
        let groupContext: string | undefined;
        if (isGroupChat) {
          const state = groupChats.get(msg.chatId) ?? {
            lastAddressed: [],
            buffer: [],
          };
          const matchText = [msg.text, msg.caption]
            .filter((s): s is string => Boolean(s && s.length > 0))
            .join(" ");
          // Routing is driven ONLY by the shared, identically-configured
          // persona-name list — never by this bot's own @username, which the
          // other bots cannot see. Letting a self-only username match change
          // the decision diverges state across bots: the addressed bot would
          // flip its lastAddressed while everyone else kept theirs, so a
          // previously-sticky bot keeps answering too and both answer every
          // no-name follow-up. The name matcher already catches @mentions
          // whose username embeds the persona name — "robbie" inside
          // "@robbie_agh_bot" matches on letter boundaries — so usernames
          // that follow that convention route correctly AND consistently for
          // every bot. (See the groupPersonaNames docs in config.ts.)
          const matched = matchPersonaNames(matchText, groupPersonaNames);
          const decision = decideGroupReply({
            self: selfName,
            matched,
            lastAddressed: state.lastAddressed,
          });
          state.lastAddressed = decision.nextLastAddressed;

          // What to retain in the rolling buffer for context catch-up.
          // Text messages keep their words; voice/attachments keep a label
          // so the thread reads coherently even where we have no transcript.
          const bufText =
            msg.text.trim().length > 0
              ? msg.text.trim()
              : (msg.caption?.trim() ||
                (msg.voice
                  ? "[voice message]"
                  : msg.attachment
                    ? `[${msg.attachment.kind}]`
                    : ""));
          const fromLabel = msg.fromUsername
            ? `@${msg.fromUsername}`
            : String(msg.fromUserId);

          if (!decision.reply) {
            if (bufText.length > 0) {
              state.buffer.push({
                from: fromLabel,
                text: bufText,
                delivered: false,
              });
            }
            while (state.buffer.length > GROUP_BUFFER_MAX) state.buffer.shift();
            groupChats.set(msg.chatId, state);
            log.info("telegram: group message not for this bot — staying quiet", {
              chatId: msg.chatId,
              persona: input.persona,
              matched,
              lastAddressed: state.lastAddressed,
            });
            continue;
          }

          // We're replying: hand the harness any messages we observed but
          // never answered as a context preamble, then mark the buffer
          // delivered and record this turn.
          const undelivered = state.buffer.filter((e) => !e.delivered);
          groupContext = formatGroupContext(undelivered) || undefined;
          for (const e of state.buffer) e.delivered = true;
          if (bufText.length > 0) {
            state.buffer.push({
              from: fromLabel,
              text: bufText,
              delivered: true,
            });
          }
          while (state.buffer.length > GROUP_BUFFER_MAX) state.buffer.shift();
          groupChats.set(msg.chatId, state);
        }

        // Regular message. If a turn is already in flight for this
        // chat, abort it — the user typing again means "pay attention
        // to this instead." The aborted turn returns silently via the
        // wasAborted path; only the new turn's reply lands. Same UX
        // as Claude Code's "type to interrupt." The new task still
        // chains off `prev` (the aborted turn's worker promise) so
        // the harness's process group has time to clean up before we
        // spawn the next subprocess.
        const active = activeTurns.get(msg.chatId);
        if (active) {
          log.info("telegram: new message — interrupting active turn", {
            chatId: msg.chatId,
            elapsedS: (
              (Date.now() - active.startTime) / 1000
            ).toFixed(1),
          });
          active.controller.abort("interrupt");
        }

        // Enqueue onto this chat's serial chain.
        // Convert prior rejection to resolution so a thrown
        // processChatMessage doesn't wedge the per-chat queue (GitHub #135).
        const prev = (chatChains.get(msg.chatId) ?? Promise.resolve()).catch(
          () => {},
        );
        const next = prev.then(() =>
          processChatMessage(msg, {
            input,
            harnesses,
            activeTurns,
            botUsername,
            groupContext,
            // Security perimeter: this turn is TRUSTED only if the sender
            // is an explicitly allow-listed principal. An empty allowlist
            // means "open bot" (anyone can DM) — that is NOT an
            // authenticated principal, so trust stays false and the
            // system fails closed. `checkAllowed` (which lets the empty
            // case through for *answering*) is deliberately NOT reused
            // here: answering an open bot is fine; granting it authority
            // to write security rules is not.
            principalAuthenticated:
              allowedSet.size > 0 && allowedSet.has(msg.fromUserId),
          }),
        );
        // Detach completed entries so the maps don't leak.
        const tracked = next.finally(() => {
          if (chatChains.get(msg.chatId) === tracked) {
            chatChains.delete(msg.chatId);
          }
          inFlight.delete(tracked);
        });
        chatChains.set(msg.chatId, tracked);
        inFlight.add(tracked);
      }
    } while (!input.oneShot);
  } finally {
    // Drain pending workers so tests can assert on transport state, and
    // production shutdowns don't leave zombie subprocesses behind.
    if (inFlight.size > 0) {
      await Promise.allSettled([...inFlight]);
    }
  }
}

/** Thrown when the STT download+transcribe step exceeds its time budget. */
class SttTimeoutError extends Error {
  constructor(ms: number) {
    super(`STT step exceeded ${ms}ms budget`);
    this.name = "SttTimeoutError";
  }
}

/**
 * Race `p` against a timer. If the timer wins, reject with SttTimeoutError so
 * the caller's catch can recover and the per-chat queue advances (GitHub
 * #135). We cannot cancel the underlying request — the transport exposes no
 * AbortSignal — so the orphaned promise is left to settle on its own; the
 * point is that the *queue* no longer waits on it.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SttTimeoutError(ms)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Process one (non-slash) message: STT if voice, run the harness chain,
 * send the reply. Stays self-contained so the polling loop can fire-and-
 * track via Promise.allSettled at shutdown.
 */
async function processChatMessage(
  msg: TelegramMessage,
  ctx: {
    input: RunTelegramServerInput;
    harnesses: Harness[];
    activeTurns: Map<number, ActiveTurnHandle>;
    /** Our own @username (from startup getMe), used to strip the
     *  addressing mention from group messages. Undefined if getMe
     *  failed — stripping then no-ops. */
    botUsername?: string;
    /** Recent group messages this bot observed but didn't answer,
     *  pre-rendered as a context preamble. Prepended to the user text so
     *  the harness has the thread it stayed quiet through. */
    groupContext?: string;
    /** Security-perimeter provenance: true only when the sender is an
     *  explicitly allow-listed principal. Flows to runTurn as `trusted`,
     *  which gates command-vs-data framing in the prompt AND the
     *  PHANTOMBOT_TRUST env token that lets `phantombot security` write
     *  rules. Defaults false (fail closed) for the open-bot case. */
    principalAuthenticated?: boolean;
  },
): Promise<void> {
  const { input, harnesses, activeTurns } = ctx;
  const startedAt = Date.now();
  const isVoice = Boolean(msg.voice);

  // Group addressing: in a group/supergroup the only way a message
  // reaches us under Telegram privacy mode is by mentioning our
  // @username (or replying to us). Strip that mention so the harness
  // sees the user's actual words — "@robbie_agh_bot deploy now" becomes
  // "deploy now". Applied to both the text and any media caption, before
  // STT/attachment handling rewrites msg.text. DMs are never touched
  // (you don't @-address a bot in its own DM), and with privacy OFF the
  // strip is still correct for the mentions that do carry it.
  if (
    (msg.chatType === "group" || msg.chatType === "supergroup") &&
    ctx.botUsername
  ) {
    if (msg.text.length > 0) {
      msg.text = stripBotMention(msg.text, ctx.botUsername);
    }
    if (msg.caption) {
      msg.caption = stripBotMention(msg.caption, ctx.botUsername);
    }
  }

  // For voice messages: download → transcribe → use the transcript as
  // the user message before invoking the harness.
  if (isVoice && msg.voice) {
    const stt = sttSupport(input.config);
    if (!stt.ok) {
      await input.transport.sendMessage(
        msg.chatId,
        voiceUnavailableMessage(stt),
      );
      return;
    }
    const fileId = msg.voice.fileId;
    try {
      // Bound the whole download+transcribe step. A hung request here would
      // otherwise never settle, stalling every later message in this chat's
      // serial queue forever — the wedge in GitHub #135.
      const r = await withTimeout(
        (async () => {
          const file = await input.transport.downloadFile(fileId);
          return transcribe(input.config, file.data, file.mime);
        })(),
        input.config.voice.sttTimeoutMs ?? DEFAULT_STT_TIMEOUT_MS,
      );
      if (!r.ok) {
        log.error("telegram: STT failed", {
          error: r.error,
          persona: input.persona,
          chatId: msg.chatId,
        });
        try {
          await input.transport.sendMessage(
            msg.chatId,
            "🎙️ I couldn’t make out that voice note — the audio may be unclear or too quiet. Please try again, or type your message.",
          );
        } catch (sendErr) {
          log.warn("telegram: STT failure notice send failed", {
            error: (sendErr as Error).message,
            chatId: msg.chatId,
          });
        }
        return;
      }
      msg.text = r.text;
      log.info("telegram: STT ok", {
        chatId: msg.chatId,
        persona: input.persona,
        transcriptChars: r.text.length,
      });
    } catch (e) {
      log.error("telegram: STT pipeline error", {
        error: (e as Error).message,
        persona: input.persona,
        chatId: msg.chatId,
      });
      try {
        await input.transport.sendMessage(
          msg.chatId,
          "⚠️ Something went wrong processing that voice note. Please try again in a moment, or type your message.",
        );
      } catch (sendErr) {
        log.warn("telegram: STT failure notice send failed", {
          error: (sendErr as Error).message,
          chatId: msg.chatId,
        });
      }
      return;
    }
  }

  // Non-voice attachment: download to per-chat inbox, then rewrite the
  // user-facing text to "<caption>\n\n[attached: <abs-path>]". The
  // harness decides what to do with the file — read, ignore, ask. We
  // never inspect or transform contents.
  if (msg.attachment) {
    const att = msg.attachment;
    let savedPath: string | undefined;
    let oversizeBytes: number | undefined;
    let downloadError: string | undefined;

    if (
      att.fileSize !== undefined &&
      att.fileSize > TELEGRAM_BOT_DOWNLOAD_CAP_BYTES
    ) {
      oversizeBytes = att.fileSize;
      log.warn("telegram: attachment over bot-API cap, not downloading", {
        chatId: msg.chatId,
        kind: att.kind,
        fileName: att.fileName,
        fileSize: att.fileSize,
      });
    } else {
      try {
        const dir = inboxDir(msg.chatId);
        await mkdir(dir, { recursive: true });
        // basename strips any path separators or "../" climbs from
        // Telegram's user-controlled file_name field — without this,
        // a sender with file_name="../../etc/passwd" could write
        // outside the inbox dir.
        const path = join(dir, `${msg.updateId}-${basename(att.fileName)}`);
        const file = await input.transport.downloadFile(att.fileId);
        await writeFile(path, file.data);
        savedPath = path;
        log.info("telegram: attachment saved", {
          chatId: msg.chatId,
          kind: att.kind,
          path,
          bytes: file.data.byteLength,
          mime: file.mime,
        });
      } catch (e) {
        downloadError = (e as Error).message;
        log.error("telegram: attachment download failed", {
          chatId: msg.chatId,
          kind: att.kind,
          fileName: att.fileName,
          error: downloadError,
        });
      }
    }

    msg.text = formatAttachmentUserText({
      caption: msg.caption,
      attachment: att,
      savedPath,
      oversizeBytes,
      downloadError,
    });
  }

  // Reply-modality routing.
  //
  //   default       — mirror the input modality (voice-in → voice-out,
  //                   text-in → text-out)
  //   user override — explicit per-message directive in the message
  //                   text ("reply in text", "send a voice note") flips
  //                   the wire format. Applies AFTER STT so the
  //                   transcript is what gets inspected for voice-in.
  //
  // Voice is still capped by ttsSupported(): if the user asks for a
  // voice reply but the provider can't do TTS, we degrade to text
  // gracefully (same fallback as the original voice-in path).
  const modalityOverride = replyModalityOverride(msg.text);
  const wantsVoiceReply =
    modalityOverride === "voice"
      ? true
      : modalityOverride === "text"
        ? false
        : isVoice;
  const willReplyWithVoice = wantsVoiceReply && ttsSupported(input.config);

  // Forward `reply_to_message` context AFTER modality detection so a
  // quoted "send a voice note" can't flip routing for a fresh "merge"
  // reply. We mutate `msg.text` so both the harness call and the
  // interrupted-pair persistence (further down) see the same envelope.
  if (msg.replyTo) {
    const prefix = formatReplyToContext(msg.replyTo);
    msg.text = msg.text.length > 0 ? `${prefix}\n\n${msg.text}` : prefix;
  }
  // Group catch-up context goes at the very top, above any reply-quote, so
  // the harness reads the room before the specific turn it's answering.
  if (ctx.groupContext) {
    msg.text =
      msg.text.length > 0
        ? `${ctx.groupContext}\n\n${msg.text}`
        : ctx.groupContext;
  }
  const sendStatus = () =>
    willReplyWithVoice
      ? input.transport.sendRecording(msg.chatId)
      : input.transport.sendTyping(msg.chatId);
  const streaming = input.config.telegramStreaming ?? DEFAULT_TELEGRAM_STREAMING;
  const segmenterOptions = {
    maxSentences: streaming.bubbleMaxSentences,
    maxChars: streaming.bubbleMaxChars,
  };

  // Indicator policy: refresh on EVERY harness chunk (text, heartbeat,
  // progress). When chunks stop, the indicator naturally expires after
  // ~5s — that vanishing IS the user-visible "harness has gone silent /
  // possibly frozen" signal. One exception: during tool execution,
  // gemini-cli emits zero events (potentially for minutes), which would
  // make the indicator expire and look frozen. For that gap we run a
  // background refresh timer (startToolRefresh / stopToolRefresh). The
  // throttle just prevents stream-json bursts from hitting Telegram's
  // per-bot rate cap.
  const throttleMs = input.typingThrottleMs ?? 2000;
  let lastSendStatusAt = 0;
  const refreshIndicator = () => {
    const now = Date.now();
    if (now - lastSendStatusAt < throttleMs) return;
    lastSendStatusAt = now;
    void sendStatus();
  };

  // Background typing/recording indicator refresh during tool execution.
  // gemini-cli emits zero events while a tool runs (potentially minutes),
  // causing Telegram's chat-action indicator to expire after ~5s. This
  // interval timer keeps it visible during the gap. Started on the first
  // `progress` event, stopped on the next `text` / `heartbeat` / `done`
  // / `error` / `finally`.
  let toolRefreshTimer: ReturnType<typeof setInterval> | undefined;
  const startToolRefresh = () => {
    if (toolRefreshTimer) return; // already running
    toolRefreshTimer = setInterval(() => {
      refreshIndicator();
      void flushNarration();
    }, Math.min(1000, streaming.narrationFlushMs));
  };
  const stopToolRefresh = () => {
    if (toolRefreshTimer) {
      clearInterval(toolRefreshTimer);
      toolRefreshTimer = undefined;
    }
  };

  // Initial nudge so the user sees "typing…" the moment we start
  // working, before the first chunk lands.
  refreshIndicator();

  // Register the AbortController so /stop can find us.
  const controller = new AbortController();
  const turnHandle: ActiveTurnHandle = {
    controller,
    startTime: startedAt,
  };
  activeTurns.set(msg.chatId, turnHandle);

  // Streaming accumulators.
  //
  //   streamedReply       — running sum of `text` chunks seen so far
  //   consumedReplyChars  — prefix length already delivered as final text OR
  //                         classified as narration and intentionally removed
  //                         from the final answer
  //   narrationBuffer     — classified progress text waiting for the timed
  //                         progress flush, coalesced across tool calls
  //   finalSegmenter      — markdown-aware live splitter for candidate final
  //                         answer text
  //   finalReply          — set on the `done` chunk; authoritative full text
  //
  // Voice-out skips text streaming entirely; it is split into short voice
  // clips after the full reply is known.
  let streamedReply = "";
  let consumedReplyChars = 0;
  let narrationBuffer = "";
  let narrationBubblesSent = 0;
  let finalSegmenter = new StreamSegmenter(segmenterOptions);
  let finalCandidateText = "";
  let finalCandidateSentChars = 0;
  let finalBubblesSent = 0;
  let finalReply: string | undefined;
  let errored: string | undefined;
  let progressCount = 0;
  let chosenHarness: string | undefined;
  let lastNarrationFlushAt = Date.now();

  const sendTextSegment = async (
    text: string,
    kind: "narration" | "final" | "error",
  ) => {
    if (text.trim().length === 0) return;
    try {
      await input.transport.sendMessage(msg.chatId, text);
      if (kind === "narration") narrationBubblesSent++;
      if (kind === "final") finalBubblesSent++;
    } catch (e) {
      log.warn(`telegram: ${kind} send failed`, {
        error: (e as Error).message,
        chatId: msg.chatId,
      });
    }
    refreshIndicator();
  };

  const sendFinalSegments = async (text: string) => {
    const segments = splitIntoSegments(text, segmenterOptions);
    for (let i = 0; i < segments.length; i++) {
      await sendTextSegment(segments[i]!, "final");
      if (i < segments.length - 1 && streaming.bubbleDelayMs > 0) {
        await sleep(streaming.bubbleDelayMs);
      }
    }
  };

  const resetFinalCandidate = () => {
    finalSegmenter = new StreamSegmenter(segmenterOptions);
    finalCandidateText = "";
    finalCandidateSentChars = 0;
  };

  // Flush coalesced progress narration on a clock, not on every tool
  // boundary. Tool boundaries classify preceding text as narration; this
  // timer decides when, if ever, that narration becomes a progress bubble.
  const flushNarration = async (force = false) => {
    if (willReplyWithVoice) return;
    if (narrationBuffer.trim().length === 0) return;
    const now = Date.now();
    if (!force && now - lastNarrationFlushAt < streaming.narrationFlushMs) {
      return;
    }
    const pending = narrationBuffer;
    narrationBuffer = "";
    lastNarrationFlushAt = now;
    await sendTextSegment(pending, "narration");
  };

  // Mechanical capture nudge: every CAPTURE_NUDGE_INTERVAL user turns
  // without a `memory capture`, append a reminder to the system-prompt
  // suffix. Only for real `telegram:*` conversations — never tick:/system:.
  // runTurn appends this incoming message to `turns` only AFTER the turn,
  // so we count prior user turns + 1 to land the nudge on the Nth turn.
  const conversationKey = `telegram:${msg.chatId}`;
  let captureNudge: string | undefined;
  if (conversationKey.startsWith("telegram:")) {
    captureNudge = await captureNudgeForTurn(
      input.memory,
      input.persona,
      conversationKey,
    );
  }

  try {
    for await (const chunk of runTurn({
      persona: input.persona,
      conversation: conversationKey,
      userMessage: msg.text,
      agentDir: input.agentDir,
      harnesses,
      memory: input.memory,
      idleTimeoutMs: input.config.harnessIdleTimeoutMs,
      hardTimeoutMs: input.config.harnessHardTimeoutMs,
      signal: controller.signal,
      // Security perimeter: the ONLY place `trusted: true` originates.
      // True iff the sender is an allow-listed principal (see the
      // principalAuthenticated computation at the dispatch call site).
      trusted: ctx.principalAuthenticated === true,
      // Threat screen for the untrusted case (open bot / non-allowlisted
      // sender). runTurn only consults this when trusted !== true, so an
      // allow-listed principal is never screened. The judge runs on the
      // chain's claude harness; if the chain has none, screening fails open.
      screen: makeScreener(input.config, input.persona, conversationKey, harnesses),
      // Instinct layer: auto-retrieve relevant memory/kb for this message.
      // makeRetriever returns undefined when retrieval is disabled in
      // config, in which case runTurn skips it entirely.
      retrieve: makeRetriever(
        input.config,
        input.persona,
        input.agentDir,
        conversationKey,
      ),
      indexTurns: makeTurnIndexer(
        input.config,
        input.persona,
        conversationKey,
        input.memory,
      ),
      // Channel-layer prompt suffix:
      //   - Always: TELEGRAM_REPLY_INSTRUCTION — short conversational
      //     replies + plan-then-confirm before long jobs (git/build/
      //     deploy or anything that would spawn more than one tool call).
      //   - Voice-out: stack VOICE_REPLY_INSTRUCTION on top — stricter
      //     1-3 sentence limit and no markdown so TTS doesn't read out
      //     headers/bullets.
      // Living at the channel layer (not in persona files) keeps these
      // rules from leaking into CLI/nightly turns, where verbosity is
      // fine and the user isn't on a phone.
      // The mechanical capture nudge (when due) stacks last so it is
      // the freshest standing instruction the harness sees this turn —
      // exactly the salience boost weak harnesses need.
      systemPromptSuffix: [
        willReplyWithVoice
          ? `${TELEGRAM_REPLY_INSTRUCTION}\n\n${VOICE_REPLY_INSTRUCTION}`
          : TELEGRAM_REPLY_INSTRUCTION,
        captureNudge,
      ]
        .filter(Boolean)
        .join("\n\n"),
      // Pre-tool narration: ON for text-out (the user sees streamed
      // text as it lands, so a "checking your calendar..." sentence
      // before a tool call usefully fills the silence). OFF for
      // voice-out: the reply is synthesized after the full response is
      // known, so narration would just lengthen the spoken output
      // without helping with perceived latency. VOICE_REPLY_INSTRUCTION
      // already forbids work narration too, so off is consistent.
      toolNarration: !willReplyWithVoice,
    })) {
      if (chunk.type === "text") {
        streamedReply += chunk.text;
        stopToolRefresh();
        refreshIndicator();
        if (!willReplyWithVoice) {
          finalCandidateText += chunk.text;
          const { segments } = finalSegmenter.push(chunk.text);
          for (const segment of segments) {
            await sendTextSegment(segment, "final");
            consumedReplyChars += segment.length;
            finalCandidateSentChars += segment.length;
            if (streaming.bubbleDelayMs > 0) {
              await sleep(streaming.bubbleDelayMs);
            }
          }
        }
      }
      if (chunk.type === "heartbeat") {
        // Tool completed (or model is thinking) — stop the background
        // tool-refresh timer and show the indicator naturally.
        stopToolRefresh();
        refreshIndicator();
        await flushNarration();
      }
      if (chunk.type === "progress") {
        progressCount++;
        // Stash the latest progress note on the active-turn handle so
        // /status can show "currently: <tool>" in real time.
        turnHandle.lastProgressNote = chunk.note.slice(0, 500);
        log.debug("telegram: progress", {
          chatId: msg.chatId,
          note: chunk.note.slice(0, 200),
        });
        // A tool is about to run. The text emitted since the previous
        // boundary was progress narration unless it already crossed the
        // markdown-aware final-answer splitter and got sent as a readable
        // final bubble. Buffer the unsent remainder for the timed progress
        // flush, then consume it so it is not duplicated in finalText.
        const unsentCandidate = finalCandidateText.slice(
          finalCandidateSentChars,
        );
        if (unsentCandidate.trim().length > 0) {
          narrationBuffer += unsentCandidate;
        }
        consumedReplyChars = streamedReply.length;
        resetFinalCandidate();
        await flushNarration();
        // Start a background timer to keep the typing/recording
        // indicator visible during tool execution. Without this,
        // gemini-cli's multi-minute tool runs cause Telegram's
        // indicator to expire after ~5s, making it look like the
        // bot has frozen. Stopped on the next text/heartbeat/done/error.
        startToolRefresh();
      }
      if (chunk.type === "done") {
        finalReply = chunk.finalText;
        const meta = chunk.meta as { harnessId?: unknown } | undefined;
        if (typeof meta?.harnessId === "string") {
          chosenHarness = meta.harnessId;
        }
      }
      if (chunk.type === "error") errored = chunk.error;
    }
  } catch (e) {
    errored = (e as Error).message;
    log.error("telegram: turn threw", { error: errored });
  } finally {
    stopToolRefresh();
    // Only deregister if we're still the active turn for this chat.
    // (Defensive: a /reset or /stop could have replaced us.)
    if (activeTurns.get(msg.chatId) === turnHandle) {
      activeTurns.delete(msg.chatId);
    }
  }

  // The controller was aborted from outside. Causes:
  //   - "stop"      — /stop slash command (slash handler already replied).
  //   - "reset"     — /reset slash command (handler replied; history wiped).
  //   - "interrupt" — a new message arrived for this chat; the new
  //                   turn supersedes us. Stay silent so only the new
  //                   reply lands.
  // In every case, suppress the would-be reply.
  if (controller.signal.aborted) {
    const reason = abortReasonString(controller.signal.reason);
    log.info("telegram: turn aborted", {
      chatId: msg.chatId,
      durationMs: Date.now() - startedAt,
      reason,
    });
    // Persist a synthetic interrupted-pair so the next turn knows what
    // the user just said and that the agent never got to respond.
    // Without this, follow-ups like "actually use blue instead" land
    // with no referent in history and the model is surprised. Skip
    // when:
    //   - reason === "reset"  → /reset just wiped this conversation;
    //                           writing here would un-wipe it.
    //   - msg.text.length === 0 → voice message aborted before STT
    //                             completed; nothing meaningful to log.
    if (reason !== "reset" && msg.text.length > 0) {
      try {
        await input.memory.appendTurnPair(
          {
            persona: input.persona,
            conversation: `telegram:${msg.chatId}`,
            role: "user",
            text: msg.text,
          },
          {
            persona: input.persona,
            conversation: `telegram:${msg.chatId}`,
            role: "assistant",
            text: "[interrupted before reply]",
          },
        );
      } catch (e) {
        log.warn("telegram: failed to persist interrupted-pair", {
          chatId: msg.chatId,
          error: (e as Error).message,
        });
      }
    }
    return;
  }

  // The harness chain failed with a (recoverable) diagnostic — almost
  // always a wedged tool call tripping the idle timeout. We NEVER show the
  // raw internal string: it's English-only and reads like a crash. Instead
  // re-prompt the chain ONCE for a short, language-matched human reply
  // ("hit a snag, mind trying again?") and deliver that like any normal
  // message. If even the recovery turn can't produce text, we stay silent —
  // the diagnostic is already in the journal.
  let recoveryText: string | undefined;
  if (errored) {
    log.error("telegram: turn failed; generating recovery reply", {
      chatId: msg.chatId,
      error: errored,
    });
    recoveryText = await generateRecoveryReply({
      harnesses,
      userMessage: msg.text,
      personaName: input.persona,
      signal: controller.signal,
    });
  }
  // True only when the turn failed AND recovery couldn't produce anything.
  // `errored` itself is left intact so the telemetry below still records
  // that the underlying turn failed.
  const unrecoverable = !!errored && !recoveryText;

  // The authoritative full reply: a recovery message if we made one, else
  // the harness's done.finalText (possibly reformatted), else whatever
  // streamed live.
  const fullReply = recoveryText ?? finalReply ?? streamedReply;

  // Compute what still needs to be sent after live streaming:
  //   - unrecoverable failure: stay silent (diagnostic is logged, never shown)
  //   - consumed prefix matches: send only the suffix (the part the user
  //     hasn't seen yet, after live final bubbles and classified narration)
  //   - consumed prefix doesn't match (harness reformatted, or a recovery
  //     reply unrelated to the streamed text): send the full reply. We
  //     accept some duplication over silently truncating.
  //   - nothing came back AND nothing visible was sent: "(no reply)"
  //   - nothing came back BUT progress/final bubbles landed: stay silent
  let outText: string;
  if (unrecoverable) {
    outText = "";
  } else if (fullReply.length === 0) {
    // Empty reply: in a DM the "(no reply)" placeholder is a useful signal
    // that the turn produced nothing. In a GROUP it's pure noise — a bot
    // legitimately stays silent for messages aimed at someone else (or when
    // the persona simply chooses not to speak), and rendering "(no reply)"
    // turns that silence into a visible bubble. Suppress it in groups, belt-
    // and-braces with the routing gate that already skips most such turns.
    const isGroupChat =
      msg.chatType === "group" || msg.chatType === "supergroup";
    outText =
      narrationBubblesSent > 0 || finalBubblesSent > 0 || isGroupChat
        ? ""
        : "(no reply)";
  } else if (
    consumedReplyChars > 0 &&
    fullReply.startsWith(streamedReply.slice(0, consumedReplyChars))
  ) {
    outText = fullReply.slice(consumedReplyChars);
  } else {
    outText = fullReply;
  }

  // Voice in → voice out (when TTS is configured AND we have something to
  // say — including a recovery reply). Text in → text out, always. The
  // reply lands as a fresh message, so Telegram pushes a notification —
  // important when the user kicked off a long job and walked away.
  //
  // Voice-out synthesizes the full reply, split into short clips. Text
  // streaming is disabled for voice, so there is nothing to dedupe.
  let sentAsVoice = false;
  try {
    if (willReplyWithVoice && !unrecoverable && fullReply.length > 0) {
      const voiceSegments = splitIntoSegments(fullReply, {
        maxSentences: streaming.voiceMaxSentences,
        maxChars: streaming.bubbleMaxChars,
      });
      for (const segment of voiceSegments) {
        const r = await synthesize(input.config, segment);
        if (r.ok) {
          await input.transport.sendVoice(
            msg.chatId,
            r.audio.data,
            r.audio.mime,
          );
          sentAsVoice = true;
        } else {
          log.warn("telegram: TTS failed; falling back to text", {
            error: r.error,
          });
          await sendFinalSegments(fullReply);
          sentAsVoice = false;
          break;
        }
      }
    } else if (outText.length > 0) {
      // Empty outText is intentional silence: streaming/progress bubbles
      // already delivered all useful output, or the turn failed
      // unrecoverably (diagnostic logged, nothing shown). Otherwise, split
      // the remaining final reply — a normal answer or a recovery message —
      // into markdown-safe Telegram bubbles.
      await sendFinalSegments(outText);
    }
  } catch (e) {
    log.error("telegram: send failed", {
      error: (e as Error).message,
      chatId: msg.chatId,
    });
  }

  log.info("telegram: complete", {
    chatId: msg.chatId,
    durationMs: Date.now() - startedAt,
    replyChars: outText.length,
    consumedReplyChars,
    narrationBubbles: narrationBubblesSent,
    finalBubbles: finalBubblesSent,
    progressEvents: progressCount,
    harness: chosenHarness ?? (errored ? "(error)" : "(unknown)"),
    modality: sentAsVoice ? "voice" : "text",
    inputModality: isVoice ? "voice" : "text",
    modalityOverride: modalityOverride ?? "none",
    ok: !errored,
    // Turn failed at the harness level but a language-matched recovery
    // reply was generated and delivered instead of a raw diagnostic.
    recovered: !!errored && !unrecoverable,
  });
}

/**
 * System-prompt suffix applied to EVERY Telegram turn.
 *
 * Two purposes:
 *
 * 1. Reply style. The user is on a phone with a narrow column. Long
 *    walls of text and meta-narration ("Let me check…", "Right,
 *    here's what I found…") read poorly there. Default to short,
 *    conversational answers; structured-and-clear is fine when the
 *    user explicitly asks for a detailed report.
 *
 * 2. Plan-then-confirm before long jobs. A Telegram round-trip is
 *    seconds, but a misaligned 10-minute build burns the user's time
 *    AND tokens. Asking the agent to outline the plan and wait for
 *    confirmation when it's about to do something irreversible (git
 *    push, deploy) or expensive (multi-tool-call work) avoids that.
 *
 * Lives at the channel layer (not in persona files) so CLI / nightly
 * turns aren't affected — those run unattended and don't want a
 * confirmation gate, and verbose CLI output is fine.
 */
export const TELEGRAM_REPLY_INSTRUCTION =
  `# Reply style (Telegram chat)

You're chatting via Telegram. Default to short, conversational
replies — typically 1-4 sentences. The user is usually on a phone,
and the narrow column makes long walls of text hard to read. Skip
narration ("Let me…", "Right, here's what I found…"); answer directly.

Longer replies are fine when the user explicitly asks for a detailed
report or analysis. Use clear structure (headings, lists) when the
content earns it.

# Confirm before long jobs

Before starting any of these, briefly outline your plan in 2-3
sentences and ask the user to confirm or adjust:

- Anything involving git, build, or deploy operations
- Anything where you're going to spawn more than one tool call

Telegram round-trips are slow and tokens aren't free — confirming up
front beats producing the wrong thing minutes later. For
straightforward questions, just answer.`;

/**
 * Mechanical capture nudge — every {@link CAPTURE_NUDGE_INTERVAL} user
 * turns without a `memory capture`, the dispatch appends this to the
 * system-prompt suffix. Pure turn counter; no LLM decides whether to
 * nudge. Counteracts long-context dilution on weak harnesses that
 * weight standing instructions less.
 */
export const CAPTURE_NUDGE_INTERVAL = 30;

export const CAPTURE_NUDGE_TEXT =
  `${CAPTURE_NUDGE_INTERVAL} turns without a memory capture in this ` +
  `conversation. If a decision, lesson, person fact or commitment came ` +
  `up, capture it now with \`phantombot memory capture\`. If nothing is ` +
  `worth keeping, carry on — no capture is a valid answer.`;

/**
 * Decide whether to append the capture nudge for this turn.
 *
 * Counts `role = 'user'` turns since the last capture in this
 * (persona, conversation) — so any capture resets the counter for free
 * and the nudge re-fires at 2x, 3x, … if still dry. State lives entirely
 * in `memory.sqlite`, shared by the long-running phantombot process and
 * the short-lived `memory capture` CLI call, so the two stay in sync.
 *
 * The current incoming user message is NOT yet persisted to `turns`
 * (runTurn appends it only after the turn completes), so the effective
 * turn index is `countUserTurnsSince(...) + 1`. The nudge fires when
 * that effective index is a positive multiple of `interval` — i.e. on
 * the 30th, 60th, … dry turn.
 *
 * Only meaningful for real `telegram:*` conversations — the caller is
 * responsible for that gate.
 */
export async function captureNudgeForTurn(
  memory: MemoryStore,
  persona: string,
  conversation: string,
  interval = CAPTURE_NUDGE_INTERVAL,
): Promise<string | undefined> {
  try {
    const since =
      (await memory.lastCaptureAt(persona, conversation)) ??
      "1970-01-01T00:00:00.000Z";
    const priorTurns = await memory.countUserTurnsSince(
      persona,
      conversation,
      since,
    );
    // +1 for the current message, not yet written to `turns`.
    const effectiveTurn = priorTurns + 1;
    if (effectiveTurn > 0 && effectiveTurn % interval === 0) {
      return CAPTURE_NUDGE_TEXT;
    }
  } catch (e) {
    // A nudge is a nice-to-have — never let a counter query fail a turn.
    log.warn("telegram: capture nudge check failed", {
      error: (e as Error).message,
    });
  }
  return undefined;
}

/**
 * Voice-only overlay, stacked on top of TELEGRAM_REPLY_INSTRUCTION
 * when the reply will be synthesized via TTS.
 *
 * Why this exists separately: the chat-style instruction allows
 * "longer when asked" and structured markdown — both wrong for TTS,
 * which reads bullets/headers awkwardly and turns 4-sentence replies
 * into 90-second voice notes. This overlay tightens the length cap
 * to 1-3 sentences and forbids markdown.
 */
export const VOICE_REPLY_INSTRUCTION =
  `# Reply length (this turn only)

This message arrived as a voice note and your reply will be spoken
aloud via text-to-speech. Reply briefly and conversationally — 1-3
sentences, under ~30 seconds of speech (≈60 words / ≈100 tokens).
Output only the final answer — no narration of your work
("Let me check…"), no markdown headers/bullets/code blocks (TTS
reads them awkwardly), no "according to my analysis" preamble.
Just the human reply.`;

/**
 * Render an honest, actionable explanation when sttSupport() rules a
 * voice message out. Each variant points at the specific user action that
 * fixes it, instead of the old single-message catch-all that misled
 * users into thinking their provider was wrong when actually the systemd
 * unit was stale.
 */
export function voiceUnavailableMessage(
  s: Extract<AudioSupport, { ok: false }>,
): string {
  if (s.reason === "provider_none") {
    return "voice transcription is disabled — run `phantombot voice` to set up OpenAI or ElevenLabs";
  }
  if (s.reason === "provider_no_stt") {
    return `current provider '${s.provider}' has no STT — switch via \`phantombot voice\``;
  }
  // key_missing
  return `voice key not loaded into the service environment — run \`phantombot install\` to upgrade the systemd unit, then try again. (provider '${s.provider}', expected env var ${s.envVar})`;
}
