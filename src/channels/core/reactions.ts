/**
 * ============================================================================
 *  EMOJI REACTIONS — the channel-agnostic core
 * ============================================================================
 *
 * Andrew reacts to a message with an emoji (👍 / 👎 / ❤️ / …). We want that
 * signal as CONTEXT, not as a reply trigger that spams the chat: a reaction
 * WAKES the agent for one turn so it can record what was reacted to and WHY,
 * but the turn stays SILENT unless something genuinely material needs
 * surfacing ("you 👎'd the thing I just shipped — want me to revert?").
 *
 * This module is the part that is IDENTICAL for every channel — it sits ABOVE
 * the wire, so Telegram and PhantomChat share it instead of each growing their
 * own reaction pipeline (the no-duplication requirement). Each channel only
 * supplies the wire-specific plumbing:
 *
 *   - Telegram: subscribe to `message_reaction` updates (getUpdates
 *     allowed_updates) and parse the old/new delta into a {@link ChannelReaction}.
 *   - PhantomChat: subscribe to plaintext NIP-25 kind-7 reaction events (and
 *     kind-5 deletes for removals) and parse them into a {@link ChannelReaction}.
 *
 * Both then call {@link runReactionTurn} with the parsed reaction. Everything
 * from there — envelope framing, the wake-but-silent turn, the silence gate —
 * lives here, once.
 *
 * --- Correlation (which message did they react to?) ---------------------------
 *
 * A reaction event names the reacted-to message by ID and carries the emoji,
 * but NOT the message's text. Both platforms have this same gap: Telegram gives
 * a `message_id`; PhantomChat gives the reaction's `['e', <rumorId>]` target. So
 * to tell the agent WHICH message was reacted to, we keep a small bounded map of
 * our own RECENT OUTBOUND messages (id → text), populated by each transport as
 * it sends. On a reaction we look the target id up; a hit gives the agent the
 * exact snippet, a miss (older message, or a restart cleared the map, or the
 * user reacted to their OWN message which we never sent) degrades gracefully to
 * "id only" — the turn still runs and the agent infers from conversation
 * history. See {@link RecentOutbound}.
 */

import { homedir } from "node:os";
import type { Harness } from "../../harnesses/types.ts";
import { log } from "../../lib/logger.ts";
import type { MemoryStore } from "../../memory/store.ts";
import { runTurn } from "../../orchestrator/turn.ts";

/**
 * A normalized inbound reaction, channel-agnostic — the reaction analogue of
 * {@link ChannelMessage}. Both channels parse their wire event into this shape
 * and hand it to {@link runReactionTurn}.
 */
export interface ChannelReaction {
  /**
   * Conversation id — the SAME channel-neutral string key the corresponding
   * message would carry (Telegram: stringified chat id; PhantomChat: the peer
   * hex). Used to scope the memory conversation AND to look the reacted-to
   * message up in {@link RecentOutbound}.
   */
  conversationId: string;
  /** Stable sender id (Telegram numeric id stringified / PhantomChat hex). Gates the trust perimeter. */
  senderId: string;
  /** Optional human handle for logging. */
  fromUsername?: string;
  /**
   * Id of the message that was reacted to. Telegram: the `message_id` of the
   * reacted message. PhantomChat: the reaction's `['e', ...]` target rumor id.
   * Correlated against {@link RecentOutbound} to recover the text.
   */
  targetMessageId: string;
  /**
   * The reaction emoji, e.g. "👍". For a REMOVAL this is the emoji that was
   * taken away. May be empty when the platform reports a removal without
   * telling us which emoji left (PhantomChat kind-5 deletes name the event,
   * not the emoji) — the envelope handles that case.
   */
  emoji: string;
  /** "added" when a reaction appeared, "removed" when one was taken away. */
  action: "added" | "removed";
}

/**
 * Bounded per-conversation ring of our RECENT OUTBOUND messages, so a reaction
 * can be correlated back to the text of the message it targets.
 *
 * Keyed by conversation, each holding a small FIFO of `{ messageId, text }`.
 * `record` is called by a channel transport every time it successfully sends a
 * message; `lookup` is called when a reaction arrives. Deliberately in-memory
 * and small: this is a best-effort correlation aid, not durable state — a miss
 * degrades to "id only" and the turn still runs. Bounding both the per-
 * conversation depth and the conversation count keeps a long-lived process from
 * growing it without bound.
 */
export class RecentOutbound {
  private readonly byConversation = new Map<
    string,
    Array<{ messageId: string; text: string }>
  >();

  constructor(
    /** How many recent outbound messages to remember per conversation. */
    private readonly perConversation = 40,
    /** How many distinct conversations to track before evicting the oldest. */
    private readonly maxConversations = 500,
  ) {}

