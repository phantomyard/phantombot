/**
 * Post-failure recovery reply.
 *
 * When the harness chain is exhausted on a *recoverable* failure — most
 * often a wedged tool call tripping the idle timeout — the channel must
 * NOT surface the raw internal diagnostic (e.g. "claude timed out after
 * 300000ms with no output ..."). Those strings are English-only and read
 * to the user like a crash.
 *
 * Instead we re-prompt the chain ONCE for a short, human reply that tells
 * the user, in the language of their own message, that the turn hit a snag
 * and to try again. Because it's a real model reply rather than a hardcoded
 * constant, it matches the conversation's language and the persona's tone —
 * which is the whole point: a canned English line is fine for English
 * speakers and alienating for everyone else.
 *
 * Guarantees:
 *   - Bounded: short idle/hard caps so a second wedge can't double the
 *     latency the user already sat through on the failed turn.
 *   - Fresh chain: runs with its own CooldownStore so the failed turn's
 *     cooldown bookkeeping doesn't force recovery onto the weakest harness.
 *   - Non-recursive: a single runWithFallback pass. If it also fails we
 *     return undefined and the caller stays silent — the original
 *     diagnostic is already in the journal via the orchestrator's logs.
 *   - Tool-free by instruction: the prompt forbids tools, so recovery
 *     won't re-trigger the same wedged call.
 */

import { homedir } from "node:os";

import { runWithFallback } from "./fallback.ts";
import type { Harness } from "../harnesses/types.ts";
import { CooldownStore } from "../lib/cooldown.ts";
import { log } from "../lib/logger.ts";

/**
 * Bounded budget for the recovery turn. It only has to emit a sentence or
 * two, so keep it tight — the user has already waited out the failed turn's
 * full idle window and we don't want to compound that.
 */
const RECOVERY_IDLE_TIMEOUT_MS = 30_000;
const RECOVERY_HARD_TIMEOUT_MS = 60_000;

export interface RecoveryReplyInput {
  /** The harness chain the failed turn used. */
  harnesses: Harness[];
  /** The user's original message — carries the language to mirror. */
  userMessage: string;
  /** Persona display name, for light tone framing. Optional. */
  personaName?: string;
  /** Subprocess working dir. Defaults to the running user's home. */
  workingDir?: string;
  /** Abort signal — a new inbound message should cancel recovery too. */
  signal?: AbortSignal;
}

function recoverySystemPrompt(personaName?: string): string {
  const who = personaName
    ? `You are ${personaName}, the user's personal assistant.`
    : `You are the user's personal assistant.`;
  return [
    who,
    "",
    "Your previous attempt to answer the user's last message got stuck on",
    "an internal step and was aborted before you could reply. Nothing was",
    "sent to them yet.",
    "",
    "Write a brief, warm reply — one or two sentences — telling the user you",
    "hit a snag and didn't get through this time, and asking them to try",
    "again. Reply in the SAME LANGUAGE as the user's message below.",
    "",
    "Hard rules:",
    "- Do NOT use any tools. Just write the message.",
    "- Do NOT mention timeouts, subprocesses, errors, or any technical detail.",
    "- Do NOT try to answer their actual question — you don't have an answer.",
    "- Keep it short and human; no long apologies.",
  ].join("\n");
}

/**
 * Generate the recovery message. Returns the trimmed text, or undefined if
 * even the recovery turn failed (caller then stays silent).
 */
export async function generateRecoveryReply(
  input: RecoveryReplyInput,
): Promise<string | undefined> {
  if (input.signal?.aborted) return undefined;
  if (input.harnesses.length === 0) return undefined;

  let text = "";
  try {
    for await (const chunk of runWithFallback(
      input.harnesses,
      {
        systemPrompt: recoverySystemPrompt(input.personaName),
        userMessage: input.userMessage,
        history: [],
        workingDir: input.workingDir ?? homedir(),
        idleTimeoutMs: RECOVERY_IDLE_TIMEOUT_MS,
        hardTimeoutMs: RECOVERY_HARD_TIMEOUT_MS,
        signal: input.signal,
      },
      // Fresh cooldown state: the failed turn just marked harnesses down,
      // and we want recovery to try the primary harness first rather than
      // inherit that penalty.
      { cooldown: new CooldownStore() },
    )) {
      if (chunk.type === "text") text += chunk.text;
      if (chunk.type === "done") {
        if (chunk.finalText.length > 0) text = chunk.finalText;
      }
      if (chunk.type === "error") {
        log.warn("recovery: reply generation failed", { error: chunk.error });
        return undefined;
      }
    }
  } catch (e) {
    log.warn("recovery: reply generation threw", {
      error: (e as Error).message,
    });
    return undefined;
  }

  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
