/**
 * Channel-agnostic group-chat routing.
 *
 * Decides — purely from the shared human-message stream every bot in a group
 * sees identically — whether THIS bot should reply, what the chat's
 * "last addressed" set becomes, and how to render the messages a bot observed
 * but stayed quiet through into a catch-up preamble.
 *
 * This logic is independent of Telegram's wire format (it operates on plain
 * names + text), so it lives in core/ and any future multi-bot channel can
 * reuse it. Moved out of the former monolithic channels/telegram.ts (#162);
 * re-exported from there as a barrel so the public API is unchanged.
 */

import { sanitizeEnvelopeField } from "../telegram/parse.ts";

/**
 * Find which of `names` are addressed in `text`. A name matches
 * case-insensitively when bounded by non-letters, so "robbie" matches
 * inside "@robbie_agh_bot", "Robbie," or "robbie!" but NOT "robbiee" or
 * "scrobbie". Returns the matched names in the order they appear in
 * `names` (deduped, original casing preserved). Exported for testing.
 */
export function matchPersonaNames(text: string, names: string[]): string[] {
  if (text.length === 0 || names.length === 0) return [];
  const out: string[] = [];
  for (const name of names) {
    if (name.length === 0 || out.some((n) => n.toLowerCase() === name.toLowerCase())) {
      continue;
    }
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Letter boundaries (not \b, which treats "_" as a word char and so
    // would fail to match "robbie" inside "robbie_agh_bot").
    const re = new RegExp(`(?<![a-z])${escaped}(?![a-z])`, "i");
    if (re.test(text)) out.push(name);
  }
  return out;
}

/** The one rule for what "@name" wakes. Shared with the unmatched-mention notice
 *  (groupContext.ts), which must never call a mention that wakes someone unmatched. */
export function atMentionPattern(name: string, flags: "i" | "iy"): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w@])@${escaped}(?![a-z0-9_])`, flags);
}

/**
 * Find which of `names` are explicitly @-mentioned in `text` ("@kai", "@Kai,").
 * Stricter than matchPersonaNames: a phantom's message often names its
 * siblings in passing ("Kai and Omar approved"), and on PhantomChat a phantom's
 * message wakes another phantom only through a deliberate @mention. Same letter
 * boundary on the right; the "@" must not be glued to a preceding word char, so
 * an email-like "x@kai" is not a mention. Exported for testing.
 */
export function matchAtMentions(text: string, names: string[]): string[] {
  if (text.length === 0 || names.length === 0) return [];
  const out: string[] = [];
  for (const name of names) {
    if (name.length === 0 || out.some((n) => n.toLowerCase() === name.toLowerCase())) {
      continue;
    }
    if (atMentionPattern(name, "i").test(text)) out.push(name);
  }
  return out;
}

/**
 * Phantom handoff budget for a PhantomChat team group: how many phantom
 * handoffs (a phantom's group message that @mentions another phantom) may run
 * back to back before the phantoms pause and wait for a human. Any human
 * message in the group refills it. Sized from real review loops: the heaviest
 * recent one (6 pushes, 3 reviewers) was ~35 handoffs, so 60 leaves headroom
 * for a hard job overnight while still capping a runaway loop. Deliberately a
 * constant, not a setting.
 */
export const PHANTOM_HANDOFF_BUDGET = 60;

/** Largest handoff sent as one message (PhantomChat server). The text is
 *  JSON-escaped twice and encrypted twice on its way out, and NIP-44 pads and
 *  caps at 64 KB, so stay far below that. A longer reply is split into bubbles
 *  like any other, and only the bubble holding the @name wakes the teammate.
 *  Lives here so the phantom guide (prompts.ts) can state it. */
export const MAX_WHOLE_HANDOFF_BYTES = 8_000;

/**
 * Decide whether THIS bot (persona `self`) should reply to a group message,
 * and what the chat's "last addressed" set becomes afterwards.
 *
 * Rules (all computed locally — Telegram never shows a bot another bot's
 * messages, so this must work from the human message stream alone, which
 * every bot in the group sees identically):
 *   - One or more persona names are in the message → those bots are now
 *     "addressed". I reply iff my own name is among them. Multiple names →
 *     each named bot replies independently.
 *   - No persona name at all → the message continues the current thread, so
 *     only the bot(s) addressed last reply. I reply iff I'm in lastAddressed.
 *   - No name AND nobody has ever been addressed (lastAddressed empty) →
 *     silence, full stop.
 *
 * Exported for testing.
 */
export function decideGroupReply(input: {
  self: string;
  matched: string[];
  lastAddressed: string[];
}): { reply: boolean; nextLastAddressed: string[] } {
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (input.matched.length > 0) {
    return {
      reply: input.matched.some((n) => eq(n, input.self)),
      nextLastAddressed: input.matched,
    };
  }
  return {
    reply: input.lastAddressed.some((n) => eq(n, input.self)),
    nextLastAddressed: input.lastAddressed,
  };
}

/**
 * Render the messages a bot OBSERVED but didn't reply to (aimed at another
 * bot, thread chatter, or — on PhantomChat — sibling bots' replies) into a
 * context preamble.
 * Privacy-OFF means every bot sees every human message, so this is how a bot
 * catches up on the conversation it stayed quiet through before it's finally
 * addressed. Returns "" when there's nothing buffered. Exported for testing.
 */
export function formatGroupContext(
  entries: { from: string; text: string }[],
): string {
  // Both the sender label and the body are attacker-controlled; sanitize each
  // so a crafted username or message can't inject a newline + forged `]` that
  // closes this multi-line envelope early. (#161, item f)
  const lines = entries
    .map((e) => `${sanitizeEnvelopeField(e.from)}: ${sanitizeEnvelopeField(e.text)}`.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return "";
  return [
    "[Recent group messages you saw but didn't reply to, for context:",
    ...lines,
    "]",
  ].join("\n");
}

/** In-memory per-chat group routing state. Lives for the process lifetime;
 *  intentionally not persisted (it's cheap to rebuild from the live stream
 *  and bounded to GROUP_BUFFER_MAX entries per chat). */
export interface GroupChatState {
  /** Persona names addressed by the most recent name-bearing message. */
  lastAddressed: string[];
  /** Rolling buffer of recent group messages for context catch-up. */
  buffer: { from: string; text: string; delivered: boolean }[];
}

/** Cap on buffered human messages retained per group chat. */
export const GROUP_BUFFER_MAX = 100;

/** Cap on the characters one buffered message contributes (longer text is
 *  cut with a truncation marker), so the preamble stays bounded in size. */
export const GROUP_BUFFER_TEXT_MAX = 2000;
