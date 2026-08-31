import type { HistoryTurn } from "./types.ts";

/**
 * Minimal input required to render the user-side payload shared by stateless
 * harnesses. The serialization ordering is deliberate for cache/prefix reuse
 * only:
 *
 *   stable system prompt (owned by the harness) -> historical turns ->
 *   volatile per-turn context -> current user message
 *
 * Keeping volatile context after historical turns preserves the longest useful
 * serialized prefix available to downstream prompt caches while leaving
 * PhantomBot as the authoritative owner of conversation state. Prompt
 * position does not grant trust or authority to any content. This textual
 * prefix claim does not guarantee that a stateless harness/model can reuse the
 * immediately preceding generated assistant response: its chat-template role
 * transition may differ on the next request.
 */
export interface ConversationPayloadInput {
  history: readonly HistoryTurn[];
  /** Completed turns retained by the orchestrator's current cache epoch. */
  epochTurns?: readonly PromptEpochTurn[];
  /**
   * Volatile PhantomBot-provided context for this request only: retrieved
   * memory, durable facts, daily recall, timestamp/channel metadata, etc.
   * It MUST be rendered after history and before the current user message.
   */
  turnContext?: string;
  userMessage: string;
}

/**
 * Render prior conversation in the legacy PhantomBot format, then append the
 * volatile turn context and finally the current user message.
 *
 * This helper intentionally knows nothing about system prompts. Pi/Claude keep
 * their native system-prompt channel; Codex may prepend its system prompt in
 * its own adapter because its exec interface currently carries everything via
 * stdin.
 */
export function renderConversationPayload(
  input: ConversationPayloadInput,
): string {
  const parts: string[] = [];

  for (const turn of input.history) {
    if (turn.role === "user") {
      parts.push(turn.text);
    } else {
      parts.push(`<previous_response>\n${turn.text}\n</previous_response>`);
    }
  }

  for (const turn of input.epochTurns ?? []) {
    const turnContext = turn.turnContext.trim();
    if (turnContext) parts.push(turnContext);
    parts.push(turn.userMessage);
    parts.push(
      `<previous_response>\n${turn.assistantMessage}\n</previous_response>`,
    );
  }

  const turnContext = input.turnContext?.trim();
  if (turnContext) parts.push(turnContext);

  parts.push(input.userMessage);
  return parts.join("\n\n");
}

export interface PromptEpochTurn {
  /** Context supplied immediately before this historical user turn. */
  turnContext: string;
  userMessage: string;
  assistantMessage: string;
}
