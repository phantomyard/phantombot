/**
 * Resume-with-context: recover a turn killed by the idle watchdog AFTER it
 * had already produced output (issue #459).
 *
 * The failure this fixes
 * ---------------------
 * A harness attempt streams some narration, starts a tool call, and then the
 * provider wedges. The idle watchdog kills it. Every existing recovery path
 * declines to touch that state:
 *
 *   - Pi's coder-swap ladder (`CODER_SWAP_MAX_ATTEMPTS`) is gated on the
 *     attempt having produced NO output, precisely so it never replays a tool
 *     side effect.
 *   - The orchestrator chain falls through to the NEXT harness — but a
 *     single-entry chain (`chain = ["pi"]`, which is how Lena and every
 *     pi-only persona is configured) has nowhere to fall.
 *
 * So the worst failure mode — wedged mid-flight, work already half-done — was
 * the one nothing handled. The user got an apology bubble and the turn was
 * dropped.
 *
 * The trade being made
 * --------------------
 * The old guarantee was "never silently replay a side effect". The new one is
 * "never silently drop a turn", and the word doing the work is *silently*: the
 * recovery attempt is told exactly which calls were in flight and instructed to
 * VERIFY current state before redoing any of them. A model with tools can check
 * whether the commit landed; it cannot un-drop a turn. Dropping the turn is the
 * worse failure (Andrew, 2026-08-27).
 *
 * This ships ON, unconditionally. There is no config flag: an opt-in fix for a
 * user-visible failure is a fix nobody gets.
 *
 * What we can and cannot carry across
 * -----------------------------------
 * The killed attempt's stdout is exactly what we received before it went quiet:
 * narration `text` chunks and `progress` chunks (whose notes carry the tool name
 * and a truncated argument summary — see toolNote.ts). Tool RESULTS are
 * unavailable by definition; they were on the stdout that never arrived. So the
 * preamble can say "you called this" but never "it returned that", and it must
 * not claim the tool failed either — the stall may have been the provider
 * hanging AFTER the tool completed successfully. Verification is the model's
 * job, and it has the tools to do it.
 *
 * Harness-agnostic on purpose: the idle watchdog and the chunk stream are
 * orchestrator-level, so pi, claude and codex all get this. Pi happens to run
 * one-shot (`--print --no-session`) with phantombot owning conversation state,
 * so "resume" is a fresh spawn carrying a synthesised preamble rather than a
 * provider-side session resume — which is also why this needs no per-harness
 * support code.
 */

import type { HarnessChunk, HarnessRequest } from "../harnesses/types.ts";

/**
 * Recovery respawns allowed per harness per turn. One.
 *
 * A second idle kill means the wedge is not transient, and each attempt costs a
 * full idle window (300s by default) of the user's patience plus another round
 * of possibly-replayed tool calls. After this the turn falls through to the
 * next harness in the chain, or to the existing apology path.
 */
export const MAX_RESUME_ATTEMPTS = 1;

/** Cap on narration carried into the preamble (chars, tail-truncated). */
const MAX_NARRATION_CHARS = 2_000;

/** Cap on how many in-flight tool calls the preamble lists. */
const MAX_TOOL_CALLS = 20;

/**
 * Accumulator for one harness attempt's partial output — the "chunk log" the
 * recovery preamble is built from.
 *
 * Deliberately records only what a resumed attempt needs. Heartbeats are
 * ignored: they are liveness ticks with no payload, and treating them as output
 * is the exact bug (#123) that let a wedged turn defer its own idle kill.
 */
export class PartialAttempt {
  private narration = "";
  private readonly tools: string[] = [];
  private toolsDropped = 0;
  private otherProgress = 0;

  /** Fold one chunk from the live stream into the log. */
  record(chunk: HarnessChunk): void {
    if (chunk.type === "text") {
      this.narration += chunk.text;
      return;
    }
    if (chunk.type === "progress") {
      // ONLY a structured `chunk.tool` is a started tool call. The chunk
      // contract allows `progress` without `tool` for plain liveness and
      // diagnostic lines (a version warning, a "still working" note), and
      // those must not become resume evidence: telling the model a version
      // warning "may or may not have applied" is a lie, and letting one
      // satisfy `producedOutput` would respawn a harness that had in fact
      // produced nothing — stealing the turn from the ordinary, cheaper
      // no-output fall-through. Counted separately so the wedge is still
      // visible in the log without changing the decision.
      if (!chunk.tool) {
        this.otherProgress++;
        return;
      }
      const note = chunk.tool.title.trim();
      if (!note) return;
      if (this.tools.length < MAX_TOOL_CALLS) this.tools.push(note);
      else this.toolsDropped++;
    }
  }

