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
 *   - Fallback chain (redacted_thinking ONLY): the narration text
 *     accumulated since the last boundary, then the last tool note. The
 *     fallback is ARMED only when the parser actually SAW a redacted_thinking
 *     block — a session that emits no reasoning at all stays silent, because
 *     echoing narration the user just watched stream past, or re-emitting a
 *     tool note whose row is already on screen, is "stale progress is worse
 *     than silence" (issue thread). While armed, the same freshness
 *     (fallbackFreshMs) and emit-once (never-repeat set) guards apply.
 *   - Privacy: reasoning rides the dedicated payload-less `replay` chunk kind
 *     (see types.ts), which consumers render on their live surface only and
 *     never persist — no reply bubble, narration bubble, memory, journal, or
 *     log line carries the text. See replayChunk().
 *   - Privacy: reasoning rides the payload-less `progress` path, which every
 *     channel layer treats as ephemeral UI state (live indicator + /status),
 *     never persisted as reply text, narration bubble, memory, or journal.
 *     The chunk carries `ephemeral: true` so every logging/persistence path
 *     can (and must) redact it — see replayChunk().
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
  /** Readable model reasoning (a delta fragment or a complete summary). */
  reasoning?: string;
  /**
   * The stream carried a `redacted_thinking` block (claude): reasoning EXISTS
   * but is encrypted, so the only replayable content is the fallback chain.
   * Arm the fallback — sessions without this marker never fall back.
   */
  redacted?: true;
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
  if (typeof r !== "object" || r === null) return false;
  const c = r as ReasoningCapture;
  return typeof c.reasoning === "string" || c.redacted === true;
}

/**
 * Cap on the text accumulated since the last boundary for the narration
 * fallback slot — the same order of magnitude as PENDING_CAP.
 */
const NARRATION_CAP = 2_000;

/**
 * Codepoint-safe tail slice. `slice(-n)` cuts UTF-16 code units and can split
 * a surrogate pair (emoji) at the seam; this keeps whole codepoints.
 */
