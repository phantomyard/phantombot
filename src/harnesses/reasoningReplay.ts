/**
 * Narration-decay fix (issue #551): replay the model's own reasoning after a
 * quiet window.
 *
 * On long autonomous runs the prompt-only narration habit decays — a session
 * can emit one narration sentence and then go visually silent for minutes
 * while tool calls and thinking deltas keep flowing. The fix is capture, not
 * synthesis: every harness parser already RECEIVES human-readable reasoning
 * (claude thinking deltas, pi thinking_delta, codex reasoning summaries) and
 * throws it away. This module keeps a one-slot rolling buffer of that text,
 * and the shared engine (harnessRunner.ts) emits the newest un-emitted slice
 * as a `progress` row after a quiet window with no narration, text, or tool
 * event.
 *
 * HARD CONTRACTS (all from issue #551 + review refinements):
 *   - Model-emitted text only. Nothing here ever writes a string; the only
 *     content that can reach the user is text the model itself produced. This
 *     keeps the #548 English-only ruling intact: a replay in a Chinese turn
 *     arrives in Chinese for free.
 *   - Emission is bounded: a quiet window (no narration/text/progress) AND a
 *     minimum interval since the last emission must both elapse. Worst case
 *     is one progress row per minIntervalMs, never one per reasoning burst.
 *   - Only NEW reasoning replays: the buffer holds text not yet emitted; a
 *     tick with nothing new stays silent. Replaying a stale line is worse
 *     than silence.
 *   - Fallback chain (redacted_thinking / no readable reasoning): the last
 *     narration text, then the last tool note — but ONLY while the fallback
 *     content is fresh (fallbackFreshMs) and only if it differs from the
 *     last emitted string, so a claude-heavy session never re-replays a
 *     minutes-old narration line.
 *   - Privacy: reasoning rides the payload-less `progress` path, which every
 *     channel layer treats as ephemeral UI state (live indicator + /status),
 *     never persisted as reply text, narration bubble, memory, or journal.
 */

import type { HarnessChunk } from "./types.ts";

export interface ReasoningReplayConfig {
  /** Quiet window (no narration/text/progress) before a replay may fire. */
  quietWindowMs: number;
  /** Hard floor between two emissions, even if reasoning keeps flowing. */
  minIntervalMs: number;
  /** Fallback content older than this is never replayed (stay silent). */
  fallbackFreshMs: number;
  /** Cap on a single emitted reasoning tail (newest characters kept). */
  maxEmitChars: number;
}

export const DEFAULT_REASONING_REPLAY: ReasoningReplayConfig = {
  quietWindowMs: 10_000,
  minIntervalMs: 10_000,
  fallbackFreshMs: 60_000,
  maxEmitChars: 500,
};

/**
 * What a harness parser hands back when a stream event carries reasoning.
 * `reasoning` is always model-written text: a delta fragment (claude/pi) or
 * a complete summary (codex) — the engine appends it to the rolling buffer
 * either way. `chunk` is the payload-less signal the parser would have
 * returned anyway (a heartbeat); the engine processes it downstream exactly
 * as if the parser had returned it directly.
 */
export interface ReasoningCapture {
  reasoning: string;
  chunk?: HarnessChunk;
}

/**
 * Widened parseEvent result: a normal chunk, a reasoning capture, or
 * nothing. Exported for the engine spec and for tests.
 */
export type ParseEventResult = HarnessChunk | ReasoningCapture | undefined;

export function isReasoningCapture(
  r: ParseEventResult,
): r is ReasoningCapture {
  return (
    typeof r === "object" &&
    r !== null &&
    "reasoning" in r &&
    typeof (r as ReasoningCapture).reasoning === "string"
  );
}

/** Cap on the un-emitted rolling buffer — progress rows don't need history. */
const PENDING_CAP = 2_000;

/**
 * The replay state machine. One instance per harness subprocess, owned by
 * the shared engine. Injectable clock so tests don't wait real seconds.
 */
export class ReasoningReplay {
  private readonly cfg: ReasoningReplayConfig;
  private readonly now: () => number;

  /** Un-emitted model reasoning, newest text wins (rolling, capped). */
  private pending = "";
  /** Last user-visible narration text (text chunk) + when. */
  private lastNarration = "";
  private lastNarrationAt = 0;
  /** Last tool progress note + when (second fallback slot). */
  private lastToolNote = "";
  private lastToolNoteAt = 0;
  /** Emission bookkeeping. */
  private lastEmitAt = 0;
  private lastVisibleAt = 0;
  private lastEmitted = "";

  constructor(
    overrides?: Partial<ReasoningReplayConfig>,
    now: () => number = Date.now,
  ) {
    this.cfg = { ...DEFAULT_REASONING_REPLAY, ...overrides };
    this.now = now;
  }

