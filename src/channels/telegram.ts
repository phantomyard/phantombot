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
import type { WriteSink } from "../lib/io.ts";
import { log } from "../lib/logger.ts";
import type { MemoryStore } from "../memory/store.ts";
import { runTurn } from "../orchestrator/turn.ts";

export interface TelegramMessage {
  updateId: number;
  chatId: number;
  fromUserId: number;
  fromUsername?: string;
  text: string;
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
}

interface TelegramRawUpdate {
  update_id?: number;
  message?: {
    chat?: { id?: number };
    from?: { id?: number; username?: string };
    text?: string;
  };
}

/**
 * Pure parser exposed for testing. Consumes Telegram getUpdates result
 * objects and returns only the message-with-text updates we care about.
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
      typeof u.update_id === "number" &&
      msg &&
      typeof msg.chat?.id === "number" &&
      typeof msg.from?.id === "number" &&
      typeof msg.text === "string" &&
      msg.text.length > 0
    ) {
      updates.push({
        updateId: u.update_id,
        chatId: msg.chat.id,
        fromUserId: msg.from.id,
        fromUsername: msg.from.username,
        text: msg.text,
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
      log.info("telegram: incoming", {
        chatId: msg.chatId,
        fromUserId: msg.fromUserId,
        fromUsername: msg.fromUsername,
        textLength: msg.text.length,
        persona: input.persona,
      });

      // Send typing immediately, then refresh every typingRefreshMs while
      // the harness works. Telegram's typing indicator lasts ~5s; without
      // this the user sees "typing…" disappear and assumes the bot died.
      void input.transport.sendTyping(msg.chatId);
      const refreshMs = input.typingRefreshMs ?? 4000;
      const typingTimer = setInterval(() => {
        void input.transport.sendTyping(msg.chatId);
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
      try {
        await input.transport.sendMessage(msg.chatId, outText);
      } catch (e) {
        log.error("telegram: sendMessage failed", {
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
        ok: !errored,
      });
    }
  } while (!input.oneShot);
}