  /** Remember that we sent `text` as `messageId` in `conversationId`. */
  record(conversationId: string, messageId: string, text: string): void {
    if (!messageId) return;
    let ring = this.byConversation.get(conversationId);
    if (!ring) {
      ring = [];
      this.byConversation.set(conversationId, ring);
      // Evict the oldest conversation once we cross the cap. Map iteration is
      // insertion-ordered, so the first key is the oldest inserted.
      if (this.byConversation.size > this.maxConversations) {
        const oldest = this.byConversation.keys().next().value;
        if (oldest !== undefined) this.byConversation.delete(oldest);
      }
    }
    ring.push({ messageId, text });
    while (ring.length > this.perConversation) ring.shift();
  }

  /** Recover the text of `messageId` in `conversationId`, or undefined on a miss. */
  lookup(conversationId: string, messageId: string): string | undefined {
    const ring = this.byConversation.get(conversationId);
    if (!ring) return undefined;
    // Search newest-first: the most recent match is the relevant one.
    for (let i = ring.length - 1; i >= 0; i--) {
      if (ring[i]!.messageId === messageId) return ring[i]!.text;
    }
    return undefined;
  }
}

/** Max chars of the correlated message we quote into the reaction envelope. */
export const REACTION_SNIPPET_MAX = 280;

/**
 * Neutralize a field before interpolating it INSIDE our bracketed `[reaction …]`
 * envelope marker — same defense as the Telegram reply-quote path: collapse all
 * whitespace to single spaces and swap ASCII square brackets for their fullwidth
 * look-alikes so a crafted message body can't close our marker early and forge a
 * fake structured line. Content meaning is preserved; the ability to forge
 * envelope structure is removed. (Kept local so `core/` doesn't import a
 * channel adapter.)
 */
function sanitizeReactionField(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\[/g, "［")
    .replace(/\]/g, "］")
    .trim();
}

/**
 * Build the single-line, bracketed envelope handed to the agent as the "user
 * message" for a reaction turn. Framed like the other structured markers
 * (`[attached: …]`, `[in reply to …]`) so the agent reads it as TRUSTED
 * STRUCTURE, not free-form prose. Exported for testing.
 *
 * Shapes:
 *   [reaction] Andrew added 👍 to your message: "shipped PR #332 ✅"
 *   [reaction] Andrew removed 👎 from your message #482 (text not on record —
 *              infer from recent history)
 */
export function formatReactionEnvelope(
  reaction: ChannelReaction,
  targetText: string | undefined,
): string {
  const who = reaction.fromUsername
    ? sanitizeReactionField(reaction.fromUsername)
    : "Someone";
  const verb = reaction.action === "added" ? "added" : "removed";
  const prep = reaction.action === "added" ? "to" : "from";
  const emoji = reaction.emoji ? sanitizeReactionField(reaction.emoji) : "a reaction";

  if (targetText && targetText.trim().length > 0) {
    const snippet = sanitizeReactionField(targetText).slice(0, REACTION_SNIPPET_MAX);
    return `[reaction] ${who} ${verb} ${emoji} ${prep} your message: "${snippet}"`;
  }
  return (
    `[reaction] ${who} ${verb} ${emoji} ${prep} your message #${sanitizeReactionField(
      reaction.targetMessageId,
    )} (text not on record — infer which message from recent conversation history)`
  );
}

/**
 * System-prompt suffix for a reaction turn. The turn is WAKE-BUT-SILENT:
 * the agent sees the reaction, records what it means, and stays quiet unless
 * something genuinely material warrants a message. See {@link runReactionTurn}.
 */
export const REACTION_INSTRUCTION =
  `# Emoji reaction (context, not a reply prompt)

The user reacted to one of your earlier messages with an emoji. This is
FEEDBACK, delivered to you as context — NOT a request for a reply.

Do two things:

1. Record it. Call \`phantombot memory capture\` with the emoji, which message
   it was on, and your best read of WHAT the user is signalling and WHY — e.g.
   "Andrew 👍'd the merged-PR summary → approved that outcome" or "Andrew 👎'd
   the refactor plan → he disagrees with that approach." Tag it \`lesson\` (or
   \`decision\` when it ratifies/rejects a choice). This is the whole point: the
   reasoning behind the reaction must be captured so future-you knows it.

2. Then STAY SILENT. Do NOT send a chat message. A reaction is ambient
   feedback; replying to every emoji is spam. Produce NO user-facing text —
   reply with exactly the single word SILENT and nothing else.

The ONLY exception: if the reaction clearly demands action (e.g. a 👎 on
something you just shipped that you should offer to fix/revert), you MAY send
one short message. Default hard to silence; speak only when it genuinely
matters.`;

