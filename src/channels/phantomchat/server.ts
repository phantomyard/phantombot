/**
 * phantomchat server loop.
 *
 * The phantomchat analogue of `runTelegramServer`: consume the channel's
 * inbound stream (`channel.listen()`), apply the AUTH GATE, run the
 * channel-agnostic `runTurn`, and stream the reply back as a sequence of
 * NIP-17 bubbles. It runs ALONGSIDE the Telegram listeners (see cli/run.ts).
 *
 * Differences from Telegram, by design:
 *   - Same streaming model as Telegram: the reply is split into markdown-aware
 *     bubbles by the shared StreamSegmenter and progress narration
 *     ("checking your calendar…") is sent as its own bubbles before tool calls
 *     (toolNarration ON), so the user sees live progress instead of one long
 *     wait. Each bubble is its own NIP-17 wrap.
 *   - No slash commands, voice, or attachments (groups ARE supported).
 *   - The trust perimeter gates on the CRYPTOGRAPHIC sender (rumor.pubkey,
 *     surfaced as `senderId`), never on the envelope `from` field.
 */

import type { Config } from "../../config.ts";
import { DEFAULT_TELEGRAM_STREAMING } from "../../config.ts";
import type { Harness } from "../../harnesses/types.ts";
import type { WriteSink } from "../../lib/io.ts";
import { log } from "../../lib/logger.ts";
import type { MemoryStore } from "../../memory/store.ts";
import { runTurn } from "../../orchestrator/turn.ts";
import { makeRetriever } from "../../orchestrator/retrieval.ts";
import { makeScreener } from "../../orchestrator/screen.ts";
import { makeTurnIndexer } from "../../orchestrator/turnIndexer.ts";
import { TELEGRAM_REPLY_INSTRUCTION, voiceUnavailableMessage } from "../core/prompts.ts";
import type { Channel, ChannelMessage } from "../core/types.ts";
import {
  splitIntoSegments,
  StreamSegmenter,
} from "../streamSegmenter.ts";
import type { PhantomchatTransport } from "./transport.ts";
import { sttSupport, transcribe } from "../../lib/audio.ts";
import { DEFAULT_STT_TIMEOUT_MS } from "../../lib/voice.ts";
import { warmSymmetricKeyCache } from "../../lib/nostrCrypto.ts";
import { fetchAndDecryptBlossom } from "./blossomFetch.ts";
import { inboxDir } from "../telegram/parse.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Don't download absurdly large attachments. The harness reads from the inbox;
// a multi-hundred-MB blob would blow memory + disk for little benefit.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// Local sleep — spaces out consecutive bubbles so the PWA renders them as a
// readable sequence rather than a single burst (mirrors core/engine.ts).
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Map a mime type to a file extension for the inbox filename (the envelope
// carries no original name). Falls back to the mime subtype, then the kind.
function extForMime(mime: string, kind: string): string {
  const m = ((mime || "").split(";")[0] ?? "").trim().toLowerCase();
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "application/pdf": "pdf",
  };
  if (map[m]) return map[m];
  const sub = m.includes("/") ? m.slice(m.indexOf("/") + 1) : "";
  return /^[a-z0-9]{1,8}$/.test(sub) ? sub : kind === "image" ? "jpg" : kind === "video" ? "mp4" : "bin";
}

// Bound the voice fetch+decrypt+transcribe step. A hung Blossom fetch or STT
// request would otherwise never settle and wedge this peer's serial turn chain
// forever (the Telegram engine guards its STT the same way).
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
    ),
  ]);
}

