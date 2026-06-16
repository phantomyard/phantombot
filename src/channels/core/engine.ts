/**
 * Channel conversational engine.
 *
 * The streaming turn engine (`processChatMessage`) and the long-poll server
 * loop (`runTelegramServer`) — the heart of the chat channel. Moved here
 * VERBATIM from the former monolithic channels/telegram.ts (#162): same
 * logic, same order, same control flow. The only edits in the move were
 * import-path updates and the channel-agnostic retyping already established
 * in core/types.ts.
 *
 * This is the layer the channel abstraction is designed around: today it
 * drives a Telegram `TelegramTransport` directly via `transport.getUpdates`.
 * The future seam for new channels (Matrix, …) is `Channel.listen()` /
 * `Channel.encrypt|decrypt` in core/types.ts — adopting them here is a
 * later, separate step (see the seam docs in core/types.ts); doing so today
 * would risk a behaviour change in the offset-advance / long-poll logic.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  DEFAULT_TELEGRAM_STREAMING,
  type Config,
} from "../../config.ts";
import type { Harness } from "../../harnesses/types.ts";
import {
  sttSupport,
  synthesize,
  transcribe,
  ttsSupported,
} from "../../lib/audio.ts";
import {
  clearReplyModeOverride,
  DEFAULT_REPLY_MODE_OVERRIDE_TTL_MS,
  getReplyModeOverride,
  normalizeReplyModeRequest,
  setReplyModeOverride,
  touchReplyModeOverride,
  type ReplyMode,
  type ReplyModeRequest,
} from "../../lib/replyMode.ts";
import { DEFAULT_STT_TIMEOUT_MS } from "../../lib/voice.ts";
import type { WriteSink } from "../../lib/io.ts";
import { log } from "../../lib/logger.ts";
import type { ServiceControl } from "../../lib/systemd.ts";
import type { MemoryStore } from "../../memory/store.ts";
import { runTurn } from "../../orchestrator/turn.ts";
import { generateRecoveryReply } from "../../orchestrator/recovery.ts";
import { makeRetriever } from "../../orchestrator/retrieval.ts";
import { makeTurnIndexer } from "../../orchestrator/turnIndexer.ts";
import { makeScreener } from "../../orchestrator/screen.ts";
import {
  type ActiveTurnHandle,
  handleSlashCommand,
  slashCommandTarget,
  TELEGRAM_BOT_COMMANDS,
} from "../commands.ts";
import {
  splitIntoSegments,
  StreamSegmenter,
} from "../streamSegmenter.ts";
import {
  formatAttachmentUserText,
  formatReplyToContext,
  inboxDir,
  stripBotMention,
  TELEGRAM_BOT_DOWNLOAD_CAP_BYTES,
} from "../telegram/parse.ts";
import type { TelegramMessage } from "../telegram/parse.ts";
import type { TelegramTransport } from "../telegram/transport.ts";
import {
  decideGroupReply,
  formatGroupContext,
  GROUP_BUFFER_MAX,
  matchPersonaNames,
} from "./routing.ts";
import type { GroupChatState } from "./routing.ts";
import {
  captureNudgeForTurn,
  TELEGRAM_REPLY_INSTRUCTION,
  VOICE_REPLY_INSTRUCTION,
  voiceUnavailableMessage,
} from "./prompts.ts";

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
  account?: import("../../config.ts").TelegramAccount;
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
  // The configured allowlist is numeric (Telegram user ids in config.toml).
  // The core carries the sender id as a channel-neutral string, so we compare
  // against the numeric set via `Number(senderId)` — an exact round-trip for
  // every real Telegram id (it was `String(id)` at ingest).
  const allowedSet = new Set(tg.allowedUserIds);
  const checkAllowed = (senderId: string): boolean =>
    allowedSet.size === 0 || allowedSet.has(Number(senderId));

  // /harness reorders this in place — keep a local mutable copy so we
  // don't mutate the caller's array.
  const harnesses: Harness[] = [...input.harnesses];

  // Active turns per chat — keyed by the string conversation id. Read by
  // /stop and /status.
  const activeTurns = new Map<string, ActiveTurnHandle>();

  // Per-chat promise chain so messages within one chat stay ordered.
  // We chain `next = prev.then(work)` and store `next` here. When the
  // next message arrives, it chains off the latest entry.
  const chatChains = new Map<string, Promise<void>>();
  // Set of every in-flight worker promise — drained at shutdown / oneShot.
  const inFlight = new Set<Promise<void>>();

  // Per-chat group routing state (last-addressed bot + recent-message
  // buffer). Only touched for group/supergroup chats; DMs never key in.
  const groupChats = new Map<string, GroupChatState>();
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

        if (!checkAllowed(msg.senderId)) {
          log.info("telegram: rejecting unauthorized user", {
            fromUserId: msg.senderId,
            fromUsername: msg.fromUsername,
          });
          continue;
        }

        const isVoice = Boolean(msg.voice);
        log.info("telegram: incoming", {
          chatId: msg.conversationId,
          fromUserId: msg.senderId,
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
                  chatId: msg.conversationId,
                  persona: input.persona,
                  target,
                });
                continue;
              }
            } else {
              const sticky = (
                groupChats.get(msg.conversationId)?.lastAddressed ?? []
              ).some((n) => n.toLowerCase() === selfName.toLowerCase());
              if (!sticky) {
                log.info("telegram: untargeted group slash, not sticky — ignoring", {
                  chatId: msg.conversationId,
                  persona: input.persona,
                });
                continue;
              }
            }
          }
          const result = await handleSlashCommand(msg.text, {
            chatId: msg.conversationId,
            persona: input.persona,
            conversation: `telegram:${msg.conversationId}`,
            memory: input.memory,
            harnesses,
            startedAt: serverStartedAt,
            activeTurn: activeTurns.get(msg.conversationId),
            config: input.config,
            serviceControl: input.serviceControl,
            botUsername,
          });
          if (result) {
            try {
              await input.transport.sendMessage(msg.conversationId, result.reply);
            } catch (e) {
              log.error("telegram: slash reply send failed", {
                error: (e as Error).message,
                chatId: msg.conversationId,
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
                  chatId: msg.conversationId,
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
          const state = groupChats.get(msg.conversationId) ?? {
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
            : String(msg.senderId);

          if (!decision.reply) {
            if (bufText.length > 0) {
              state.buffer.push({
                from: fromLabel,
                text: bufText,
                delivered: false,
              });
            }
            while (state.buffer.length > GROUP_BUFFER_MAX) state.buffer.shift();
            groupChats.set(msg.conversationId, state);
            log.info("telegram: group message not for this bot — staying quiet", {
              chatId: msg.conversationId,
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
          groupChats.set(msg.conversationId, state);
        }

        // Regular message. If a turn is already in flight for this
        // chat, abort it — the user typing again means "pay attention
        // to this instead." The aborted turn returns silently via the
        // wasAborted path; only the new turn's reply lands. Same UX
        // as Claude Code's "type to interrupt." The new task still
        // chains off `prev` (the aborted turn's worker promise) so
        // the harness's process group has time to clean up before we
        // spawn the next subprocess.
        const active = activeTurns.get(msg.conversationId);
        if (active) {
          log.info("telegram: new message — interrupting active turn", {
            chatId: msg.conversationId,
            elapsedS: (
              (Date.now() - active.startTime) / 1000
            ).toFixed(1),
          });
          active.controller.abort("interrupt");
        }

        // Enqueue onto this chat's serial chain.
        // Convert prior rejection to resolution so a thrown
        // processChatMessage doesn't wedge the per-chat queue (GitHub #135).
        const prev = (chatChains.get(msg.conversationId) ?? Promise.resolve()).catch(
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
              allowedSet.size > 0 && allowedSet.has(Number(msg.senderId)),
          }),
        );
        // Detach completed entries so the maps don't leak.
        const tracked = next.finally(() => {
          if (chatChains.get(msg.conversationId) === tracked) {
            chatChains.delete(msg.conversationId);
          }
          inFlight.delete(tracked);
        });
        chatChains.set(msg.conversationId, tracked);
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
    activeTurns: Map<string, ActiveTurnHandle>;
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
        msg.conversationId,
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
          chatId: msg.conversationId,
        });
        try {
          await input.transport.sendMessage(
            msg.conversationId,
            "🎙️ I couldn’t make out that voice note — the audio may be unclear or too quiet. Please try again, or type your message.",
          );
        } catch (sendErr) {
          log.warn("telegram: STT failure notice send failed", {
            error: (sendErr as Error).message,
            chatId: msg.conversationId,
          });
        }
        return;
      }
      msg.text = r.text;
      log.info("telegram: STT ok", {
        chatId: msg.conversationId,
        persona: input.persona,
        transcriptChars: r.text.length,
      });
    } catch (e) {
      log.error("telegram: STT pipeline error", {
        error: (e as Error).message,
        persona: input.persona,
        chatId: msg.conversationId,
      });
      try {
        await input.transport.sendMessage(
          msg.conversationId,
          "⚠️ Something went wrong processing that voice note. Please try again in a moment, or type your message.",
        );
      } catch (sendErr) {
        log.warn("telegram: STT failure notice send failed", {
          error: (sendErr as Error).message,
          chatId: msg.conversationId,
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
        chatId: msg.conversationId,
        kind: att.kind,
        fileName: att.fileName,
        fileSize: att.fileSize,
      });
    } else {
      try {
        const dir = inboxDir(msg.conversationId);
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
          chatId: msg.conversationId,
          kind: att.kind,
          path,
          bytes: file.data.byteLength,
          mime: file.mime,
        });
      } catch (e) {
        downloadError = (e as Error).message;
        log.error("telegram: attachment download failed", {
          chatId: msg.conversationId,
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
  //   model override — the harness may call `phantombot reply-mode text|voice`
  //                   when the user asks to change wire format. That persists
  //                   for this persona+conversation while the chat remains
  //                   active, then expires after 10 minutes of idle time.
  //
  // We deliberately do NOT regex-scan the user's message for English phrases.
  // Natural-language interpretation belongs to the model; deterministic state
  // enforcement belongs here.
  const conversationKey = `telegram:${msg.conversationId}`;
  let modalityOverride = await touchReplyModeOverride({
    persona: input.persona,
    conversation: conversationKey,
    ttlMs: DEFAULT_REPLY_MODE_OVERRIDE_TTL_MS,
  });
  const resolveWillReplyWithVoice = (override: ReplyMode | undefined) => {
    const wantsVoiceReply =
      override === "voice" ? true : override === "text" ? false : isVoice;
    return wantsVoiceReply && ttsSupported(input.config);
  };
  let willReplyWithVoice = resolveWillReplyWithVoice(modalityOverride);

  // Forward `reply_to_message` context AFTER modality detection so quoted
  // context never affects the current turn's wire-format routing. We mutate
  // `msg.text` so both the harness call and the
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
      ? input.transport.sendRecording(msg.conversationId)
      : input.transport.sendTyping(msg.conversationId);
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
  activeTurns.set(msg.conversationId, turnHandle);

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
  let requestedReplyMode: ReplyModeRequest | undefined;
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
      await input.transport.sendMessage(msg.conversationId, text);
      if (kind === "narration") narrationBubblesSent++;
      if (kind === "final") finalBubblesSent++;
    } catch (e) {
      log.warn(`telegram: ${kind} send failed`, {
        error: (e as Error).message,
        chatId: msg.conversationId,
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
      // allow-listed principal is never screened. The judge runs as the
      // narrowed persona on the chain's primary harness; if the chain has
      // none, screening fails open. `input.memory` is passed so a HOLD can
      // write the held episode into the principal's telegram conversation
      // (the grounding write — see orchestrator/screen.ts recordHeld).
      screen: makeScreener(
        input.config,
        input.persona,
        conversationKey,
        harnesses,
        input.memory,
      ),
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
          chatId: msg.conversationId,
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
        requestedReplyMode = normalizeReplyModeRequest(chunk.meta?.replyMode);
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
    if (activeTurns.get(msg.conversationId) === turnHandle) {
      activeTurns.delete(msg.conversationId);
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
      chatId: msg.conversationId,
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
            conversation: `telegram:${msg.conversationId}`,
            role: "user",
            text: msg.text,
          },
          {
            persona: input.persona,
            conversation: `telegram:${msg.conversationId}`,
            role: "assistant",
            text: "[interrupted before reply]",
          },
        );
      } catch (e) {
        log.warn("telegram: failed to persist interrupted-pair", {
          chatId: msg.conversationId,
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
      chatId: msg.conversationId,
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

  if (requestedReplyMode === "default") {
    await clearReplyModeOverride({
      persona: input.persona,
      conversation: conversationKey,
    });
  } else if (requestedReplyMode) {
    await setReplyModeOverride({
      persona: input.persona,
      conversation: conversationKey,
      mode: requestedReplyMode,
    });
  }

  // Re-read reply-mode state after the harness finishes, so a model/tool call
  // to `phantombot reply-mode text|voice|disable` can affect this final reply
  // without every harness having to emit meta.replyMode. Do not switch into
  // voice after text/progress bubbles have already been sent; that would mix
  // wire formats for one answer and duplicate streamed content.
  modalityOverride = await getReplyModeOverride({
    persona: input.persona,
    conversation: conversationKey,
    ttlMs: DEFAULT_REPLY_MODE_OVERRIDE_TTL_MS,
  });
  willReplyWithVoice = resolveWillReplyWithVoice(modalityOverride);
  if (willReplyWithVoice && (narrationBubblesSent > 0 || finalBubblesSent > 0)) {
    willReplyWithVoice = false;
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
            msg.conversationId,
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
      chatId: msg.conversationId,
    });
  }

  log.info("telegram: complete", {
    chatId: msg.conversationId,
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

