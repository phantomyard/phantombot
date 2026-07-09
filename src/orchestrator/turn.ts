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
import { createAuditSink } from "../lib/auditLog.ts";
import {
  buildSystemPrompt,
  PRE_TOOL_NARRATION_INSTRUCTION,
} from "../persona/builder.ts";
import { loadPersona } from "../persona/loader.ts";
import type { Harness, HarnessChunk } from "../harnesses/types.ts";
import type { MemoryStore } from "../memory/store.ts";
import type { ScreenVerdict } from "./screen.ts";

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
  hardTimeoutMs?: number;
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
  /**
   * Security-perimeter provenance bit. True ONLY when an authenticated
   * allowed principal issued this turn (the Telegram channel sets it
   * after the allowed-user check passes). Defaults false/undefined for
   * every other entry point — `phantombot ask`, tick, nightly, voice —
   * so the system FAILS CLOSED.
   *
   * Two effects:
   *   1. It selects the SECURITY_PERIMETER prompt block (trusted = treat
   *      input as commands; untrusted = treat input as data to triage).
   *   2. It gates the threat screen below: trusted turns skip the screen
   *      entirely (the principal is the gate); untrusted turns are
   *      screened by the tool-less judge before any capable harness runs.
   */
  trusted?: boolean;
  /**
   * Optional threat screen for UNTRUSTED turns (built by
   * orchestrator/screen.ts#makeScreener). Called with the incoming user
   * message before the harness chain runs. If it returns a `hold`
   * verdict, runTurn does NOT run the harness — the request has already
   * been escalated to the principal (notify + audit happen inside the
   * screener, in code, so a model can't fake them). A `pass` verdict
   * lets the turn proceed normally and silently.
   *
   * Only consulted when `trusted !== true`. Trusted turns never screen.
   * Contracted to never throw; runTurn still guards defensively and
   * fails OPEN (proceeds) if the screen itself errors, so a judge/API
   * outage degrades to "unscreened" rather than "app down" — see the
   * design doc for why fail-open is the deliberate choice here.
   */
  screen?: (
    content: string,
    signal?: AbortSignal,
  ) => Promise<ScreenVerdict | undefined>;
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

  // Threat screen — runs BEFORE retrieval (Blocker B). For an UNTRUSTED turn,
  // the tool-less judge sees the content first; only a `pass` lets the turn go
  // on to pull the principal's private memory/kb into a prompt. This ordering
  // is the whole point: screening AFTER retrieval would let untrusted content
  // ride into a memory-laden prompt before anyone judged it — a memory-exfil
  // path where a low-scoring "summarise & reply" still leaks context. On a
  // `hold` the screener has already notified the principal and recorded the
  // audit IN CODE (a model can never fake "I escalated this"); we stop here
  // and NO retrieval ever happens. Trusted turns skip the screen entirely (the
  // authenticated principal is the gate). The screen contracts not to throw;
  // the catch is belt-and-suspenders and fails OPEN so a judge outage degrades
  // to "unscreened", never "app down".
  if (input.trusted !== true && input.screen) {
    let verdict: ScreenVerdict | undefined;
    try {
      verdict = await input.screen(input.userMessage, input.signal);
    } catch {
      verdict = undefined;
    }
    if (verdict?.action === "hold") {
      // NOTE: the screener already did the grounding write — it wrote the
      // held episode (quarantined payload + judge text) into the PRINCIPAL'S
      // telegram conversation, which is the correct scope (that's where the
      // approve/deny reply lands). We deliberately do NOT write anything here:
      // this entry point's conversation is the wrong one to ground against.
      // See orchestrator/screen.ts (recordHeld + the conversation-scoping
      // comment). We just surface the held message and stop.
      const held =
        verdict.heldMessage ??
        "🔒 This request touched something sensitive, so I've paused it and asked the owner to confirm. Nothing was done.";
      yield { type: "text", text: held };
      yield { type: "done", finalText: held, meta: { screenedHold: true } };
      return;
    }
  }

  // Instinct layer: pull relevant memory/kb for this message and inject it
  // into the prompt's "Retrieved context" slot. Belt-and-suspenders try/catch
  // — the retriever already swallows its own errors, but a turn must never
  // die on retrieval. Reached only for trusted turns or untrusted turns that
  // PASSED the screen above.
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
      trusted: input.trusted === true,
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

  // Tool-call audit (#282): default-on, writes to `<agentDir>/audit/<date>.log`.
  // Every runTurn caller (Telegram, phantomchat, ask, tick, nightly, ACP) gets
  // it for free; the sink self-disables when PHANTOMBOT_AUDIT_TOOL_CALLS is off.
  const auditSink = createAuditSink(input.agentDir);

  for await (const chunk of runWithFallback(
    input.harnesses,
    {
      systemPrompt,
      userMessage: input.userMessage,
      history,
      persona: input.persona,
      conversation: input.conversation,
      workingDir: input.workingDir ?? homedir(),
      idleTimeoutMs: input.idleTimeoutMs,
      hardTimeoutMs: input.hardTimeoutMs,
      signal: input.signal,
    },
    { onToolCall: auditSink },
  )) {
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
    await input.memory.appendTurnPair(
      {
        persona: input.persona,
        conversation: input.conversation,
        role: "user",
        text: input.userMessage,
      },
      {
        persona: input.persona,
        conversation: input.conversation,
        role: "assistant",
        text: finalText,
      },
    );

    // Purge-after-ruling. On a TRUSTED turn that SUCCEEDS, drop any
    // quarantined held-payload rows in THIS conversation. Rationale: by the
    // time the principal has taken a trusted turn here, the held untrusted
    // payload has already been replayed into context once (this very turn),
    // grounding their approve/deny, and the agent has had its chance to
    // record the ruling — the judge-reasoning turn (embeddable assistant
    // turn) and any `memory capture --tag decision` are KEPT; only the raw
    // verbatim untrusted payload (embeddable=0) is dropped. Deliberate
    // tradeoff: the raw payload is retained for grounding for exactly one
    // trusted turn, then purged so verbatim untrusted text isn't kept long-
    // term. Best-effort: a purge failure must never break the turn.
    // purgeQuarantined is a no-op (returns 0) when there are no quarantined
    // rows, so calling it unconditionally on trusted success is safe.
    if (input.trusted === true) {
      try {
        await input.memory.purgeQuarantined(input.persona, input.conversation);
      } catch {
        // Quarantine cleanup must never turn a successful reply into an error.
      }
    }

    if (input.indexTurns) {
      try {
        await input.indexTurns();
      } catch {
        // Derived indexing must never turn a successful reply into an error.
      }
    }
  }
}