/**
 * Sentinel a well-behaved model emits when it has nothing material to say.
 * Case-insensitive; also treated as silence: an empty/whitespace reply, or a
 * bare "[silent]". Matched in {@link isSilentReply}.
 */
export const REACTION_SILENCE_SENTINEL = "SILENT";

/** True when the model's reaction reply should be suppressed (no message sent). */
export function isSilentReply(finalText: string): boolean {
  const t = finalText.trim();
  if (t.length === 0) return true;
  return /^\[?silent\]?[.!]?$/i.test(t);
}

/** Everything {@link runReactionTurn} needs to run one wake-but-silent turn. */
export interface RunReactionTurnInput {
  reaction: ChannelReaction;
  /** Correlated text of the reacted-to message, if {@link RecentOutbound} had it. */
  targetText?: string;
  persona: string;
  /** Memory conversation key, e.g. `telegram:42` — the SAME key normal turns use. */
  conversation: string;
  agentDir: string;
  harnesses: Harness[];
  memory: MemoryStore;
  idleTimeoutMs: number;
  hardTimeoutMs?: number;
  startupTimeoutMs?: number;
  /**
   * Trust provenance — true only when the reactor is an allow-listed principal.
   * A reaction from the principal is trusted (so the capture can write memory);
   * an unauthenticated reaction should never reach here (channels gate first).
   */
  trusted: boolean;
  /** Deliver a material reply. Called ONLY when the model chose to speak. */
  send: (text: string) => Promise<void>;
  /** Optional instinct-layer retrieval (built by the channel), passed through. */
  retrieve?: import("../../orchestrator/turn.ts").TurnInput["retrieve"];
  /** Optional durable-fact pull, passed through. */
  pullFacts?: import("../../orchestrator/turn.ts").TurnInput["pullFacts"];
  signal?: AbortSignal;
}

/**
 * Run one wake-but-silent reaction turn. Deliberately LEAN vs. the full chat
 * dispatch: no streaming, no typing indicator, no interrupt/backlog wiring — a
 * reaction is a rare, low-stakes background nudge, so it runs off to the side
 * and only emits a message if the model decides the reaction is material.
 *
 * Returns the message it sent (for logging/tests), or undefined when it stayed
 * silent. Never throws: a reaction turn failing must not disturb the channel.
 */
export async function runReactionTurn(
  input: RunReactionTurnInput,
): Promise<string | undefined> {
  const envelope = formatReactionEnvelope(input.reaction, input.targetText);
  log.info("reaction: waking silent turn", {
    conversation: input.conversation,
    emoji: input.reaction.emoji,
    action: input.reaction.action,
    correlated: Boolean(input.targetText),
  });

  let finalText = "";
  let errored: string | undefined;
  try {
    for await (const chunk of runTurn({
      persona: input.persona,
      conversation: input.conversation,
      userMessage: envelope,
      agentDir: input.agentDir,
      // Interactive surface: the owner asks for work on repos all over their
      // home dir, so home stays the cwd. Explicit since #387 removed the
      // silent homedir() default in runTurn.
      workingDir: homedir(),
      harnesses: input.harnesses,
      memory: input.memory,
      idleTimeoutMs: input.idleTimeoutMs,
      hardTimeoutMs: input.hardTimeoutMs,
      startupTimeoutMs: input.startupTimeoutMs,
      signal: input.signal,
      trusted: input.trusted,
      // Reactions from the principal are trusted, so no threat screen. Pass
      // retrieval + fact pull through so the agent can interpret the reaction
      // against relevant memory/history; both are contracted never to throw.
      retrieve: input.retrieve,
      pullFacts: input.pullFacts,
      systemPromptSuffix: REACTION_INSTRUCTION,
      // No live channel to fill — the turn is silent by default.
      toolNarration: false,
    })) {
      if (chunk.type === "text") finalText += chunk.text;
      if (chunk.type === "done") finalText = chunk.finalText;
      if (chunk.type === "error") errored = chunk.error;
    }
  } catch (e) {
    errored = (e as Error).message;
  }

  if (errored) {
    log.warn("reaction: turn failed (staying silent)", {
      conversation: input.conversation,
      error: errored,
    });
    return undefined;
  }

  // Silence gate: the common case. Only a deliberately material reply escapes.
  if (isSilentReply(finalText)) {
    log.info("reaction: turn stayed silent", { conversation: input.conversation });
    return undefined;
  }

  try {
    await input.send(finalText.trim());
    log.info("reaction: surfaced a material reply", {
      conversation: input.conversation,
      chars: finalText.trim().length,
    });
    return finalText.trim();
  } catch (e) {
    log.warn("reaction: material reply send failed", {
      conversation: input.conversation,
      error: (e as Error).message,
    });
    return undefined;
  }
}
