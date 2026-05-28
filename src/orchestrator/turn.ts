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

import { homedir } from "node:os";

import { runWithFallback } from "./fallback.ts";
import {
  buildSystemPrompt,
  PRE_TOOL_NARRATION_INSTRUCTION,
} from "../persona/builder.ts";
import { loadPersona } from "../persona/loader.ts";
import type { Harness, HarnessChunk } from "../harnesses/types.ts";
import type { MemoryStore } from "../memory/store.ts";

export const DEFAULT_HISTORY_LIMIT = 30;

export interface TurnInput {
  /** Persona name — used for memory scoping and log clarity. */
  persona: string;
  /** Conversation key — e.g. "cli:default", "telegram:42". */
  conversation: string;
  /** The new user message. */
  userMessage: string;
  /** Path to the persona directory (BOOT.md / SOUL.md / IDENTITY.md etc. live here). */
  agentDir: string;
  /**
   * cwd for harness subprocesses. Defaults to the running user's home
   * dir. Set to `agentDir` (or anything else) to scope down. Affects:
   *   - pi:     where relative-path tools resolve (no sandbox).
   *   - claude: same + the "trusted dir" framing for the workspace.
   *   - gemini: the *workspace sandbox root* — gemini hard-rejects tool
   *             calls that touch paths outside cwd + its temp dir.
   * Persona files load via absolute paths regardless of this setting.
   */
  workingDir?: string;
  /** Harness chain in priority order; first that succeeds wins. */
  harnesses: Harness[];
  /** Open memory store; runTurn appends to it on success. */
  memory: MemoryStore;
  /** Kill subprocess after this long with no chunk on stdout. Resets per chunk. */
  idleTimeoutMs: number;
  /** Hard wall-clock ceiling regardless of activity. */
  hardTimeoutMs: number;
  /** Number of prior turns to load. Default 30. */
  historyLimit?: number;
  /** Skip loading prior turns AND skip persisting this one. Default false. */
  noHistory?: boolean;
  /** Extra text appended to the system prompt. Used by nightly to inject distillation directives. */
  systemPromptSuffix?: string;
  /**
   * Append PRE_TOOL_NARRATION_INSTRUCTION to the system prompt — asks
   * the model to say one short sentence before each tool call so
   * streaming channels have something to render during the silence
   * while a tool runs.
   *
   * Off by default. Channels that stream assistant text in real time
   * should set this true:
   *   - Telegram text-in/text-out (text streams as it lands)
   *   - `phantombot ask --stream` (stdout flushes per text chunk;
   *     Twilio's voice relay tee'd off this)
   *
   * Leave false for one-shot consumers — the CLI's `ask` (no stream),
   * nightly distillation, the heartbeat — where there's no live
   * channel to fill silence on.
   *
   * Telegram voice-in/voice-out should also leave this false: the
   * voice reply is one synthesized clip at the end, not a stream, so
   * narration would just bloat the spoken output.
   */
  toolNarration?: boolean;
  /** External abort signal from channel layer (e.g. /stop command). Propagated to harnesses. */
  signal?: AbortSignal;
  /**
   * Optional turn-time auto-retrieval. When provided, runTurn calls it with
   * the incoming user message before building the system prompt and injects
   * whatever it returns into the "Retrieved context for this turn" slot —
   * the instinct layer that surfaces relevant memory/kb without the agent
   * having to search by hand.
   *
   * Built by `orchestrator/retrieval.ts#makeRetriever`. Contracted to never
   * throw (it swallows its own failures and returns undefined); runTurn
   * still guards defensively so a misbehaving retriever can't break a turn.
   *
   * Omitted by system turns (tick, nightly) so their prompts stay clean.
   */
  retrieve?: (
    query: string,
    signal?: AbortSignal,
  ) => Promise<string | undefined>;
  /**
   * Optional post-persist hook. Used by the conversation-turn indexer to
   * backfill searchable old turns on a cadence. Must never break a turn.
   */
  indexTurns?: () => Promise<void>;
}

export async function* runTurn(input: TurnInput): AsyncGenerator<HarnessChunk> {
  const persona = await loadPersona(input.agentDir);

  const history = input.noHistory
    ? []
    : await input.memory.recentTurns(
        input.persona,
        input.conversation,
        input.historyLimit ?? DEFAULT_HISTORY_LIMIT,
      );

  // Instinct layer: pull relevant memory/kb for this message and inject it
  // into the prompt's "Retrieved context" slot. Belt-and-suspenders try/catch
  // — the retriever already swallows its own errors, but a turn must never
  // die on retrieval.
  let retrievedMemory: string | undefined;
  if (input.retrieve) {
    try {
      retrievedMemory = await input.retrieve(input.userMessage, input.signal);
    } catch {
      retrievedMemory = undefined;
    }
  }

  const baseSystemPrompt = buildSystemPrompt(
    persona,
    {
      channel: "cli",
      conversationId: input.conversation,
      timestamp: new Date(),
    },
    retrievedMemory,
  );
  // Channel-layer overlays in append order:
  //   1. systemPromptSuffix — caller-provided (e.g. Telegram's
  //      reply-style + voice-brevity rules; nightly's distillation
  //      directives).
  //   2. PRE_TOOL_NARRATION_INSTRUCTION — opt-in via toolNarration,
  //      added LAST so its directive sits closest to the user message
  //      and is the most prominent format-of-reply rule the model sees.
  const overlays: string[] = [];
  if (input.systemPromptSuffix) overlays.push(input.systemPromptSuffix);
  if (input.toolNarration) overlays.push(PRE_TOOL_NARRATION_INSTRUCTION);
  const systemPrompt =
    overlays.length > 0
      ? baseSystemPrompt + "\n\n" + overlays.join("\n\n")
      : baseSystemPrompt;

  let finalText = "";
  let succeeded = false;

  for await (const chunk of runWithFallback(input.harnesses, {
    systemPrompt,
    userMessage: input.userMessage,
    history,
    workingDir: input.workingDir ?? homedir(),
    idleTimeoutMs: input.idleTimeoutMs,
    hardTimeoutMs: input.hardTimeoutMs,
    signal: input.signal,
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
    if (input.indexTurns) {
      try {
        await input.indexTurns();
      } catch {
        // Derived indexing must never turn a successful reply into an error.
      }
    }
  }
}
