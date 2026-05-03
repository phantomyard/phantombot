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
  const willReplyWithVoice = isVoice && ttsSupported(input.config);
  const sendStatus = () =>
    willReplyWithVoice
      ? input.transport.sendRecording(msg.chatId)
      : input.transport.sendTyping(msg.chatId);

  // Indicator policy: refresh on EVERY harness chunk (text, heartbeat,
  // progress). When chunks stop, the indicator naturally expires after
  // ~5s — that vanishing IS the user-visible "harness has gone silent /
  // possibly frozen" signal. No background timer, no fake pulse: the
  // indicator's presence is a true reflection of the harness's current
  // activity. The throttle just prevents stream-json bursts from
  // hitting Telegram's per-bot rate cap.
  const throttleMs = input.typingThrottleMs ?? 2000;
  let lastSendStatusAt = 0;
  const refreshIndicator = () => {
    const now = Date.now();
    if (now - lastSendStatusAt < throttleMs) return;
    lastSendStatusAt = now;
    void sendStatus();
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
      systemPromptSuffix: willReplyWithVoice
        ? `${TELEGRAM_REPLY_INSTRUCTION}\n\n${VOICE_REPLY_INSTRUCTION}`
        : TELEGRAM_REPLY_INSTRUCTION,
    })) {
      if (chunk.type === "text") {
        reply += chunk.text;
        refreshIndicator();
      }
      if (chunk.type === "heartbeat") {
        // Model is alive (chain-of-thought / tool start / etc.) — keep
        // the indicator visible without surfacing the content.
        refreshIndicator();
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
        refreshIndicator();
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
    // Only deregister if we're still the active turn for this chat.
    // (Defensive: a /reset or /stop could have replaced us.)
    if (activeTurns.get(msg.chatId) === turnHandle) {
      activeTurns.delete(msg.chatId);
    }
  }

  // /stop: the controller was aborted from outside. The reply text
  // already came through from the slash command handler — don't send
  // a second "(error: stopped)" message.
  const wasStopped = controller.signal.aborted;
  if (wasStopped) {
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
  // Text in → text out, always. The reply lands as a fresh message,
  // so Telegram pushes a notification — important when the user kicked
  // off a long job and walked away from the chat.
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
