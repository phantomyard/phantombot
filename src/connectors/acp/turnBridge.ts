/**
 * Shared trusted-runTurn driver for editor connectors.
 *
 * This is the seam a future VS Code connector reuses: given a flattened
 * prompt (instruction + optional reference data), it drives ONE `runTurn`
 * with `trusted: true` and translates the harness's `HarnessChunk` stream
 * into ACP `session/update` notifications.
 *
 * TRUST: `trusted: true` is set HERE — the connector layer is the trust
 * boundary. The principal is the local OS user who launched the editor; they
 * already have full filesystem access to everything phantombot owns, so the
 * tool-less threat judge is skipped (see orchestrator/turn.ts — the screen is
 * only consulted when `trusted !== true`). The connector NEVER exposes a
 * "trusted" flag to the wire; it's a property of the local-CLI entry point.
 *
 * INSTRUCTION/DATA SPLIT: `userMessage` is the user's typed text (the trusted
 * instruction). `systemPromptSuffix` carries @-mentioned file context as
 * clearly-labelled reference DATA — kept SEPARATE, never concatenated into the
 * instruction. A malicious comment in a mentioned file can't become part of
 * the trusted command.
 *
 * Phantombot owns memory/context: runTurn loads the last-N window for the
 * conversation and persists the turn on success. The editor sends only the new
 * message each turn — never the transcript.
 */

import { homedir } from "node:os";

import type { Harness, HarnessChunk } from "../../harnesses/types.ts";
import type { MemoryStore } from "../../memory/store.ts";
import { runTurn, type TurnInput } from "../../orchestrator/turn.ts";
import type { ScreenVerdict } from "../../orchestrator/screen.ts";
import type { AcpStopReason } from "./protocol.ts";

export interface BridgeTurnInput {
  /** Persona for this turn. */
  persona: string;
  /** Conversation key (acp:<hash>) — phantombot's memory scope. */
  conversation: string;
  /** The user's typed text — trusted instruction. */
  userMessage: string;
  /** Persona directory (BOOT.md / SOUL.md live here). */
  agentDir: string;
  /** Workspace cwd — harness subprocess working dir. */
  workingDir?: string;
  /** Resolved harness chain. */
  harnesses: Harness[];
  /** Open memory store. */
  memory: MemoryStore;
  idleTimeoutMs: number;
  hardTimeoutMs?: number;
  /** @-mentioned reference data, kept separate from the instruction. */
  systemPromptSuffix?: string;
  /** Cancellation signal (session/cancel fires this). */
  signal?: AbortSignal;
  /**
   * TEST SEAM ONLY. Production NEVER sets this — a trusted turn must never
   * screen, and `runTurn` enforces that (`trusted !== true && screen`). Tests
   * inject a spy here to PROVE the threat judge is never consulted on an ACP
   * turn: if the bridge ever set `trusted` to anything but true, runTurn would
   * call this spy and the assertion would fail.
   */
  screen?: (
    content: string,
    signal?: AbortSignal,
  ) => Promise<ScreenVerdict | undefined>;
}

/** Sink the bridge streams ACP updates + the final stop reason through. */
export interface BridgeSink {
  /** Stream an assistant text delta (→ agent_message_chunk). */
  text(delta: string): void;
  /** A presentational progress note (→ minimal tool_call update). */
  progress(note: string): void;
}

/**
 * Drive one trusted turn. Streams text/progress through `sink` and RESOLVES
 * with the ACP stop reason — never throws for harness-level failures:
 *   - `done`  → "end_turn"
 *   - `error` → emit the error text, "refusal"
 *   - abort   → "cancelled"
 *
 * A thrown exception (persona load failure, memory write failure) propagates;
 * the caller maps it to a JSON-RPC error.
 */
export async function runBridgeTurn(
  input: BridgeTurnInput,
  sink: BridgeSink,
): Promise<AcpStopReason> {
  // `trusted: true` is set HERE — the connector is the trust boundary.
  const turnInput: TurnInput = {
    persona: input.persona,
    conversation: input.conversation,
    userMessage: input.userMessage,
    agentDir: input.agentDir,
    workingDir: input.workingDir ?? homedir(),
    harnesses: input.harnesses,
    memory: input.memory,
    idleTimeoutMs: input.idleTimeoutMs,
    hardTimeoutMs: input.hardTimeoutMs,
    systemPromptSuffix: input.systemPromptSuffix,
    // Stream-first surface (Zed renders deltas live) → narrate before tools.
    toolNarration: true,
    trusted: true,
    signal: input.signal,
    // Forwarded ONLY so tests can prove it's never consulted on a trusted
    // turn. runTurn ignores it whenever trusted === true.
    screen: input.screen,
  };

  let sawError = false;

  for await (const chunk of runTurn(turnInput) as AsyncGenerator<HarnessChunk>) {
    if (chunk.type === "text") {
      sink.text(chunk.text);
    } else if (chunk.type === "progress") {
      sink.progress(chunk.note);
    } else if (chunk.type === "error") {
      sawError = true;
      sink.text(`\n[error] ${chunk.error}`);
    }
    // `done` / `heartbeat` need no per-chunk action here; the loop ending is
    // the turn's natural completion.
  }

  if (input.signal?.aborted) return "cancelled";
  if (sawError) return "refusal";
  return "end_turn";
}
