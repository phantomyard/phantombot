/**
 * Telegram channel adapter.
 *
 * Long-polls Telegram's getUpdates, dispatches each text message through
 * runTurn, and sends the assistant reply back via sendMessage. Per-chat
 * memory uses conversation key `telegram:<chatId>` so DMs and groups are
 * isolated from the CLI's `cli:default` history.
 *
 * Streaming: we send `sendChatAction(typing)` at the start of each turn so
 * the user sees "Phantom is typing…" while the harness runs, then post the
 * final reply as one message. Live token-by-token edits would be nicer but
 * Telegram rate-limits edits at ~1/sec — not worth the complexity for v1.
 *
 * Auth gating: if `allowedUserIds` is empty, anyone who DMs the bot is
 * answered. We log a warning at startup so this isn't accidental.
 */

import type { Config } from "../config.ts";
import type { Harness } from "../harnesses/types.ts";
import {
  synthesize,
  sttSupported,
  transcribe,
  ttsSupported,
} from "../lib/audio.ts";
import type { WriteSink } from "../lib/io.ts";
import { log } from "../lib/logger.ts";
import type { MemoryStore } from "../memory/store.ts";
import { runTurn } from "../orchestrator/turn.ts";

export interface TelegramMessage {
  updateId: number;
  chatId: number;
  fromUserId: number;
  fromUsername?: string;
  /** For text messages — the text. For voice messages — empty string until STT runs. */
  text: string;
  /** Set when the incoming message was a voice note. */
  voice?: {
    fileId: string;
    mimeType: string;
    durationS: number;
  };
}

export interface TelegramTransport {
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
  sendMessage(chatId: number, text: string): Promise<void>;
  sendTyping(chatId: number): Promise<void>;
  /** Send an OGG-Opus voice note. */
  sendVoice(chatId: number, audio: Buffer, mime: string): Promise<void>;
  /** Send the "recording voice" status indicator. */
  sendRecording(chatId: number): Promise<void>;
  /** Download a file by Telegram file_id; returns audio bytes + content-type. */
  downloadFile(fileId: string): Promise<{ data: Buffer; mime: string }>;
}

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
      res = await fetch(url, { signal });
    } catch (e) {
      // AbortError is the expected path on Ctrl-C; just return empty so the
      // caller's next signal check exits the loop.
      if ((e as Error).name === "AbortError") {
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

  async sendMessage(chatId: number, text: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    // Telegram caps message length at 4096 chars. Truncate gracefully.
    const safe = text.length > 4000 ? text.slice(0, 4000) + "\n…[truncated]" : text;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: safe }),
    });
    if (!res.ok) {
      log.warn("telegram: sendMessage non-OK", {
        chatId,
        status: res.status,
      });
    }
  }

  async sendTyping(chatId: number): Promise<void> {
    const url = `https://api.telegram.org/bot${this.token}/sendChatAction`;
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
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
      { method: "POST", body: form },
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
    );
    const metaBody = (await meta.json()) as {
      ok?: boolean;
      result?: { file_path?: string };
    };
    if (!metaBody.ok || !metaBody.result?.file_path) {
      throw new Error(`getFile failed for ${fileId}`);
    }
    const file = await fetch(
      `https://api.telegram.org/file/bot${this.token}/${metaBody.result.file_path}`,
    );
    const data = Buffer.from(await file.arrayBuffer());
    const mime =
      file.headers.get("content-type") ?? guessMimeFromPath(metaBody.result.file_path);
    return { data, mime };
  }
}

function guessMimeFromPath(path: string): string {
  if (path.endsWith(".oga") || path.endsWith(".ogg")) return "audio/ogg";
  if (path.endsWith(".mp3")) return "audio/mpeg";
  if (path.endsWith(".m4a")) return "audio/mp4";
  return "audio/ogg";
}

interface TelegramRawUpdate {
  update_id?: number;
  message?: {
    chat?: { id?: number };
    from?: { id?: number; username?: string };
    text?: string;
    voice?: {
      duration?: number;
      mime_type?: string;
      file_id?: string;
    };
  };
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