  /**
   * Did this attempt produce anything a resume could build on?
   *
   * This is the same distinction pi's ladder draws (`producedOutput`), and it
   * is what splits the two recovery regimes: nothing produced ⇒ a plain retry
   * is safe and the existing paths own it; something produced ⇒ only a
   * verify-first resume is safe, which is this module.
   */
  get producedOutput(): boolean {
    return this.narration.trim().length > 0 || this.tools.length > 0;
  }

  /** Narration the user has ALREADY seen, tail-truncated to the cap. */
  get text(): string {
    const t = this.narration.trim();
    return t.length > MAX_NARRATION_CHARS
      ? `…${t.slice(-MAX_NARRATION_CHARS)}`
      : t;
  }

  /** Tool-call titles seen starting, in order. */
  get toolCalls(): string[] {
    return [...this.tools];
  }

  /** Tool calls elided by the cap, so the preamble can say so honestly. */
  get droppedToolCalls(): number {
    return this.toolsDropped;
  }

  /**
   * Non-tool progress lines seen (diagnostics, liveness). Diagnostic only —
   * deliberately NOT part of `producedOutput` and never quoted at the model.
   */
  get nonToolProgress(): number {
    return this.otherProgress;
  }

  /** The raw, untruncated streamed text, for terminal-`done` reconciliation. */
  get rawText(): string {
    return this.narration;
  }
}

/**
 * Should this error chunk trigger a recovery respawn of the SAME harness?
 *
 * Narrow by construction — every clause is load-bearing:
 *   - `idle` only. A hard-cap `timeout` means a runaway that kept feeding the
 *     idle timer, and respawning it just burns another wall-clock ceiling.
 *     `startup` means no output at all, which the plain chain already covers.
 *     `aborted` is the user saying /stop and meaning it.
 *   - output already produced, or there is nothing to resume WITH and the
 *     existing fall-through is both cheaper and safer.
 *   - budget left: one respawn per harness per turn.
 */
export function shouldResume(
  chunk: HarnessChunk,
  partial: PartialAttempt,
  resumeAttemptsUsed: number,
): boolean {
  if (chunk.type !== "error") return false;
  if (chunk.killCause !== "idle") return false;
  if (chunk.terminal) return false;
  if (!partial.producedOutput) return false;
  return resumeAttemptsUsed < MAX_RESUME_ATTEMPTS;
}

/**
 * Build the recovery preamble handed to the respawned attempt.
 *
 * Tone matters here and is not decoration. It must convey three things without
 * overclaiming any of them: the turn was interrupted (not failed), the listed
 * calls are of UNKNOWN outcome (not failed), and the already-streamed text is
 * on the user's screen (so don't repeat it). Anything stronger — "the tool
 * failed", "retry the call" — invites exactly the blind replay this design is
 * built to avoid.
 */
export function buildResumePreamble(partial: PartialAttempt): string {
  const lines: string[] = [
    "[phantombot — automatic recovery of an interrupted turn]",
    "",
    "Your previous attempt at this turn was terminated mid-flight: it stopped" +
      " producing output and was killed by the idle watchdog. This is a fresh" +
      " process with no memory of that attempt beyond what is quoted below.",
  ];

  const said = partial.text;
  if (said) {
    lines.push(
      "",
      "You had already streamed this to the user, and they can see it — do not repeat it:",
      "---",
      said,
      "---",
    );
  }

  const calls = partial.toolCalls;
  if (calls.length > 0) {
    lines.push("", "You had started these tool calls, most recent last:");
    for (const c of calls) lines.push(`  - ${c}`);
    if (partial.droppedToolCalls > 0) {
      lines.push(`  - (…and ${partial.droppedToolCalls} more, not listed)`);
    }
    lines.push(
      "",
      "Each of those MAY OR MAY NOT have applied. Their results were lost with" +
        " the interrupted process, and the stall may have happened before," +
        " during or after any of them. VERIFY the current state before redoing" +
        " any call that changes anything — writes, commits, sends, payments," +
        " deletions. Read first, then act only on what you find.",
    );
  }

  lines.push(
    "",
    "The user has not received a completed reply. Pick up where you left off" +
      " and finish the turn.",
  );
  return lines.join("\n");
}

/**
 * The request for the recovery attempt: the original turn, plus the preamble.
 *
 * The preamble is appended to the user message rather than the system prompt so
 * it lands LAST in the rendered context — closest to where the model starts
 * generating, and unambiguously about this turn rather than standing persona
 * instruction. The original `userMessage` is preserved verbatim above it: the
 * resumed attempt is answering the same question, just not from scratch.
 */
export function buildResumeRequest(
  req: HarnessRequest,
  partial: PartialAttempt,
): HarnessRequest {
  return {
    ...req,
    userMessage: `${req.userMessage}\n\n${buildResumePreamble(partial)}`,
  };
}
