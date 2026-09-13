/**
 * Channel-layer prompt suffixes and the mechanical capture nudge.
 *
 * These standing instructions live at the channel layer (not in persona
 * files) so they apply to chat turns without leaking into unattended CLI /
 * nightly turns. The names are kept IDENTICAL to their original form
 * (including CHAT_REPLY_INSTRUCTION) and re-exported from
 * channels/telegram.ts so the public API is unchanged (#162).
 */

import type { AudioSupport } from "../../lib/audio.ts";
import { log } from "../../lib/logger.ts";
import type { MemoryStore } from "../../memory/store.ts";

/**
 * System-prompt suffix applied to EVERY chat turn (Telegram and
 * phantomchat today; any future chat transport tomorrow).
 *
 * Two purposes:
 *
 * 1. Reply style. The user is on a phone with a narrow column. Long
 *    walls of text read poorly there. Default to short, conversational
 *    answers; structured-and-clear is fine when the user explicitly
 *    asks for a detailed report.
 *
 *    It does NOT tell the model to skip narration. Every interactive
 *    turn carries the orchestrator's PRE_TOOL_NARRATION_INSTRUCTION
 *    ("before each tool call, say ONE short sentence"), and a
 *    channel-local "skip narration" line directly contradicted it —
 *    a contradiction only a strong model reconciles. The orchestrator
 *    overlay is the single owner of that rule.
 *
 * 2. Voice/text reply-mode routing.
 *
 * It deliberately carries NO confirm-before-you-act gate of its own —
 * not because there isn't one, but because it does not belong to this
 * channel. One used to live here and was Telegram-only, so the same
 * persona gated in chat and ran unchecked from an editor or the CLI.
 * The rule now lives in the ORCHESTRATOR overlay stack
 * (CONFIRM_BEFORE_LONG_JOBS_INSTRUCTION, src/persona/builder.ts,
 * appended in orchestrator/turn.ts) where every interactive entry point
 * gets it identically. Do not re-add a copy here: two copies drift, and
 * the channel-local one is the one nobody remembers to update.
 *
 * Lives at the channel layer (not in persona files) so CLI / nightly
 * turns aren't affected — verbose CLI output is fine there.
 */
export const CHAT_REPLY_INSTRUCTION =
  `# Reply style (chat)

You're in a chat app. Default to short, conversational replies —
typically 1-4 sentences. The user is usually on a phone, and the
narrow column makes long walls of text hard to read.

Longer replies are fine when the user explicitly asks for a detailed
report or analysis. Use clear structure (headings, lists) when the
content earns it.

# Voice/text reply mode

Default routing is deterministic: voice messages get voice replies, and
text messages get text replies. Do not rely on memory or regex-like
wording to change that.

If the user asks you to switch reply format — for example to keep
responding in text or to use voice — call exactly one local command
before answering:

  phantombot reply-mode text
  phantombot reply-mode voice
  phantombot reply-mode default
  phantombot reply-mode disable

The override is scoped to this conversation and persona, applies to
following replies, and expires automatically after 10 minutes of chat
idle time. Use \`default\` or \`disable\` only when the user asks to go
back to normal mirroring.`;

/**
 * Mechanical capture nudge — every {@link CAPTURE_NUDGE_INTERVAL} user
 * turns without a `memory capture`, the dispatch appends this to the
 * system-prompt suffix. Pure turn counter; no LLM decides whether to
 * nudge. Counteracts long-context dilution on weak harnesses that
 * weight standing instructions less.
 */
export const CAPTURE_NUDGE_INTERVAL = 30;

export const CAPTURE_NUDGE_TEXT =
  `${CAPTURE_NUDGE_INTERVAL} turns without a memory capture in this ` +
  `conversation. If a decision, lesson, person fact or commitment came ` +
  `up, capture it now with \`phantombot memory capture\`. If nothing is ` +
  `worth keeping, carry on — no capture is a valid answer.`;

