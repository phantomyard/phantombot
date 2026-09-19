/**
 * Stream-level narration language gate (issue #580, second half).
 *
 * #583 put the gate in the two CHAT channels, where narration is already
 * classified: the channel knows that text emitted since the last tool
 * boundary, and not yet sent as a final bubble, was pre-tool narration. ACP
 * (Zed/VS Code/JetBrains), the TUI and `phantombot ask` have no such
 * classifier — they stream `text` chunks straight through — so they were the
 * only surfaces still relying on model compliance, and ACP is where the #580
 * evidence measured the HIGHEST leak rate of all.
 *
 * So the gate moves UP, to the one place every surface already shares: the
 * chunk stream out of `runTurn`. One implementation, five consumers, and the
 * channels lose their private copy (see core/streaming.ts).
 *
 * THE HARD PART is that "this text is narration" is only knowable in
 * retrospect: text is narration iff a tool call follows it. Buffering all
 * text until the next boundary would destroy live streaming for exactly the
 * surfaces this is for. So we hold text only while its language is UNKNOWN or
 * WRONG:
 *
 *   - unknown  → buffer the current line until it scores, or until
 *                `CLASSIFY_CAP` bytes prove it unscoreable. Typically a few
 *                words: the detector needs three tokens, and function words
 *                arrive early in any language.
 *   - right    → emit, and mark the line clear so the REST of it streams
 *                token-by-token with no further delay.
 *   - wrong    → hold. Resolved at the very next chunk boundary:
 *                  `progress` → a tool call followed, so it WAS narration →
 *                               drop the offending lines.
 *                  `done`/`error`/overflow → no tool call followed, so it was
 *                               the reply BODY → release it verbatim.
 *
 * The body is never gated. It legitimately quotes foreign text, and across
 * ~14,800 scored turns it has never leaked; every observed leak was narration.
 * A wrong-language line that turns out to be body is released UNCHANGED — the
 * hold is a delay, not a filter, until a tool boundary says otherwise.
 *
 * Dropped lines are also removed from `done.finalText`, which is what gets
 * persisted to history and (on Telegram) re-sent as the final reply. Dropping
 * a line from the stream but leaving it in `finalText` would put the leak
 * straight back on screen.
 */

import { toolTransmitsContent } from "../harnesses/toolNote.ts";
import type { HarnessChunk } from "../harnesses/types.ts";
import { detectLanguage, expectedLanguageOf } from "./languageGate.ts";
import { log } from "./logger.ts";

/**
 * Give up on classifying the current line after this many bytes. A line this
 * long that still has not scored is genuinely unscoreable (a path list, a
 * table row, a code fragment) and gating it was never possible.
 */
const CLASSIFY_CAP = 160;

/**
 * Release a hold this large without waiting for a boundary. Narration is one
 * or two short sentences by construction (the prompt caps it at ~12 words);
 * anything this long is prose the model is writing as its answer, and holding
 * it any longer would stall a real reply.
 */
const HOLD_RELEASE_CAP = 2000;

/**
 * A narration LINE is one short sentence. Past this it is prose, whatever
 * follows it in the stream.
 */
const NARRATION_MAX_CHARS = 200;

/**
 * A narration BURST is at most a couple of those sentences. Past this the
 * block is an answer that happens to sit in front of a tool call.
 */
const NARRATION_BURST_MAX_CHARS = 400;

/**
 * Is one LINE shaped like narration? Narration is plain, short, unquoted
 * prose — the narration instruction says so itself ("one short sentence",
 * "under ~12 words", no markdown).
 */
