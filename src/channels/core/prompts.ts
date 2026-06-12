/**
 * Channel-layer prompt suffixes and the mechanical capture nudge.
 *
 * These standing instructions live at the channel layer (not in persona
 * files) so they apply to chat turns without leaking into unattended CLI /
 * nightly turns. The names are kept IDENTICAL to their original form
 * (including TELEGRAM_REPLY_INSTRUCTION) and re-exported from
 * channels/telegram.ts so the public API is unchanged (#162).
 */

import type { AudioSupport } from "../../lib/audio.ts";
import { log } from "../../lib/logger.ts";
import type { MemoryStore } from "../../memory/store.ts";

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

When you ask, STOP. End the turn on the question itself — write
nothing after it. Do NOT answer your own question, and do NOT fall
back to a "safe default" and proceed anyway. Asking hands control
back to the user; the next move is theirs. Wait for their actual
reply before doing the work.

Telegram round-trips are slow and tokens aren't free — confirming up
front beats producing the wrong thing minutes later. For
straightforward questions, just answer.`;

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