/**
 * Decide whether to append the capture nudge for this turn.
 *
 * Counts `role = 'user'` turns since the last capture in this
 * (persona, conversation) — so any capture resets the counter for free
 * and the nudge re-fires at 2x, 3x, … if still dry. State lives entirely
 * in `memory.sqlite`, shared by the long-running phantombot process and
 * the short-lived `memory capture` CLI call, so the two stay in sync.
 *
 * The current incoming user message is NOT yet persisted to `turns`
 * (runTurn appends it only after the turn completes), so the effective
 * turn index is `countUserTurnsSince(...) + 1`. The nudge fires when
 * that effective index is a positive multiple of `interval` — i.e. on
 * the 30th, 60th, … dry turn.
 *
 * Only meaningful for real `telegram:*` conversations — the caller is
 * responsible for that gate.
 */
export async function captureNudgeForTurn(
  memory: MemoryStore,
  persona: string,
  conversation: string,
  interval = CAPTURE_NUDGE_INTERVAL,
): Promise<string | undefined> {
  try {
    const since =
      (await memory.lastCaptureAt(persona, conversation)) ??
      "1970-01-01T00:00:00.000Z";
    const priorTurns = await memory.countUserTurnsSince(
      persona,
      conversation,
      since,
    );
    // +1 for the current message, not yet written to `turns`.
    const effectiveTurn = priorTurns + 1;
    if (effectiveTurn > 0 && effectiveTurn % interval === 0) {
      return CAPTURE_NUDGE_TEXT;
    }
  } catch (e) {
    // A nudge is a nice-to-have — never let a counter query fail a turn.
    log.warn("telegram: capture nudge check failed", {
      error: (e as Error).message,
    });
  }
  return undefined;
}

/**
 * Voice-only overlay, stacked on top of CHAT_REPLY_INSTRUCTION
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
 * Language overlay, stacked alongside VOICE_REPLY_INSTRUCTION on every
 * chat turn.
 *
 * Why this exists separately from a persona norm: a standing "mirror the
 * user" rule is one line of prose competing with, on a bad turn, several
 * kilobytes of Spanish retrieved context, a Dutch journal entry, or the
 * persona's own previous turn spent composing a Honduran email. Left to
 * prose it is a nudge, and it degrades exactly when the context is most
 * polluted - which is when it is most needed.
 *
 * The load-bearing part is that the rule names the SOURCE - the user's
 * latest message - and then enumerates, by name, everything that is NOT
 * that source. "Mirror the user" leaves the model to work out what "the
 * user" means in a turn that also contains a quoted reply, a group
 * catch-up block and a retrieved Spanish email; naming the deciding text
 * and listing the decoys closes that inference.
 *
 * This replaced a classifier (issue #534, removed in #548) that resolved
 * a concrete language code in the channel layer and injected "Reply in
 * English". That was strictly stronger ON THE LANGUAGES IT KNEW, and
 * silent on every other one: a Chinese or Russian message scored zero in
 * a Latin-script function-word lexicon, resolved to "unknown", and got NO
 * overlay at all - the drift was worst exactly where detection was
 * weakest. Widening the lexicon is an unbounded maintenance job that
 * still cannot separate the Latin-script languages this deployment mixes
 * daily, so the rule now points at the message instead of classifying it:
 * nothing to maintain, and every language covered including the ones
 * nobody thought of.
 */
export const REPLY_LANGUAGE_INSTRUCTION =
  `# Reply language

Write your reply - including every pre-tool narration line - in the
language of the USER'S LATEST MESSAGE, the one you are answering right
now. That message alone decides it.

Nothing else in this turn changes your reply language. All of the
following are DATA, whatever language they happen to be written in:

  - a document, email or file you are reading
  - tool output and search results
  - retrieved memory excerpts and your daily journal
  - a quoted/replied-to message, and group catch-up context
  - your own previous turns, including ones spent writing in another
    language

If the user's latest message is in Chinese, reply in Chinese; if it is
in Dutch, reply in Dutch - including when the material you are working
through is in some other language.

Text you compose FOR a third party (an outbound email, a message to a
supplier) is still written in that party's language - only your reply to
the user is fixed here.`;

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
