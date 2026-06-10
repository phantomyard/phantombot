/**
 * Telegram transport: the channel-agnostic `ChannelTransport` surface
 * specialized for Telegram (`TelegramTransport`), plus the real HTTP
 * implementation against api.telegram.org (`HttpTelegramTransport`).
 *
 * Moved out of the former monolithic `channels/telegram.ts` (#162). Re-exported
 * from there as a barrel so the public API is unchanged.
 */

import { log } from "../../lib/logger.ts";
import { timeoutSignal } from "../../lib/fetchTimeout.ts";
import { telegramGetMe } from "../../lib/telegramApi.ts";
import { markdownToTelegramHtml } from "../telegramFormat.ts";
import type { ChannelTransport } from "../core/types.ts";
import {
  parseGetUpdatesResult,
  type TelegramMessage,
  type TelegramRawUpdate,
} from "./parse.ts";

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
  // These keep the BASE `ChannelTransport` string-id signature verbatim (a
  // sound subtype — no narrowing of `string` to `number`). The numeric chat
  // id Telegram's HTTP API wants is recovered via `Number(conversationId)`
  // inside each method, at the wire boundary.
  sendMessage(conversationId: string, text: string): Promise<void>;
  sendTyping(conversationId: string): Promise<void>;
  /** Send an OGG-Opus voice note. */
  sendVoice(conversationId: string, audio: Buffer, mime: string): Promise<void>;
  /** Send the "recording voice" status indicator. */
  sendRecording(conversationId: string): Promise<void>;
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

  async sendMessage(conversationId: string, text: string): Promise<void> {
    // Boundary: the core hands us a channel-neutral string id; Telegram's
    // API wants the numeric chat id. `Number()` round-trips negative group
    // ids and large ids exactly (parseInt would truncate large ones).
    const chatId = Number(conversationId);
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

  async sendTyping(conversationId: string): Promise<void> {
    const chatId = Number(conversationId);
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

  async sendRecording(conversationId: string): Promise<void> {
    const chatId = Number(conversationId);
    const url = `https://api.telegram.org/bot${this.token}/sendChatAction`;
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "record_voice" }),
      signal: timeoutSignal(TELEGRAM_CONTROL_TIMEOUT_MS),
    }).catch(() => {});
  }

  async sendVoice(
    conversationId: string,
    audio: Buffer,
    mime: string,
  ): Promise<void> {
    const chatId = Number(conversationId);
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

export function guessMimeFromPath(path: string): string {
  if (path.endsWith(".oga") || path.endsWith(".ogg")) return "audio/ogg";
  if (path.endsWith(".mp3")) return "audio/mpeg";
  if (path.endsWith(".m4a")) return "audio/mp4";
  return "audio/ogg";
}
