/**
 * Single-turn coordinator.
 *
 * Given a user message + a configured persona / harness chain / memory store,
 * runTurn:
 *   1. Loads the persona files from disk.
 *   2. Loads the most recent N turns from memory (skipped if noHistory).
 *   3. Builds the system prompt via persona/builder.
 *   4. Runs the harness chain via orchestrator/fallback, streaming chunks
 *      out to the caller as they arrive.
 *   5. On success — and only on success — persists the user turn followed
 *      by the assistant turn to memory. A failed turn leaves no trace,
 *      so the user can retry without polluting history with half-turns.
 *
 * runTurn is an async generator of HarnessChunk. The caller iterates,
 * surfaces text/progress to wherever (stdout, REPL, future channel
 * adapter), and persistence happens as a side effect when the stream ends.
 *
 * Errors that aren't part of the harness stream (persona missing, memory
 * write failed) propagate as thrown exceptions — the caller is expected
 * to catch them and present cleanly.
 */

import { runWithFallback } from "./fallback.ts";
import { buildSystemPrompt } from "../persona/builder.ts";
import { loadPersona } from "../persona/loader.ts";
import type { Harness, HarnessChunk } from "../harnesses/types.ts";
import type { MemoryStore } from "../memory/store.ts";

export interface TurnInput {
  /** Persona name — used for memory scoping and log clarity. */
  persona: string;
  /** Conversation key — e.g. "cli:default", "telegram:42". */
  conversation: string;
  /** The new user message. */
  userMessage: string;
  /** Path to the persona directory (BOOT.md / SOUL.md / IDENTITY.md etc. live here). */
  agentDir: string;
  /** Harness chain in priority order; first that succeeds wins. */
  harnesses: Harness[];
  /** Open memory store; runTurn appends to it on success. */
  memory: MemoryStore;
  /** Per-harness timeout. */
  timeoutMs: number;
  /** Number of prior turns to load. Default 20. */
  historyLimit?: number;
  /** Skip loading prior turns AND skip persisting this one. Default false. */
  noHistory?: boolean;
}

export async function* runTurn(input: TurnInput): AsyncGenerator<HarnessChunk> {
  const persona = await loadPersona(input.agentDir);

  const history = input.noHistory
    ? []
    : await input.memory.recentTurns(
        input.persona,
        input.conversation,
        input.historyLimit ?? 20,
      );

  const systemPrompt = buildSystemPrompt(
    persona,
    {
      channel: "cli",
      conversationId: input.conversation,
      timestamp: new Date(),
    },
    undefined, // vector-search retrieval reserved for a later phase
  );

  let finalText = "";
  let succeeded = false;

  for await (const chunk of runWithFallback(input.harnesses, {
    systemPrompt,
    userMessage: input.userMessage,
    history,
    workingDir: input.agentDir,
    timeoutMs: input.timeoutMs,
  })) {
    if (chunk.type === "text") finalText += chunk.text;
    if (chunk.type === "done") {
      // The done chunk carries the authoritative finalText — prefer it
      // over our running accumulation in case the harness reformatted.
      finalText = chunk.finalText;
      succeeded = true;
    }
    yield chunk;
  }

  if (succeeded && !input.noHistory) {
    await input.memory.appendTurn({
      persona: input.persona,
      conversation: input.conversation,
      role: "user",
      text: input.userMessage,
    });
    await input.memory.appendTurn({
      persona: input.persona,
      conversation: input.conversation,
      role: "assistant",
      text: finalText,
    });
  }
}