export interface RunPhantomchatServerInput {
  config: Config;
  memory: MemoryStore;
  harnesses: Harness[];
  agentDir: string;
  persona: string;
  /**
   * The phantomchat channel to drive. Provided so tests can inject a channel
   * backed by an in-memory pool; production builds it from the resolved
   * identity + transport in cli/run.ts.
   */
  channel: Channel<PhantomchatTransport>;
  /**
   * Decoded allowlist: lowercase 64-char hex pubkeys permitted to talk to the
   * bot. Non-empty = only these are answered. Empty = see `tofu`.
   */
  allowedHex: string[];
  /**
   * Trust-on-first-use. Only consulted when `allowedHex` is empty:
   *   - tofu true  → the FIRST sender is trusted, persisted via `persistTrust`,
   *     and the bot locks to it (every later stranger is dropped).
   *   - tofu false → open bot: answer anyone (parallel to Telegram's empty
   *     `allowedUserIds`), with a loud startup warning emitted by the caller.
   */
  tofu?: boolean;
  /**
   * Persist a TOFU-trusted sender (called once, when tofu fires). The caller
   * encodes the hex→npub and writes it into phantomchat.json (clearing tofu).
   * Best-effort: a rejection is logged but the sender is still trusted for the
   * life of this process. Omitted in tests that don't exercise persistence.
   */
  persistTrust?: (senderHex: string) => Promise<void>;
  /**
   * Our secret key. Used to pre-derive symmetric keys for all allowed peers
   * at startup (cache warming), so inbound v2 DMs can be decrypted even
   * though the sender used ephemeral envelope signing.
   */
  secretKey: Uint8Array;
  /** Stop after draining the currently-available messages. For tests. */
  oneShot?: boolean;
  /** Signal to stop the loop cleanly (Ctrl-C / SIGTERM). */
  signal?: AbortSignal;
  out?: WriteSink;
  err?: WriteSink;
}

/**
 * Drive the phantomchat inbound loop until `signal` aborts (or, under
 * `oneShot`, until the stream yields no more immediately-available messages).
 *
 * Concurrency: like Telegram, turns are serialized PER conversation (per peer)
 * so one peer's history can't interleave, while different peers run in
 * parallel. Each turn registers under `activeTurns` so the abort signal can
 * tear it down.
 */
