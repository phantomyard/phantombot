/**
 * Shared streaming helpers for the chat channels.
 *
 * Both the Telegram engine (`src/channels/core/engine.ts`) and the PhantomChat
 * server (`src/channels/phantomchat/server.ts`) run the same progressive-bubble
 * state machine: a markdown-aware splitter turns streamed `text` chunks into
 * bubbles, tool boundaries reclassify the un-sent remainder as progress
 * narration, and a post-loop step reconciles the streamed prefix against the
 * harness's authoritative final answer.
 *
 * This module extracts the pieces of that machine that were byte-identical (or
 * trivially different) between the two loops so there is a single source of
 * truth. It intentionally does NOT try to unify the whole loop — the two
 * channels diverge in transport addressing (Telegram's opaque `conversationId`
 * vs PhantomChat's `senderHex`/`groupId` + group routing) and in Telegram's
 * extra failure-handling (recovery, abort persistence, `(no reply)`). That
 * larger unification is deliberately out of scope; see issue #245 (Tier B).
 */

import type { TelegramStreamingSettings } from "../../config.ts";
import type { StreamSegmenterOptions } from "../streamSegmenter.ts";

/**
 * Build the markdown-aware splitter options from the streaming config. Used for
 * both the live `StreamSegmenter` and the post-loop `splitIntoSegments` calls,
 * so the same bubble sizing applies to streamed and trailing text alike.
 */
export function segmenterOptionsFor(
  streaming: TelegramStreamingSettings,
): StreamSegmenterOptions {
  return {
    maxSentences: streaming.bubbleMaxSentences,
    maxChars: streaming.bubbleMaxChars,
  };
}

/**
 * Reconcile the authoritative full reply against what already streamed live.
 *
 *   - consumed prefix matches: return only the suffix the user hasn't seen yet
 *     (the part after live final bubbles and classified narration).
 *   - consumed prefix doesn't match (harness reformatted the answer, or a
 *     recovery reply unrelated to the streamed text): return the full reply. We
 *     accept some duplication over silently truncating.
 *
 * Callers handle the empty / unrecoverable / `(no reply)` cases around this;
 * this helper is only the "suffix vs full" decision, which was byte-identical
 * across the two channels.
 */
export function resolveOutgoingSuffix(
  fullReply: string,
  streamedReply: string,
  consumedReplyChars: number,
): string {
  if (
    consumedReplyChars > 0 &&
    fullReply.startsWith(streamedReply.slice(0, consumedReplyChars))
  ) {
    return fullReply.slice(consumedReplyChars);
  }
  return fullReply;
}

export interface NarrationControllerOptions {
  /** Streaming config; only `narrationFlushMs` (the flush cadence) is read. */
  streaming: TelegramStreamingSettings;
  /**
   * Whether interim narration bubbles are wanted for this conversation (the
   * `/chattiness` gate). When false, buffered narration is silently dropped —
   * the final reply path is unaffected.
   */
  enabled: boolean;
  /** Publish one coalesced narration bubble (channel-specific transport). */
  send: (text: string) => Promise<void>;
  /**
   * Optional extra suppression, evaluated live on each flush. Telegram uses
   * this for `willReplyWithVoice` (voice-out synthesizes once at the end, so
   * interim narration would just lengthen the spoken output). PhantomChat
   * passes nothing.
   */
  suppress?: () => boolean;
}

/**
 * Coalesce progress narration and flush it on a clock rather than on every tool
 * boundary. Tool boundaries `append()` the preceding un-sent text as narration;
 * `flush()` decides when — if ever — that buffered text becomes a bubble,
 * throttled to at most one bubble per `narrationFlushMs`.
 *
 * Owns its buffer + last-flush clock internally so both channels share one
 * implementation. The final-answer splitter state stays in the caller because
 * its per-segment send is interleaved with channel-specific transport calls.
 */
export interface NarrationController {
  /** Add classified narration text to the pending buffer. */
  append(text: string): void;
  /**
   * Emit the buffered narration as a single bubble if the throttle window has
   * elapsed (or `force` is set) and narration is enabled + not suppressed.
   */
  flush(force?: boolean): Promise<void>;
}

export function createNarrationController(
  opts: NarrationControllerOptions,
): NarrationController {
  let buffer = "";
  let lastFlushAt = Date.now();

  return {
    append(text: string): void {
      buffer += text;
    },
    async flush(force = false): Promise<void> {
      if (opts.suppress?.()) return;
      if (!opts.enabled) return;
      if (buffer.trim().length === 0) return;
      const now = Date.now();
      if (!force && now - lastFlushAt < opts.streaming.narrationFlushMs) {
        return;
      }
      const pending = buffer;
      buffer = "";
      lastFlushAt = now;
      await opts.send(pending);
    },
  };
}
