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
  type AudioSupport,
  sttSupport,
  synthesize,
  transcribe,
  ttsSupported,
} from "../lib/audio.ts";
import { formatElapsedMs, truncateLine } from "../lib/format.ts";
import type { WriteSink } from "../lib/io.ts";
import { log } from "../lib/logger.ts";
import type { MemoryStore } from "../memory/store.ts";
import { runTurn } from "../orchestrator/turn.ts";
import {
  type ActiveTurnHandle,
  handleSlashCommand,
} from "./commands.ts";

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
  /** Send a text message; returns the new message_id (used for later edit/delete). */
  sendMessage(chatId: number, text: string): Promise<number>;
  sendTyping(chatId: number): Promise<void>;
  /** Send an OGG-Opus voice note. */
  sendVoice(chatId: number, audio: Buffer, mime: string): Promise<void>;
  /** Send the "recording voice" status indicator. */
  sendRecording(chatId: number): Promise<void>;
  /** Download a file by Telegram file_id; returns audio bytes + content-type. */
  downloadFile(fileId: string): Promise<{ data: Buffer; mime: string }>;
  /** Edit an existing text message in place. Best-effort; failures are swallowed. */
  editMessage(chatId: number, messageId: number, text: string): Promise<void>;
  /** Delete a message by id. Best-effort; failures are swallowed. */
  deleteMessage(chatId: number, messageId: number): Promise<void>;
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

  async sendMessage(chatId: number, text: string): Promise<number> {
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
      return 0;
    }
    // Telegram returns the sent message in `result.message_id`. Callers
    // that don't care can ignore it; the placeholder pipeline uses it
    // for later editMessage/deleteMessage.
    try {
      const body = (await res.json()) as {
        ok?: boolean;
        result?: { message_id?: number };
      };
      return body.ok && typeof body.result?.message_id === "number"
        ? body.result.message_id
        : 0;
    } catch {
      return 0;
    }
  }

  async editMessage(
    chatId: number,
    messageId: number,
    text: string,
  ): Promise<void> {
    if (messageId === 0) return;
    const url = `https://api.telegram.org/bot${this.token}/editMessageText`;
    const safe = text.length > 4000 ? text.slice(0, 4000) + "\n…[truncated]" : text;
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: safe,
      }),
    }).catch(() => {
      /* edits are best-effort — placeholder editMessage failing isn't fatal */
    });
  }

  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    if (messageId === 0) return;
    const url = `https://api.telegram.org/bot${this.token}/deleteMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    }).catch(() => {
      /* deletes are best-effort — leaving an orphan placeholder isn't fatal */
    });
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
  /**
   * How long a turn can run silently before we post a "⏳ working…"
   * placeholder message. Below this, short turns finish without any
   * extra noise in the chat. Default 30_000 ms. Tests use smaller.
   */
  placeholderThresholdMs?: number;
  /**
   * How often we edit the placeholder with new elapsed time + last
   * progress note while the turn is still running. Telegram allows
   * ~1 edit/sec; we default to a generous 60_000 ms because the
   * placeholder exists to reassure the user, not to render a real-time
   * console. Tests override.
   */
  placeholderEditMs?: number;
  out?: WriteSink;
  err?: WriteSink;
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
  const tg = input.config.channels.telegram!;
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

  if (allowedSet.size === 0) {
    log.warn(
      "telegram: no allowed_user_ids configured — anyone who DMs the bot is answered",
    );
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
        });

        // Slash commands: handled INLINE so they bypass the per-chat queue
        // and any in-flight turn. Voice messages are never slash commands
        // (the body is empty until STT runs, by which point we've already
        // committed to the LLM path).
        if (!isVoice && msg.text.startsWith("/")) {
          const result = await handleSlashCommand(msg.text, {
            chatId: msg.chatId,
            persona: input.persona,
            conversation: `telegram:${msg.chatId}`,
            memory: input.memory,
            harnesses,
            startedAt: serverStartedAt,
            activeTurn: activeTurns.get(msg.chatId),
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
            continue;
          }
          // Unrecognized /command — fall through to the LLM.
        }

        // Regular message: enqueue onto this chat's serial chain.
        const prev = chatChains.get(msg.chatId) ?? Promise.resolve();
        const next = prev.then(() =>
          processChatMessage(msg, {
            input,
            harnesses,
            activeTurns,
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
  },
): Promise<void> {
  const { input, harnesses, activeTurns } = ctx;
  const startedAt = Date.now();
  const isVoice = Boolean(msg.voice);

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
    try {
      const file = await input.transport.downloadFile(msg.voice.fileId);
      const r = await transcribe(input.config, file.data, file.mime);
      if (!r.ok) {
        log.error("telegram: STT failed", { error: r.error });
        await input.transport.sendMessage(
          msg.chatId,
          `(voice transcription failed: ${r.error})`,
        );
        return;
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
      return;
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

  // Register the AbortController so /stop can find us.
  const controller = new AbortController();
  const turnHandle: ActiveTurnHandle = {
    controller,
    startTime: startedAt,
  };
  activeTurns.set(msg.chatId, turnHandle);

  // Long-turn placeholder lifecycle. Three states:
  //   1. Silent  — turn is fast, no placeholder needed.
  //   2. Posted  — turn went past placeholderThresholdMs (default 30s);
  //                we sent a "⏳ working… 30s elapsed" message and have
  //                its message_id. Periodically edit it with elapsed
  //                time + last progress note.
  //   3. Cleanup — turn finished. Delete the placeholder, then send the
  //                final reply as a NEW message (Option B in the design
  //                discussion: a fresh message triggers a Telegram push
  //                notification; an edit does not).
  const placeholderThresholdMs = input.placeholderThresholdMs ?? 30_000;
  const placeholderEditMs = input.placeholderEditMs ?? 60_000;
  let placeholderMsgId: number | undefined;
  let placeholderEditTimer: ReturnType<typeof setInterval> | undefined;
  // `disposed` plus `placeholderPostPromise` together close the post-IIFE
  // race: if the turn finishes between when the post timer fires and when
  // sendMessage resolves, the IIFE bails before storing the messageId or
  // arming the edit interval (otherwise we'd leak a setInterval forever
  // and leave an orphan ⏳ message in the chat).
  let disposed = false;
  let placeholderPostPromise: Promise<void> | undefined;
  const renderPlaceholder = (): string => {
    const elapsedMs = Date.now() - startedAt;
    const note = turnHandle.lastProgressNote;
    return note
      ? `⏳ working… ${formatElapsedMs(elapsedMs)} — currently: ${truncateLine(note, 120)}`
      : `⏳ working… ${formatElapsedMs(elapsedMs)} elapsed`;
  };
  const placeholderPostTimer = setTimeout(() => {
    placeholderPostPromise = (async () => {
      let id = 0;
      try {
        id = await input.transport.sendMessage(
          msg.chatId,
          renderPlaceholder(),
        );
      } catch (e) {
        log.warn("telegram: placeholder post failed", {
          error: (e as Error).message,
          chatId: msg.chatId,
        });
        return;
      }
      // The turn may have finished while sendMessage was in flight. If so,
      // delete the message we just posted (the cleanup phase already ran
      // with placeholderMsgId still undefined, so it was skipped) and do
      // NOT arm the edit interval.
      if (disposed) {
        if (id > 0) {
          await input.transport.deleteMessage(msg.chatId, id).catch(() => {});
        }
        return;
      }
      if (id > 0) {
        placeholderMsgId = id;
        placeholderEditTimer = setInterval(() => {
          if (disposed || placeholderMsgId === undefined) return;
          void input.transport.editMessage(
            msg.chatId,
            placeholderMsgId,
            renderPlaceholder(),
          );
        }, placeholderEditMs);
      }
    })();
  }, placeholderThresholdMs);

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
      harnesses,
      memory: input.memory,
      idleTimeoutMs: input.config.harnessIdleTimeoutMs,
      hardTimeoutMs: input.config.harnessHardTimeoutMs,
      signal: controller.signal,
      // Voice-in + voice-out: append a brevity directive for this turn
      // only. Keeps voice notes short + spoken-friendly without putting
      // brevity rules in persona files (which would also throttle text
      // replies, where verbosity is fine).
      systemPromptSuffix: willReplyWithVoice
        ? VOICE_REPLY_INSTRUCTION
        : undefined,
    })) {
      if (chunk.type === "text") reply += chunk.text;
      if (chunk.type === "progress") {
        progressCount++;
        // Stash the latest progress note on the active-turn handle so
        // /status can show "currently: <tool>" in real time.
        turnHandle.lastProgressNote = chunk.note.slice(0, 500);
        log.debug("telegram: progress", {
          chatId: msg.chatId,
          note: chunk.note.slice(0, 200),
        });
      }
      if (chunk.type === "done") {
        reply = chunk.finalText;
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
    // Mark disposed BEFORE awaiting in-flight placeholder work so the
    // post IIFE (if still running) sees the flag and bails.
    disposed = true;
    clearInterval(typingTimer);
    clearTimeout(placeholderPostTimer);
    if (placeholderEditTimer) clearInterval(placeholderEditTimer);
    // Only deregister if we're still the active turn for this chat.
    // (Defensive: a /reset or /stop could have replaced us.)
    if (activeTurns.get(msg.chatId) === turnHandle) {
      activeTurns.delete(msg.chatId);
    }
  }

  // Always clean up the placeholder if one was posted, so the chat
  // doesn't end up with an orphan "⏳ working…" message regardless of
  // outcome (success / error / stop). Awaits any in-flight post first
  // so a placeholder that races with completion is still observed and
  // deleted.
  const cleanupPlaceholder = async (): Promise<void> => {
    if (placeholderPostPromise) {
      await placeholderPostPromise;
    }
    if (placeholderMsgId !== undefined) {
      await input.transport.deleteMessage(msg.chatId, placeholderMsgId);
      placeholderMsgId = undefined;
    }
  };

  // /stop: the controller was aborted from outside. The reply text
  // already came through from the slash command handler — don't send
  // a second "(error: stopped)" message. We DO still delete the
  // placeholder so the user isn't left with a stale "working…" line.
  const wasStopped = controller.signal.aborted;
  if (wasStopped) {
    await cleanupPlaceholder();
    log.info("telegram: turn stopped by /stop", {
      chatId: msg.chatId,
      durationMs: Date.now() - startedAt,
    });
    return;
  }

  const outText = errored
    ? `(error: ${errored})`
    : reply.length > 0
      ? reply
      : "(no reply)";

  // Voice in → voice out (when TTS is configured AND no error).
  // Text in → text out, always. Order: delete placeholder FIRST, then
  // send the real reply. Telegram pushes a notification on a new
  // message but not on an edit, so this delete-then-new sequence is
  // what guarantees the user's phone buzzes when a long turn finishes
  // ("Option B" from the design discussion).
  let sentAsVoice = false;
  try {
    await cleanupPlaceholder();
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

/**
 * System-prompt suffix appended for voice-in / voice-out turns only.
 *
 * Why this exists: a chat reply that's fine as a Telegram text message
 * — say 4-6 sentences, with some narration of what the agent did —
 * becomes a 90-second voice note when synthesized via TTS. Users
 * report it sounds like a YouTuber explaining their workflow.
 *
 * Target: ~100 tokens (~60 words / ~30 seconds of speech). Concrete
 * numbers in the instruction so the model has something to anchor on,
 * but the real win is killing narration ("Let me check…", "Right,
 * here's what I found…") and markdown formatting that TTS reads
 * awkwardly.
 *
 * Lives at the channel layer (not in persona files) so brevity is
 * triggered ONLY when the input arrived as voice AND the reply will be
 * synthesized — text replies stay as detailed as the persona wants.
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