  /**
   * Model reasoning arrived (fragment or complete summary). Appended to the
   * un-emitted buffer; capped so a chatty thinker can't grow it unbounded.
   * Exported for tests.
   */
  note(text: string): void {
    const t = text.trim();
    if (!t) return;
    // Join fragments with a single space unless they already run on (deltas
    // arrive mid-sentence; complete summaries are sentences). Never invent
    // punctuation — the separator is whitespace, not synthesized text.
    this.pending =
      this.pending.length === 0
        ? t
        : (this.pending + (/\s$/.test(this.pending) ? "" : " ") + t);
    if (this.pending.length > PENDING_CAP) {
      this.pending = this.pending.slice(-PENDING_CAP);
    }
  }

  /**
   * User-visible output happened — the channel is NOT quiet. `text` chunks
   * are narration (and the final reply); `progress` notes are tool-call
   * titles. Both reset the quiet window; both also feed the fallback slots.
   * Heartbeats deliberately do NOT reset it: they carry no user-facing text,
   * and a thinking-heavy turn must still trigger replays.
   */
  visible(kind: "text" | "progress", text?: string): void {
    const t = this.now();
    this.lastVisibleAt = t;
    if (kind === "text") {
      this.lastNarration = text ?? "";
      this.lastNarrationAt = t;
      return;
    }
    const note = text?.trim();
    if (note) {
      this.lastToolNote = note;
      this.lastToolNoteAt = t;
    }
  }

  /**
   * Milliseconds until the next due() could return content; undefined when
   * nothing can ever emit again without new input (no pending reasoning and
   * no fresh fallback). The engine races its stdout read against this
   * deadline instead of polling.
   */
  dueIn(): number | undefined {
    const t = this.now();
    // Content that could ever emit: un-emitted reasoning, or a fallback slot
    // that is fresh AND not already emitted (identical strings never repeat —
    // see due()). Without the lastEmitted guard a fresh-but-emitted fallback
    // would re-arm an already-elapsed deadline and busy-loop the tick race.
    const canReason = this.pending.trim().length > 0;
    const freshUnemittedFallback =
      (this.lastNarration.length > 0 &&
        this.lastNarration !== this.lastEmitted &&
        t - this.lastNarrationAt <= this.cfg.fallbackFreshMs) ||
      (this.lastToolNote.length > 0 &&
        this.lastToolNote !== this.lastEmitted &&
        t - this.lastToolNoteAt <= this.cfg.fallbackFreshMs);
    if (!canReason && !freshUnemittedFallback) return undefined;
    const deadline = Math.max(
      this.lastVisibleAt + this.cfg.quietWindowMs,
      this.lastEmitAt + this.cfg.minIntervalMs,
    );
    return deadline - t;
  }

  /**
   * The string to emit right now, if the quiet window and min interval have
   * both elapsed and there is something new to say. Mutates the emit
   * bookkeeping (this is the "once" in emit-once-per-window). Returns
   * undefined when the honest answer is silence.
   */
  due(): string | undefined {
    const t = this.now();
    if (t - this.lastVisibleAt < this.cfg.quietWindowMs) return undefined;
    if (t - this.lastEmitAt < this.cfg.minIntervalMs) return undefined;

    // 1. Newest un-emitted reasoning. Only the tail beyond the cap survives
    //    a chatty block — the newest reasoning is the useful part.
    const pending = this.pending.trim();
    if (pending) {
      this.pending = "";
      this.lastEmitAt = t;
      this.lastVisibleAt = t;
      this.lastEmitted = pending;
      return pending.length > this.cfg.maxEmitChars
        ? pending.slice(-this.cfg.maxEmitChars)
        : pending;
    }

    // 2. Fresh narration, then tool note — each replays AT MOST once (identical
    //    strings never repeat: lastEmitted guards), and only while fresh.
    if (
      this.lastNarration &&
      this.lastNarration !== this.lastEmitted &&
      t - this.lastNarrationAt <= this.cfg.fallbackFreshMs
    ) {
      this.lastEmitAt = t;
      this.lastVisibleAt = t;
      this.lastEmitted = this.lastNarration;
      return this.lastNarration;
    }
    if (
      this.lastToolNote &&
      this.lastToolNote !== this.lastEmitted &&
      t - this.lastToolNoteAt <= this.cfg.fallbackFreshMs
    ) {
      this.lastEmitAt = t;
      this.lastVisibleAt = t;
      this.lastEmitted = this.lastToolNote;
      return this.lastToolNote;
    }

    return undefined;
  }
}

/**
 * Build the progress chunk the engine yields for a due replay. Kept here so
 * the engine and tests share the exact shape. No `tool` payload — this is
 * narration-adjacent liveness, not a tool call, so ACP/panel consumers
 * render it as a plain progress row and resume evidence ignores it (the
 * resume log only counts `progress` chunks with a structured `tool`).
 */
export function replayChunk(text: string): HarnessChunk {
  return { type: "progress", note: text };
}