function looksLikeNarrationLine(line: string): boolean {
  const t = line.trim();
  if (t.length === 0) return true; // blank lines carry no language
  if (t.length > NARRATION_MAX_CHARS) return false;
  // Markdown structure: heading, list item, quote, table row, fence, rule.
  if (/^(?:[#>|=-]|\d+[.)]|[*+-]\s|```|~~~)/.test(t)) return false;
  // Emphasis/links/code are formatting a narration line never carries.
  if (/\*\*|__|\[[^\]]*\]\(|`/.test(t)) return false;
  // A quoted string is something being SHOWN to the user, not said to them.
  if (/^["'«“„‘]/.test(t)) return false;
  return true;
}

/**
 * Is the whole pre-tool-call block narration, and therefore droppable?
 *
 * THIS IS THE LOAD-BEARING DECISION IN THIS FILE. The tool-boundary rule
 * cannot, on its own, tell narration from a reply body that happens to come
 * just before a tool call — and the single most likely body of that shape is
 * precisely the legitimate foreign-language case: a draft the principal asked
 * for in someone else's language, written out and then sent by the next tool
 * call. The reply-language rule explicitly carves that out ("text you compose
 * FOR a third party is still written in that party's language"), so the gate
 * must not eat it.
 *
 * What separates them is shape, not meaning: narration is a short burst of
 * plain one-line sentences. A draft, a table or a list has a paragraph break,
 * markdown, or length. Requiring ALL of those to be absent is what keeps a
 * draft out of the gate.
 *
 * Dropping narration costs nothing; dropping an answer costs the user their
 * answer. Where the two cannot be told apart, the block is emitted.
 */
export function isNarrationBlock(block: string): boolean {
  const t = block.trim();
  if (t.length === 0 || t.length > NARRATION_BURST_MAX_CHARS) return false;
  // A paragraph break means composed prose, never narration.
  if (/\n\s*\n/.test(t)) return false;
  return t.split("\n").every(looksLikeNarrationLine);
}

/**
 * Release anything still buffered after this long with no upstream chunk.
 *
 * Without it the gate can hold a stream open indefinitely: a harness that
 * writes a short sentence and then thinks silently would leave that sentence
 * invisible until it spoke again, and a harness that stalls outright would
 * never show it at all. That is a worse failure than the leak this file
 * exists to prevent, and it is not hypothetical — it is the shape of every
 * "model narrates, then runs a slow tool" turn.
 *
 * 500 ms is chosen against the thing being gated, not against human
 * perception: text and the tool call that follows it arrive in the same
 * stream flush, microseconds apart, so a real narration/tool pair is resolved
 * long before this fires. What fires it is a genuine pause, and a genuine
 * pause means the text was not narration.
 */
export const NARRATION_IDLE_RELEASE_MS = 500;

/**
 * How long teardown waits for the source's own cleanup before giving up.
 *
 * Short on purpose: this is a courtesy, not a guarantee. A source that is
 * answering closes well inside it; a source that is stalled never will, and
 * the consumer that is trying to abort must not be held behind it.
 */
export const TEARDOWN_GRACE_MS = 50;

export interface NarrationStreamGate {
  /**
   * Feed one upstream chunk; returns the chunks to emit downstream, in order.
   * May be empty (text is being held) or contain more than one entry (a
   * released hold followed by the boundary that resolved it).
   */
  push(chunk: HarnessChunk): HarnessChunk[];
  /**
   * Emit everything buffered, unchanged. Called when the upstream stream has
   * gone quiet: no tool call followed, so nothing here is narration.
   */
  releaseHold(): HarnessChunk[];
}

/** Pass everything through unchanged — used when there is nothing to gate. */
function identityGate(): NarrationStreamGate {
  return { push: (chunk) => [chunk], releaseHold: () => [] };
}

/**
 * Build a gate for a turn whose user message is `userMessage`.
 *
 * Returns a pass-through when the user's message cannot be scored confidently
 * (too short, too mixed, no prose). That is the common case for "ok", "yes",
 * a bare URL — and it is the intended behaviour: the gate exists to remove a
 * KNOWN wrong output, never to police an uncertain one.
 */
export function createNarrationStreamGate(
  userMessage: string,
): NarrationStreamGate {
  const expected = expectedLanguageOf(userMessage);
  if (!expected) return identityGate();

  // Text of the current line whose language is not yet known.
  let pending = "";
  // The current line already scored as acceptable: stream the rest of it
  // freely. Reset on every newline — each line is classified on its own, so
  // one correct line cannot shelter a leaked one that follows it.
  let lineClear = false;
  // Wrong-language text awaiting a verdict from the next boundary.
  let hold = "";
  // Lines actually dropped, so they can be cut from `done.finalText` too.
  const dropped: string[] = [];
  // EVERY byte of text since the last tool boundary, including the parts
  // already emitted. The shape test has to see the whole block: a held tail
  // read on its own looks like a tidy one-line sentence even when it is the
  // second paragraph of an email draft.
  let sinceBoundary = "";

  /**
   * The language of `text` when it is confidently NOT the expected one.
   * Returns the offending code (not a boolean) so the drop log can carry it:
   * #585 keys its counter on the (expected, actual) pair, and a drop logged
   * without `actual` is a half-populated key.
   */
  const mismatchOf = (text: string): string | undefined => {
    const actual = detectLanguage(text);
    return actual && actual.code !== expected.code ? actual.code : undefined;
  };

  const textChunk = (text: string): HarnessChunk[] =>
    text.length > 0 ? [{ type: "text", text }] : [];

  /**
   * A tool call followed the held text. Drop it ONLY if the whole pre-boundary
   * block is shaped like narration AND is confidently in the wrong language
   * AND the tool that follows is not one that SENDS text.
   *
   * The tool-boundary rule cannot, on its own, tell narration from a reply
   * body that happens to precede a tool call — and the single most likely
   * body of that shape is exactly the legitimate foreign-language case: a
   * draft the principal asked for in someone else's language, written out and
   * then sent by the next tool call. (The reply-language rule explicitly
   * carves that out: "text you compose FOR a third party is still written in
   * that party's language".) So TWO independent signals have to agree before
   * anything is dropped:
   *
   *   1. SHAPE — narration is a short burst of plain one-line sentences; a
   *      draft has a paragraph break, markdown, or length. Judged on the
   *      whole block since the last boundary, never on the held tail alone.
   *   2. THE TOOL — a boundary whose tool transmits content to a third party
   *      (mail, chat, SMS, a post) makes the text in front of it PAYLOAD far
   *      more often than narration, and the failure there is the worst one
   *      this file can produce: the tool args still carry the draft, so the
   *      message goes out while the principal's copy of it is deleted from
   *      both the stream and `finalText` — a send they cannot see.
   *
   * Shape alone is not enough, and cannot be made enough: at narration length
   * a one-line Dutch draft ("Hartelijk dank voor de update.") and a one-line
   * Dutch narration leak are the same object. That is exactly why the tool is
   * consulted as a second, independent signal rather than by sharpening the
   * shape test further.
   *
   * Dropping narration costs nothing. Dropping an answer costs the user their
   * answer. When the two cannot be told apart, the block is emitted.
   */
  const resolveAtToolBoundary = (tool?: { name?: string }): string => {
    const block = hold + pending;
    hold = "";
    pending = "";
    lineClear = false;
    const wasNarration = isNarrationBlock(sinceBoundary);
    sinceBoundary = "";
    if (!wasNarration) return block;
    if (toolTransmitsContent(tool?.name)) {
      // The next thing this turn does is SEND. Whatever is held is the
      // principal's only view of what went out; never eat it.
      if (block.trim()) {
        log.debug("narration: kept a held block in front of a sending tool", {
          expected: expected.code,
          tool: tool?.name,
          chars: block.length,
        });
      }
      return block;
    }
    const kept: string[] = [];
    for (const line of block.split("\n")) {
      const actual = line.trim() ? mismatchOf(line) : undefined;
      if (actual) {
        dropped.push(line);
        log.info("narration: dropped a line in the wrong language", {
          expected: expected.code,
          actual,
          chars: line.length,
        });
        continue;
      }
      kept.push(line);
    }
    const out = kept.join("\n");
    return out.trim() ? out : "";
  };

  /** No tool call followed: the held text was the reply body. Emit verbatim. */
  const release = (): string => {
    const out = hold + pending;
    sinceBoundary = "";
    hold = "";
    pending = "";
    lineClear = false;
    return out;
  };

  const onText = (text: string): HarnessChunk[] => {
    // Already holding: everything after a held line must stay behind it or the
    // reply would arrive out of order.
    sinceBoundary += text;
    if (hold) {
      hold += text;
      return hold.length >= HOLD_RELEASE_CAP ? textChunk(release()) : [];
    }

    pending += text;
    let out = "";

    // Complete lines first — a newline is the only point at which the
    // classification of one line is final.
    let nl: number;
    while ((nl = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, nl + 1);
      pending = pending.slice(nl + 1);
      if (!lineClear && mismatchOf(line)) {
        // Start holding HERE, and carry the rest of the buffer with it.
        hold = line + pending;
        pending = "";
        return textChunk(out);
      }
      out += line;
      lineClear = false;
    }

    // Trailing partial line.
    if (lineClear) {
      out += pending;
      pending = "";
      return textChunk(out);
    }
    const guess = detectLanguage(pending);
    if (guess && guess.code !== expected.code) {
      hold = pending;
      pending = "";
      return textChunk(out);
    }
    if (guess || pending.length >= CLASSIFY_CAP) {
      // Either it scored as acceptable, or it is long enough that it never
      // will — both mean this line streams freely from here on.
      lineClear = true;
      out += pending;
      pending = "";
    }
    return textChunk(out);
  };

  /**
   * Cut dropped lines out of the authoritative final text so the leak cannot
   * come back through history or through a channel that re-sends `finalText`.
   * Exact-substring removal only: if the harness reformatted its own reply we
   * leave it alone rather than guess.
   */
  const redact = (finalText: string): string => {
    let out = finalText;
    for (const line of dropped) {
      const at = out.indexOf(line);
      if (at === -1) {
        log.debug("narration: dropped line not found in finalText");
        continue;
      }
      out = out.slice(0, at) + out.slice(at + line.length);
    }
    return out.replace(/\n{3,}/g, "\n\n").trim();
  };

  return {
    releaseHold: (): HarnessChunk[] => textChunk(release()),
    push(chunk: HarnessChunk): HarnessChunk[] {
      switch (chunk.type) {
        case "text":
          return onText(chunk.text);
        case "progress": {
          // Only a progress chunk that CARRIES a tool is a tool call. The
          // runner also emits `progress` for any non-JSON line a harness
          // writes to stdout (raw stderr liveness), with no `tool` — treating
          // that as a boundary would let an unrelated log line delete the
          // text in front of it. Those are liveness, like a heartbeat: the
          // hold survives them.
          if (!chunk.tool) return [chunk];
          // A real tool call. Everything still buffered was pre-tool
          // narration — and it MUST be flushed before the boundary reaches
          // the channel, because the channels classify narration by exactly
          // this boundary.
          return [...textChunk(resolveAtToolBoundary(chunk.tool)), chunk];
        }
        case "done": {
          const flushed = release();
          const finalText = dropped.length
            ? redact(chunk.finalText)
            : chunk.finalText;
          return [
            ...textChunk(flushed),
            { ...chunk, finalText },
          ];
        }
        case "error":
          return [...textChunk(release()), chunk];
        default:
          // heartbeat / replay carry no text and end no line: they are
          // liveness, and a hold survives them.
          return [chunk];
      }
    },
  };
}

/**
 * Wrap a harness chunk stream in the gate.
 *
 * The idle race lives here rather than in the gate itself so the gate stays a
 * pure, synchronous state machine that a test can drive chunk by chunk.
 */
export async function* gateNarrationStream(
  source: AsyncIterable<HarnessChunk>,
  userMessage: string,
  idleMs: number = NARRATION_IDLE_RELEASE_MS,
): AsyncGenerator<HarnessChunk> {
  const gate = createNarrationStreamGate(userMessage);
  const it = source[Symbol.asyncIterator]();
  const IDLE = Symbol("idle");
  // The pull we are currently waiting on. After an idle release this can
  // still be outstanding when the consumer walks away — the teardown below
  // needs to know that.
  let outstanding: Promise<IteratorResult<HarnessChunk>> | undefined;
  try {
    for (;;) {
      const next = it.next();
      outstanding = next;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<typeof IDLE>((resolve) => {
        timer = setTimeout(() => resolve(IDLE), idleMs);
      });
      const first = await Promise.race([next, idle]);
      if (first === IDLE) {
        // Nothing arrived in time: show the user what we are sitting on.
        yield* gate.releaseHold();
      } else if (timer) {
        clearTimeout(timer);
      }
      const result = await next;
      if (timer) clearTimeout(timer);
      outstanding = undefined;
      if (result.done) break;
      yield* gate.push(result.value);
    }
  } finally {
    // Ask the source to clean up — but NEVER block this generator's own
    // teardown on it.
    //
    // An async generator serialises its queue: `return()` runs only after the
    // `next()` ahead of it settles. After an idle release that `next()` is by
    // definition outstanding on a source that is not answering, so awaiting
    // `return()` here waits on the stalled harness — forever. That is the
    // precise path this file's idle release exists to rescue, and it would
    // wedge every consumer that breaks mid-stall: /stop, an abort, the
    // interrupted-pair teardown. A `finally` that can hang is worse than no
    // cleanup at all.
    //
    // So: fire `return()`, wait only briefly for it, and let a stalled source
    // be reclaimed with the turn. Swallow both rejections explicitly —
    // abandoning a pull whose promise later rejects is an unhandled rejection
    // that crashes the process in Bun.
    outstanding?.catch(() => undefined);
    const closed = it.return?.();
    if (closed) {
      const settled = closed.then(
        () => undefined,
        () => undefined,
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, TEARDOWN_GRACE_MS);
        // Don't hold the event loop open for a window we usually don't need.
        (timer as unknown as { unref?: () => void }).unref?.();
      });
      await Promise.race([settled, grace]);
      if (timer) clearTimeout(timer);
    }
  }
}
