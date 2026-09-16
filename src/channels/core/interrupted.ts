/**
 * Persist the user's message when a channel turn is aborted before it finished.
 *
 * runTurn only writes history on success, so a /stop (or an interrupting new
 * message) used to drop the user's message on the floor: the next turn had no
 * referent for "actually, use blue" and the model could not see what it had
 * been asked. Telegram grew an inline fix for this; PhantomChat never did, so
 * on 2026-09-16 a stopped "yes, apply it to all 7" vanished and the next reply
 * asked whether the owner had meant to approve a change that had already run.
 * One helper now serves both channels so they cannot drift again.
 */

import { log } from "../../lib/logger.ts";
import type { MemoryStore } from "../../memory/store.ts";

export const INTERRUPTED_MARKER = "[interrupted before reply]";

export interface InterruptedTurnInput {
  memory: Pick<MemoryStore, "appendTurnPair">;
  persona: string;
  conversation: string;
  /** Abort reason ("stop" | "reset" | "interrupt" | …). */
  reason: string;
  /** The user message exactly as runTurn received it. */
  userMessage: string;
  /** Text the harness had already streamed before the abort, if any. */
  partialReply?: string;
  /** Whether the sender was the authenticated principal. */
  trusted: boolean;
  /** Log label, e.g. "telegram" / "phantomchat". */
  channel: string;
}

/**
 * Write a synthetic user+assistant pair for an aborted turn. The assistant
 * side carries whatever was already streamed plus the interrupted marker, so
 * the next turn knows both what was asked and how far the reply got.
 *
 * Skipped when:
 *   - reason === "reset": /reset just cleared the context window; a turn
 *     written now lands above the reset watermark and reappears immediately.
 *   - the user message is empty (voice aborted before STT finished).
 *
 * Never throws: persistence is best-effort on an already-failed turn.
 * Returns true when a pair was written.
 */
export async function persistInterruptedTurn(
  input: InterruptedTurnInput,
): Promise<boolean> {
  if (input.reason === "reset") return false;
  if (input.userMessage.trim().length === 0) return false;
  const partial = (input.partialReply ?? "").trim();
  const assistantText = partial
    ? `${partial}\n\n${INTERRUPTED_MARKER}`
    : INTERRUPTED_MARKER;
  try {
    await input.memory.appendTurnPair(
      {
        persona: input.persona,
        conversation: input.conversation,
        role: "user",
        text: input.userMessage,
        source: input.trusted ? "principal" : "other",
        origin: "channel",
      },
      {
        persona: input.persona,
        conversation: input.conversation,
        role: "assistant",
        text: assistantText,
        source: "unverified",
        origin: "channel",
      },
    );
    return true;
  } catch (e) {
    log.warn(`${input.channel}: failed to persist interrupted-pair`, {
      conversation: input.conversation,
      error: (e as Error).message,
    });
    return false;
  }
}