export function codepointTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return Array.from(text).slice(-maxChars).join("");
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
  /**
   * User-visible text accumulated since the last boundary (progress). The
   * narration fallback replays this — not the last fragment: pi streams text
   * as deltas, so a single-chunk slot would replay a word fragment.
   */
  private narrationAccum = "";
  /** When the last user-visible text chunk arrived (freshness). */
  private lastNarrationAt = 0;
  /**
   * Set when the parser actually SAW a redacted_thinking block. Only then may
   * the narration/tool-note fallback fire — a session whose model never emits
   * readable reasoning must stay silent rather than echo already-seen text.
   */
  private fallbackArmed = false;
  /** Last tool progress note + when (second fallback slot). */
  private lastToolNote = "";
  private lastToolNoteAt = 0;
  /** Emission bookkeeping. */
  private lastEmitAt = 0;
  private lastVisibleAt = 0;
  /**
   * Every string emitted this turn. A string replays AT MOST ONCE per turn —
   * no back-to-back-only dedupe (that would let narration and tool note
   * ping-pong the same two strings every quiet window). Bounded: a very long
   * turn forgets its oldest emissions, which freshness would have blocked
   * anyway (fallbackFreshMs).
   */
  private emittedSeen = new Set<string>();

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
   *
   * Capture-not-synthesis: fragments are appended BYTE-FOR-BYTE — a
   * fragment ending mid-word (`investig`) flows into the next (`ating`)
   * without invented separators, and surrounding whitespace survives
   * untouched. `trim()` is used only to detect empty fragments. Discrete
   * summary items (codex) run together at the seam if the model didn't
   * emit boundary whitespace — an acceptable cosmetic cost next to ever
   * corrupting streamed text.
   */
  note(text: string): void {
    if (!text.trim()) return;
    this.pending += text;
    if (this.pending.length > PENDING_CAP) {
      this.pending = this.pending.slice(-PENDING_CAP);
    }
  }

  /**
   * The parser saw a redacted_thinking block — arm the fallback chain for
   * the rest of the turn. Exported for tests.
   */
  armFallback(): void {
    this.fallbackArmed = true;
  }

  /**
   * User-visible output happened — the channel is NOT quiet. `text` chunks
   * are narration (and the final reply); `progress` notes are tool-call
   * titles. Both reset the quiet window. A `progress` note is also a
   * BOUNDARY: text accumulated before it is narration the tool run replaced,
   * so the narration slot drops it. Heartbeats deliberately do NOT reset the
   * window: they carry no user-facing text, and a thinking-heavy turn must
   * still trigger replays.
   */
  visible(kind: "text" | "progress", text?: string): void {
    const t = this.now();
    this.lastVisibleAt = t;
    if (kind === "text") {
      if (!text) return;
      this.narrationAccum = (this.narrationAccum + text).slice(-NARRATION_CAP);
      this.lastNarrationAt = t;
      return;
    }
    const note = text?.trim();
    if (note) {
      this.lastToolNote = note;
      this.lastToolNoteAt = t;
      this.narrationAccum = "";
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
    // see due()). Without the never-repeat guard a fresh-but-emitted fallback
    // would re-arm an already-elapsed deadline and busy-loop the tick race.
    const canReason = this.pending.trim().length > 0;
    const freshUnemittedFallback =
      this.fallbackArmed &&
      ((this.fallbackNarration().length > 0 &&
        !this.emittedSeen.has(this.fallbackNarration()) &&
        t - this.lastNarrationAt <= this.cfg.fallbackFreshMs) ||
        (this.lastToolNote.length > 0 &&
          !this.emittedSeen.has(this.lastToolNote) &&
          t - this.lastToolNoteAt <= this.cfg.fallbackFreshMs));
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
      this.rememberEmitted(pending);
      return codepointTail(pending, this.cfg.maxEmitChars);
    }

    // 2. ARMED-ONLY fallback: without a redacted_thinking sighting the honest
    //    answer is silence — replaying narration the user already watched or a
    //    tool note whose row is on screen is stale progress.
    if (!this.fallbackArmed) return undefined;
    // Fresh narration accumulated since the last boundary, then the tool
    // note — each replays AT MOST once (identical strings never repeat:
    // never-repeat set), and only while fresh.
    const narration = this.fallbackNarration();
    if (
      narration &&
      !this.emittedSeen.has(narration) &&
      t - this.lastNarrationAt <= this.cfg.fallbackFreshMs
    ) {
      this.lastEmitAt = t;
      this.lastVisibleAt = t;
      this.rememberEmitted(narration);
      // The emit consumed the accumulated text: without this, the next
      // emission would replay the old text again inside the new accumulated
      // string (an echo of text the user already watched).
      this.narrationAccum = "";
      return narration;
    }
    if (
      this.lastToolNote &&
      !this.emittedSeen.has(this.lastToolNote) &&
      t - this.lastToolNoteAt <= this.cfg.fallbackFreshMs
    ) {
      this.lastEmitAt = t;
      this.lastVisibleAt = t;
      this.rememberEmitted(this.lastToolNote);
      return this.lastToolNote;
    }

    return undefined;
  }

  /** Record an emitted string, bounded. */
  private rememberEmitted(text: string): void {
    this.emittedSeen.add(text);
    if (this.emittedSeen.size > 50) {
      // Drop the OLDEST entries — Sets iterate in insertion order.
      const drop = [...this.emittedSeen].slice(0, this.emittedSeen.size - 50);
      for (const d of drop) this.emittedSeen.delete(d);
    }
  }

  /**
   * The narration fallback slot: the tail of the text accumulated since the
   * last boundary, codepoint-safe. Empty when nothing accumulated.
   */
  private fallbackNarration(): string {
    return codepointTail(this.narrationAccum.trim(), this.cfg.maxEmitChars);
  }
}

/**
 * Build the chunk the engine yields for a due replay. Kept here so the
 * engine and tests share the exact shape. A dedicated `replay` kind — no
 * `tool` payload, never a tool call anywhere, and every consumer that could
 * persist the note can see by the TYPE alone that it must not.
 */
export function replayChunk(text: string): HarnessChunk {
  return { type: "replay", note: text };
}