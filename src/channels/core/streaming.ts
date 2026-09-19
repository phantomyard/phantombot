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
import {
  detectLanguage,
  expectedLanguageOf,
} from "../../lib/languageGate.ts";
import { log } from "../../lib/logger.ts";

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
  /**
   * The user's latest message — the single authority on what language this
   * turn's narration must be in (issue #580).
   *
   * When supplied, each buffered narration LINE is checked against it before
   * publishing and a line confidently in a different language is dropped
   * rather than sent. Narration is cosmetic, so silence beats the wrong
   * language, and dropping (rather than regenerating) keeps model compliance
   * out of the delivery path entirely — which is the whole point, since the
   * prose rule has now failed at this twice.
   *
   * The reply BODY is deliberately not gated: it legitimately quotes foreign
   * text, and it has never been observed to leak.
   *
   * Omit to disable the gate (the pre-#580 behaviour).
   */
  expectedLanguageSource?: string;
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

  // Detected once per turn, not once per flush: the user's message does not
  // change mid-turn, and `undefined` here (too short / unscoreable) must mean
  // "gate off for this turn" rather than "re-guess on the next bubble".
  const expected = opts.expectedLanguageSource
    ? expectedLanguageOf(opts.expectedLanguageSource)
    : undefined;

  /**
   * Drop the lines of `pending` that are confidently in another language.
   * Line-wise rather than whole-buffer because `flush` coalesces several
   * narration segments: one leaked line should not take the correct ones with
   * it, and one correct line should not shelter a leaked one.
   */
  const gate = (pending: string): string => {
    if (!expected) return pending;
    const kept: string[] = [];
    let dropped = 0;
    for (const line of pending.split("\n")) {
      const actual = line.trim() ? detectLanguage(line) : undefined;
      if (actual && actual.code !== expected.code) {
        dropped++;
        // Logged, not silent: the violation rate is the only way to tell
        // whether the prompt-side fixes in #581 are working.
        log.info("narration: dropped line in wrong language", {
          expected: expected.code,
          actual: actual.code,
          chars: line.length,
        });
        continue;
      }
      kept.push(line);
    }
    if (dropped === 0) return pending;
    return kept.join("\n").trim();
  };

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
      const pending = gate(buffer);
      buffer = "";
      lastFlushAt = now;
      // Everything in the buffer was withheld — there is nothing to publish,
      // and an empty bubble is worse than no bubble.
      if (pending.trim().length === 0) return;
      await opts.send(pending);
    },
  };
}