export async function runPhantomchatServer(
  input: RunPhantomchatServerInput,
): Promise<void> {
  const { channel } = input;
  const transport = channel.transport;

  // Decoded allowlist as a set for O(1) membership. Mutable: TOFU adds the
  // first sender at runtime, after which the set is non-empty and locked.
  const allowedSet = new Set(input.allowedHex.map((h) => h.toLowerCase()));
  // TOFU is armed only when we start with an empty allowlist and tofu is on.
  let tofuArmed = allowedSet.size === 0 && input.tofu === true;

  // ===================== CACHE WARMING =====================
  // Pre-derive symmetric keys for all allowed peers so inbound v2 DMs
  // (which use ephemeral envelope signing) can be decrypted immediately.
  // Fire-and-forget: keys derived after the first unwrap will be picked up
  // by subsequent unwraps.
  if (allowedSet.size > 0) {
    void warmSymmetricKeyCache(input.secretKey, [...allowedSet]).catch((e) => {
      log.warn("phantomchat: cache warming failed (non-fatal)", {
        error: (e as Error).message,
      });
    });
  }

  const harnesses: Harness[] = [...input.harnesses];

  // Per-peer promise chain so messages from one peer stay strictly ordered.
  const chains = new Map<string, Promise<void>>();
  const inFlight = new Set<Promise<void>>();

  const handle = async (msg: ChannelMessage): Promise<void> => {
    const senderHex = msg.senderId;

    // ===================== AUTH GATE =====================
    // Gate on the CRYPTOGRAPHIC sender (rumor.pubkey, carried as senderId — the
    // verifying unwrap proved it equals seal.pubkey and is signature-checked).
    // The envelope `from` field is NEVER consulted here: it's attacker-
    // controllable plaintext. A sender not in the allowlist is dropped SILENTLY
    // (info log only) — no reply, so the bot doesn't become an oracle that
    // confirms its own pubkey is live to strangers.
    const lowerHex = senderHex.toLowerCase();
    if (allowedSet.size > 0) {
      // Locked allowlist (configured, or already claimed by TOFU).
      if (!allowedSet.has(lowerHex)) {
        log.info("phantomchat: dropping message from non-allowed sender", {
          sender: senderHex.slice(0, 12) + "…",
        });
        return;
      }
    } else if (tofuArmed) {
      // TRUST-ON-FIRST-USE. Claim this sender SYNCHRONOUSLY (before any await)
      // so a near-simultaneous second stranger sees a now-non-empty set and is
      // dropped — JS single-threading makes this block atomic vs other peers.
      tofuArmed = false;
      allowedSet.add(lowerHex);
      // Warm the symmetric key cache for this newly-trusted peer so future
      // inbound v2 DMs can be decrypted without waiting for a send.
      void warmSymmetricKeyCache(input.secretKey, [lowerHex]).catch(() => {});
      log.info("phantomchat: TOFU — trusted first sender and locked", {
        sender: senderHex.slice(0, 12) + "…",
      });
      if (input.persistTrust) {
        // Best-effort durable write; trust already stands in-memory regardless.
        void input.persistTrust(senderHex).catch((e) => {
          log.warn("phantomchat: failed to persist TOFU-trusted npub", {
            error: (e as Error).message,
          });
        });
      }
    }
    // else: empty set + tofu off = open bot — answer anyone (caller warned).

    // ===================== DELIVERY RECEIPT =====================
    // The sender just passed the auth gate, so acknowledging receipt to them is
    // safe (we never receipt a dropped stranger — that path returned above). A
    // NIP-17 delivery receipt lights the remote's second tick AND, crucially,
    // tells its always-on retry layer the message landed so it stops re-sending
    // — closing the "first message ghosts, second works" loop. DM only: group
    // delivery is tracked per-member on the client via a separate mechanism.
    // Fire-and-forget BEFORE the (possibly slow) turn so the tick is prompt.
    if (!msg.groupId && msg.messageId) {
      void transport.sendDeliveryReceipt(senderHex, msg.messageId);
    }

    // Route a short user-facing notice to the SAME place a reply would go: into
    // the group when the message arrived via a group (reconstructing the member
    // set exactly like the reply path), else a 1:1 DM. Without this, a group
    // voice/media failure (STT unavailable/failed/errored) would surface
    // privately to the sender instead of in the group conversation.
    const sendNotice = (text: string): Promise<void> => {
      if (msg.groupId) {
        const others = new Set<string>(msg.groupMemberHexes ?? []);
        others.add(senderHex.toLowerCase());
        return transport.sendGroupMessage(msg.groupId, [...others], text);
      }
      return transport.sendMessage(senderHex, text);
    };

    // ===================== VOICE / MEDIA → TEXT =====================
    // A voice note arrives as an encrypted Blossom file (msg.media) with an
    // empty text body. Fetch + AES-256-GCM decrypt + transcribe so the turn
    // reasons over the words — mirroring the Telegram voice→STT path
    // (core/engine.processChatMessage). Done AFTER the auth gate so we never
    // spend a paid STT call (or de-stealth) on a dropped stranger. Other media
    // kinds carry no transcript yet, so the turn sees a short marker.
    let userMessage = msg.text;
    if (msg.media) {
      const m = msg.media;
      if (m.kind === "voice") {
        const stt = sttSupport(input.config);
        if (!stt.ok) {
          log.warn("phantomchat: voice note but STT unavailable", {
            persona: input.persona,
            reason: stt.reason,
          });
          await sendNotice(voiceUnavailableMessage(stt)).catch(() => {});
          return;
        }
        try {
          const r = await withTimeout(
            (async () => {
              const audio = await fetchAndDecryptBlossom(m.url, m.keyHex, m.ivHex, {
                expectedSha256Hex: m.sha256,
                signal: input.signal,
              });
              return transcribe(input.config, audio, m.mimeType);
            })(),
            input.config.voice.sttTimeoutMs ?? DEFAULT_STT_TIMEOUT_MS,
          );
          if (!r.ok) {
            log.error("phantomchat: STT failed", {
              persona: input.persona,
              error: r.error,
            });
            await sendNotice(
              "🎙️ I couldn’t make out that voice note — the audio may be unclear or too quiet. Please try again, or type your message.",
            ).catch(() => {});
            return;
          }
          userMessage = r.text;
          log.info("phantomchat: STT ok", {
            persona: input.persona,
            transcriptChars: r.text.length,
          });
        } catch (e) {
          log.error("phantomchat: voice pipeline error", {
            persona: input.persona,
            error: (e as Error).message,
          });
          await sendNotice(
            "⚠️ Something went wrong processing that voice note. Please try again in a moment, or type your message.",
          ).catch(() => {});
          return;
        }
      } else {
        // image / video / file: fetch + AES-GCM decrypt + save to the per-chat
        // inbox, then hand the harness "[attached: <abs-path>]" so it can read
        // the file — mirrors the Telegram attachment path
        // (core/engine.processChatMessage). The harness decides what to do.
        const caption = msg.text?.trim() ? msg.text + "\n\n" : "";
        if (m.size !== undefined && m.size > MAX_ATTACHMENT_BYTES) {
          log.warn("phantomchat: attachment over cap — not downloading", {
            persona: input.persona,
            kind: m.kind,
            size: m.size,
          });
          userMessage = `${caption}[sent a ${m.kind} (~${Math.round(m.size / 1024 / 1024)} MB) — too large to fetch]`;
        } else {
          const convId = `phantomchat-${msg.groupId ? `group-${msg.groupId}` : senderHex}`;
          try {
            const data = await withTimeout(
              fetchAndDecryptBlossom(m.url, m.keyHex, m.ivHex, {
                expectedSha256Hex: m.sha256,
                signal: input.signal,
              }),
              input.config.voice.sttTimeoutMs ?? DEFAULT_STT_TIMEOUT_MS,
            );
            const dir = inboxDir(convId);
            await mkdir(dir, { recursive: true });
            const path = join(dir, `${m.sha256.slice(0, 16)}.${extForMime(m.mimeType, m.kind)}`);
            await writeFile(path, data);
            log.info("phantomchat: attachment saved", {
              persona: input.persona,
              kind: m.kind,
              path,
              bytes: data.byteLength,
            });
            userMessage = `${caption}[attached: ${path}]`;
          } catch (e) {
            log.error("phantomchat: attachment download failed", {
              persona: input.persona,
              kind: m.kind,
              error: (e as Error).message,
            });
            userMessage = caption
              ? msg.text!
              : `[sent a ${m.kind}, but it couldn’t be downloaded]`;
          }
        }
      }
    }

    // A sender that PASSES the allowlist is a trusted principal — exactly the
    // same trust grant Telegram's allowlisted users get. This selects the
    // trusted SECURITY_PERIMETER prompt block and skips the threat screen.
    //
    // The conversation key threads the turn. A GROUP message is keyed by the
    // group (so HQ has its own memory/turn-ordering thread, distinct from the
    // sender's 1:1 DM with the bot); a plain DM keeps the per-peer key. The
    // channel already set msg.conversationId to `group:<id>` for group messages,
    // so we reuse it — falling back to the sender hex for DMs (whose
    // conversationId equals senderHex).
    const conversationKey = msg.groupId
      ? `phantomchat:group:${msg.groupId}`
      : `phantomchat:${senderHex}`;

    const streaming =
      input.config.telegramStreaming ?? DEFAULT_TELEGRAM_STREAMING;
    const segmenterOptions = {
      maxSentences: streaming.bubbleMaxSentences,
      maxChars: streaming.bubbleMaxChars,
    };
    // Streaming accumulators — mirror core/engine.ts so the PWA gets the same
    // progressive bubbles Telegram does. `streamedReply` is the running sum of
    // text chunks; `consumedReplyChars` is the prefix already delivered as a
    // final bubble OR classified as progress narration and dropped from the
    // answer; `narrationBuffer` holds classified narration awaiting the timed
    // flush; `finalSegmenter` is the markdown-aware live splitter.
    let streamedReply = "";
    let consumedReplyChars = 0;
    let narrationBuffer = "";
    let finalSegmenter = new StreamSegmenter(segmenterOptions);
    let finalCandidateText = "";
    let finalCandidateSentChars = 0;
    let finalReply: string | undefined;
    let lastNarrationFlushAt = Date.now();
    // Typing indicator. The PWA shows three-dots on each
    // ephemeral kind-20001 event and auto-expires it after ~6s, so we refresh
    // every 2s for the whole turn. A plain interval (rather than per-chunk)
    // keeps the dots alive through long tool-call gaps where runTurn emits no
    // chunks at all. Best-effort: sendTyping never throws (see transport).
    //
    // Both the first tick and the interval are scheduled on the macrotask queue
    // (setTimeout 0 / setInterval) rather than called inline: a typing tick
    // signs a Nostr event (Schnorr), and doing that synchronously here would
    // delay the start of the turn itself. The indicator must never be on the
    // turn's critical path.
    // For a group message the dots must land in the GROUP chat (so the PWA
    // shows "Lena is typing…" in HQ, not in her DM). Reconstruct the broadcast
    // set exactly like the reply path: inbound p-tags ∪ { sender }. For a DM the
    // tick p-tags the sender as before.
    const groupTypingMembers = msg.groupId
      ? (() => {
          const set = new Set<string>(msg.groupMemberHexes ?? []);
          set.add(senderHex.toLowerCase());
          return [...set];
        })()
      : null;
    const sendTypingTick = () =>
      msg.groupId
        ? void transport.sendGroupTyping(msg.groupId, groupTypingMembers!)
        : void transport.sendTyping(senderHex);
    const firstTypingTick = setTimeout(sendTypingTick, 0);

    // Publish one chat bubble — a progress/narration line or a slice of the
    // final answer — routed to the group broadcast or the 1:1 DM exactly like
    // the final reply path. groupTypingMembers is the same set the reply path
    // broadcasts to (inbound p-tags ∪ { sender }). Best-effort: a failed bubble
    // is logged, not thrown, so one dropped progress line never aborts the turn.
    const sendBubble = async (text: string): Promise<void> => {
      if (text.trim().length === 0) return;
      try {
        if (msg.groupId) {
          await transport.sendGroupMessage(
            msg.groupId,
            groupTypingMembers!,
            text,
          );
        } else {
          // transport.sendMessage NIP-17-wraps the plaintext to `senderHex`
          // and publishes both wraps. conversationId === recipient hex pubkey.
          await transport.sendMessage(senderHex, text);
        }
      } catch (e) {
        log.warn("phantomchat: bubble send failed", {
          error: (e as Error).message,
          sender: senderHex.slice(0, 12) + "…",
        });
      }
    };

    // Flush coalesced progress narration on a clock (like core/engine.ts), not
    // on every tool boundary — tool boundaries classify preceding text as
    // narration; this decides when that text becomes a bubble. Driven by both
    // the typing interval below and the chunk boundaries in the loop.
    const flushNarration = async (force = false): Promise<void> => {
      if (narrationBuffer.trim().length === 0) return;
      const now = Date.now();
      if (!force && now - lastNarrationFlushAt < streaming.narrationFlushMs) {
        return;
      }
      const pending = narrationBuffer;
      narrationBuffer = "";
      lastNarrationFlushAt = now;
      await sendBubble(pending);
    };

    const resetFinalCandidate = (): void => {
      finalSegmenter = new StreamSegmenter(segmenterOptions);
      finalCandidateText = "";
      finalCandidateSentChars = 0;
    };

    // Refresh the typing dots every 2s AND flush any pending narration, so a
    // long tool run (during which runTurn emits no chunks) still surfaces the
    // "working on…" line buffered before the tool started.
    const typingTimer = setInterval(() => {
      sendTypingTick();
      void flushNarration();
    }, 2000);
    try {
      for await (const chunk of runTurn({
        persona: input.persona,
        conversation: conversationKey,
        userMessage,
        agentDir: input.agentDir,
        harnesses,
        memory: input.memory,
        idleTimeoutMs: input.config.harnessIdleTimeoutMs,
        hardTimeoutMs: input.config.harnessHardTimeoutMs,
        signal: input.signal,
        // The trust grant — see the auth gate above. Always true here because
        // we already dropped non-allowlisted senders.
        trusted: true,
        // Trusted turns never screen, but pass the screener for parity/future
        // open-bot use (empty allowlist → trusted: true still, matching
        // Telegram's "answer anyone" semantics, so the screen is effectively
        // unused; kept for symmetry with the Telegram call site).
        screen: makeScreener(
          input.config,
          input.persona,
          conversationKey,
          harnesses,
          input.memory,
        ),
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
        // Reuse Telegram's short-reply / plan-then-confirm guidance — the user
        // is on a phone-style chat client here too. No voice overlay (Nostr
        // DMs are text only).
        systemPromptSuffix: TELEGRAM_REPLY_INSTRUCTION,
        // Pre-tool narration ON: the user now sees streamed bubbles, so a
        // "checking your calendar…" line before a tool call usefully fills the
        // silence — same as Telegram's text-out path.
        toolNarration: true,
      })) {
        if (chunk.type === "text") {
          streamedReply += chunk.text;
          finalCandidateText += chunk.text;
          // Markdown-aware splitter: emit only completed sentence/block
          // boundaries as bubbles; partial text stays buffered until it is.
          const { segments } = finalSegmenter.push(chunk.text);
          for (const segment of segments) {
            await sendBubble(segment);
            consumedReplyChars += segment.length;
            finalCandidateSentChars += segment.length;
            if (streaming.bubbleDelayMs > 0) {
              await sleep(streaming.bubbleDelayMs);
            }
          }
        }
        if (chunk.type === "heartbeat") {
          // Tool completed or model is thinking — a chance to surface narration.
          await flushNarration();
        }
        if (chunk.type === "progress") {
          // A tool is about to run. Text emitted since the last boundary that
          // the splitter hasn't already sent as a final bubble is progress
          // narration ("checking your calendar…"): buffer it for the timed
          // flush, then consume it so it is not duplicated in the final answer.
          const unsent = finalCandidateText.slice(finalCandidateSentChars);
          if (unsent.trim().length > 0) narrationBuffer += unsent;
          consumedReplyChars = streamedReply.length;
          resetFinalCandidate();
          await flushNarration();
        }
        if (chunk.type === "done") finalReply = chunk.finalText;
      }
    } catch (e) {
      log.warn("phantomchat: turn failed", {
        error: (e as Error).message,
        sender: senderHex.slice(0, 12) + "…",
      });
      return;
    } finally {
      // Stop the typing refresh whether the turn succeeded, errored, or the
      // early-return above fired, then publish an explicit STOP so the PWA
      // clears the dots AT ONCE instead of waiting out its 6s auto-expiry (the
      // "typing lingers after the answer" fix). Best-effort: never throws.
      clearTimeout(firstTypingTick);
      clearInterval(typingTimer);
      if (msg.groupId) {
        void transport.sendGroupTyping(msg.groupId, groupTypingMembers!, true);
      } else {
        void transport.sendTyping(senderHex, true);
      }
    }

    // After live streaming, send only what the user hasn't seen yet. If the
    // consumed prefix matches the authoritative reply, send just the suffix; if
    // the harness reformatted (prefix mismatch), send the whole thing, accepting
    // some duplication over truncating. Mirrors core/engine.ts. Empty outText is
    // intentional silence — progress/final bubbles already delivered everything,
    // or the reply was genuinely empty (original behaviour: stay silent).
    //
    // sendBubble routes group-broadcast vs 1:1 DM exactly like the old single-
    // shot path did: a group reply is reconstructed from the inbound rumor
    // (inbound p-tags ∪ { sender }) since the bridge holds no group DB, and
    // sendGroupMessage adds our self-wrap and defensively drops our own hex.
    const fullReply = finalReply ?? streamedReply;
    let outText: string;
    if (fullReply.trim().length === 0) {
      outText = "";
    } else if (
      consumedReplyChars > 0 &&
      fullReply.startsWith(streamedReply.slice(0, consumedReplyChars))
    ) {
      outText = fullReply.slice(consumedReplyChars);
    } else {
      outText = fullReply;
    }
    if (outText.trim().length === 0) return;

    const finalSegments = splitIntoSegments(outText, segmenterOptions);
    for (let i = 0; i < finalSegments.length; i++) {
      await sendBubble(finalSegments[i]!);
      if (i < finalSegments.length - 1 && streaming.bubbleDelayMs > 0) {
        await sleep(streaming.bubbleDelayMs);
      }
    }
  };

  // Serialize per peer: chain the new work onto that peer's last promise.
  const enqueue = (msg: ChannelMessage): void => {
    const key = msg.senderId;
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev
      .catch(() => {
        // A failed prior turn must not poison the chain — swallow so the next
        // message for this peer still runs.
      })
      .then(() => handle(msg));
    chains.set(key, next);
    inFlight.add(next);
    void next.finally(() => {
      inFlight.delete(next);
      // Drop the chain entry once it's the tail and settled, so the map doesn't
      // grow without bound across many peers.
      if (chains.get(key) === next) chains.delete(key);
    });
  };

  if (!channel.listen) {
    throw new Error("phantomchat channel does not implement listen()");
  }

  // Drive the inbound stream. In production listen() runs until the signal
  // aborts. Under oneShot, tests feed a fixed set of gift-wraps and then abort
  // the signal; listen()'s loop drains its queue and completes, so this
  // for-await ends naturally and we fall through to draining inFlight.
  for await (const msg of channel.listen(input.signal)) {
    enqueue(msg);
  }

  // Drain in-flight turns so callers (and tests) can assert on what was sent
  // without racing the workers.
  await Promise.allSettled([...inFlight]);
}