    if (typeof msg.text === "string" && msg.text.length > 0) {
      updates.push({
        updateId: u.update_id,
        chatId: msg.chat.id,
        fromUserId: msg.from.id,
        fromUsername: msg.from.username,
        text: msg.text,
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
  /** Stop after one polling cycle. For tests. */
  oneShot?: boolean;
  /** Signal to stop the loop cleanly. */
  signal?: AbortSignal;
  /**
   * How often to refresh the "typing…" indicator while a turn is in
   * flight. Telegram's chat-action lasts only ~5s, so without refresh
   * the indicator disappears after ~5s and the user thinks the bot
   * stopped responding. Default 4000 ms. Tests use a smaller value.
   */
  typingRefreshMs?: number;
  out?: WriteSink;
  err?: WriteSink;
}

/**
 * The long-poll loop. Returns when signal is aborted, or after one
 * iteration if oneShot is set. Otherwise runs forever.
 */
export async function runTelegramServer(
  input: RunTelegramServerInput,
): Promise<void> {
  const tg = input.config.channels.telegram!;
  const allowedSet = new Set(tg.allowedUserIds);
  const checkAllowed = (userId: number): boolean =>
    allowedSet.size === 0 || allowedSet.has(userId);

  if (allowedSet.size === 0) {
    log.warn(
      "telegram: no allowed_user_ids configured — anyone who DMs the bot is answered",
    );
  }

  let offset = 0;

  do {
    if (input.signal?.aborted) return;

    const { updates, nextOffset } = await input.transport.getUpdates(
      offset,
      tg.pollTimeoutS,
      input.signal,
    );
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

      const startedAt = Date.now();
      const isVoice = Boolean(msg.voice);
      log.info("telegram: incoming", {
        chatId: msg.chatId,
        fromUserId: msg.fromUserId,
        fromUsername: msg.fromUsername,
        textLength: msg.text.length,
        persona: input.persona,
        voice: isVoice,
        voiceDurationS: msg.voice?.durationS,
      });

      // For voice messages: download → transcribe → use the transcript
      // as the user message before invoking the harness.
      if (isVoice && msg.voice) {
        if (!sttSupported(input.config)) {
          await input.transport.sendMessage(
            msg.chatId,
            `(voice messages need OpenAI or ElevenLabs configured — current provider is '${input.config.voice.provider}')`,
          );
          continue;
        }
        try {
          const file = await input.transport.downloadFile(msg.voice.fileId);
          const r = await transcribe(input.config, file.data, file.mime);
          if (!r.ok) {
            log.error("telegram: STT failed", { error: r.error });
            await input.transport.sendMessage(
              msg.chatId,
              `(voice transcription failed: ${r.error})`,
            );
            continue;
          }
          msg.text = r.text;
          log.info("telegram: STT ok", {
            chatId: msg.chatId,
            transcriptChars: r.text.length,
          });
        } catch (e) {
          log.error("telegram: voice download failed", {
            error: (e as Error).message,
          });
          await input.transport.sendMessage(
            msg.chatId,
            `(couldn't download your voice message: ${(e as Error).message})`,
          );
          continue;
        }
      }

      // Send the right indicator depending on which way we'll reply.
      // Refresh both kinds every typingRefreshMs while the harness works.
      const willReplyWithVoice = isVoice && ttsSupported(input.config);
      const sendStatus = () =>
        willReplyWithVoice
          ? input.transport.sendRecording(msg.chatId)
          : input.transport.sendTyping(msg.chatId);
      void sendStatus();
      const refreshMs = input.typingRefreshMs ?? 4000;
      const typingTimer = setInterval(() => {
        void sendStatus();
      }, refreshMs);

      let reply = "";
      let errored: string | undefined;
      let progressCount = 0;
      let chosenHarness: string | undefined;
      try {
        for await (const chunk of runTurn({
          persona: input.persona,
          conversation: `telegram:${msg.chatId}`,
          userMessage: msg.text,
          agentDir: input.agentDir,
          harnesses: input.harnesses,
          memory: input.memory,
          timeoutMs: input.config.turnTimeoutMs,
        })) {
          if (chunk.type === "text") reply += chunk.text;
          if (chunk.type === "progress") {
            progressCount++;
            log.debug("telegram: progress", {
              chatId: msg.chatId,
              note: chunk.note.slice(0, 200),
            });
          }
          if (chunk.type === "done") {
            reply = chunk.finalText;
            const meta = chunk.meta as
              | { harnessId?: unknown }
              | undefined;
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
        clearInterval(typingTimer);
      }

      const outText = errored
        ? `(error: ${errored})`
        : reply.length > 0
          ? reply
          : "(no reply)";

      // Voice in → voice out (when TTS is configured AND no error).
      // Text in → text out, always.
      let sentAsVoice = false;
      try {
        if (willReplyWithVoice && !errored && reply.length > 0) {
          const r = await synthesize(input.config, reply);
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
            await input.transport.sendMessage(msg.chatId, outText);
          }
        } else {
          await input.transport.sendMessage(msg.chatId, outText);
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
        progressEvents: progressCount,
        harness: chosenHarness ?? (errored ? "(error)" : "(unknown)"),
        modality: sentAsVoice ? "voice" : "text",
        inputModality: isVoice ? "voice" : "text",
        ok: !errored,
      });
    }
  } while (!input.oneShot);
}
