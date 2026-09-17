/**
 * The engine behind screen 0 (chat) — deliberately free of React so it can be
 * tested with a fake harness and reused verbatim by the `--no-tui` line-mode
 * REPL.
 *
 * ## This is a real turn, not a simulator
 *
 * Same harness chain, same memory, same tools, same journal as a Telegram
 * message. It threads history through the memory store like any other channel,
 * so leaving for the dashboard and coming back shows the same conversation —
 * and so does closing the app and reopening it tomorrow. Scrollback IS the
 * conversation store; nothing here keeps a second copy.
 *
 * ## Trust
 *
 * These turns are `trusted: true`, the same tier as an allow-listed Telegram
 * principal, and the reasoning has to be explicit because the perimeter is
 * enforced in code and not by convention (AGENTS.md, "Security perimeter"):
 *
 *   - The speaker is a human at a local TTY on the host, in the account that
 *     owns the persona directory. They can already read `identity.json`, and
 *     therefore already hold the key to every secret in the vault. Screening
 *     their typing adds no security whatsoever.
 *   - The failure mode of getting it wrong the other way is severe: every
 *     message the owner types would be judged by the threat classifier, and
 *     any that scored high would be HELD — the owner would be locked out of
 *     their own phantom by a screen designed to protect them from strangers.
 *
 * This does not widen the perimeter for anything else. `phantombot ask` stays
 * untrusted; a pipe is not a TTY, and `startChat` is only reachable from the
 * TTY-gated bare invocation (`lib/tuiGate.ts`).
 */

import { homedir } from "node:os";

import type { Config } from "../config.ts";
import { personaDir } from "../config.ts";
import {
  handleSlashCommand,
  type ActiveTurnHandle,
} from "../channels/commands.ts";
import type { ServiceControl } from "../lib/systemd.ts";
import {
  isKnownCommand,
  isUnknownCommand,
  unknownCommandReply,
} from "./slash.ts";
import { buildHarnessChain } from "../harnesses/buildChain.ts";
import type { Harness } from "../harnesses/types.ts";
import { resolveHarnessBinsForConfig } from "../lib/harnessAvailability.ts";
import { openMemoryStore, type MemoryStore } from "../memory/store.ts";
import { runTurn } from "../orchestrator/turn.ts";
import {
  abortReasonString,
  persistInterruptedTurn,
} from "../channels/core/interrupted.ts";
import { makeRetriever } from "../orchestrator/retrieval.ts";
import { makeTurnIndexer } from "../orchestrator/turnIndexer.ts";
import {
  makeDurableFactPuller,
  makeFactExtractor,
} from "../orchestrator/durableFacts.ts";

/**
 * Conversation key for the terminal. One per persona, stable across restarts,
 * namespaced so it can never collide with `cli:ask` (stateless) or a channel
 * key.
 */
export function tuiConversationKey(persona: string): string {
  return `cli:tui:${persona}`;
}

export interface ChatToolCall {
  title: string;
  startedAt: number;
  /** Filled in when the next chunk arrives — a call has no explicit end event. */
  durationMs?: number;
}

/**
 * One entry of an assistant message's ordered timeline.
 *
 * Narration text runs and tool calls, in the order they actually happened.
 * The flat `tools` + `text` model above loses that order at the data-model
 * level (the renderer then draws every tool above the whole reply, and the
 * narration runs jam into one block), so the streaming path records `parts`
 * instead and the transcript walks them in order.
 */
export type ChatMessagePart =
  | { kind: "text"; text: string }
  | { kind: "tool"; title: string; startedAt: number; durationMs?: number };

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  at: number;
  /** Assistant only: the tool calls made while producing this reply. */
  tools?: ChatToolCall[];
  /**
   * Assistant only: the ordered narration/tool timeline (see
   * `ChatMessagePart`). History replayed from the memory store carries only
   * `text` and renders via the legacy tools-then-text path.
   */
  parts?: ChatMessagePart[];
  /** Assistant only: set when the turn failed, so the UI can say so. */
  error?: string;
}

/** A handled slash command: what to print, and what to do after printing it. */
export interface ChatCommandResult {
  reply: string;
  /**
   * Runs strictly AFTER the reply is on screen — `/update` and `/restart` use
   * it to bounce the service, and doing that before the text lands means the
   * user watches the app die having been told nothing.
   */
  afterSend?: () => Promise<void>;
}

export interface ChatSession {
  persona: string;
  conversation: string;
  /** Prior turns, oldest first, loaded from the memory store on open. */
  history: ChatMessage[];
  /** Run one user message. Yields UI events as the turn streams. */
  send(text: string, signal?: AbortSignal): AsyncGenerator<ChatEvent>;
  /**
   * Run a slash command, or return null when this text is not one and must go
   * to the harness instead (phantombot#480).
   *
   * Delegates to the shared dispatcher, so `/stop` here aborts the same way it
   * does on Telegram — including while a turn is streaming, which is exactly
   * when you need it and exactly when the harness cannot answer.
   */
  command(text: string): Promise<ChatCommandResult | null>;
  /**
   * Rebuild the harness chain from a freshly loaded config.
   *
   * The chain is resolved ONCE when the session opens, and the session
   * deliberately outlives every screen switch so the thread survives a trip to
   * settings. That combination is what made "configure the brain, come back,
   * get empty replies": the chat kept talking to the chain that existed
   * BEFORE the brain was configured — on a fresh install, the default `claude`
   * that isn't installed — so every turn died on an unavailable harness while
   * config.toml on disk said `pi`.
   *
   * So any write that can change the chain must call this. It mutates the
   * session in place rather than reopening it, because reopening resets the
   * transcript. Returns the new chain's ids for the caller to report.
   */
  reloadHarnesses(config: Config): Promise<string[]>;
  close(): Promise<void>;
}

export type ChatEvent =
  /** A slice of assistant text. Append it; do not replace. */
  | { type: "text"; text: string }
  /** A tool call started. `index` addresses it for the later duration update. */
  | { type: "tool"; index: number; title: string }
  /** The previous tool call finished, `ms` after it started. */
  | { type: "tool-done"; index: number; ms: number }
  /** The harness is alive but has produced nothing yet. */
  | { type: "thinking" }
  /**
   * Narration-decay replay (issue #551): model-written reasoning surfaced as
   * liveness. Shown on the activity line only — never a transcript row or a
   * tool entry, and never persisted into the final reply.
   */
  | { type: "reasoning"; text: string }
  | { type: "done"; text: string }
  | { type: "error"; message: string };

export interface OpenChatInput {
  config: Config;
  persona: string;
  /** How many prior turns to show on open. */
  historyLimit?: number;
  /**
   * Where harness stderr goes.
   *
   * NOT `process.stderr` by default when the TUI is driving: the harness writes
   * diagnostics to the same terminal the app is drawing on, so its output lands
   * on top of the frame — the "logs underneath the box" the user sees. The TUI
   * passes the log buffer here; the REPL and tests can pass anything.
   */
  stderr?: { write(chunk: string): void };
  /**
   * The directory turns run in. Interactive launches pass the launch cwd (see
   * lib/launchCwd.ts, issue #575); anything that leaves it unset keeps the
   * home directory.
   */
  workingDir?: string;
  /** Test seams. */
  memory?: MemoryStore;
  harnesses?: Harness[];
  /**
   * Injected by tests so a `/restart` in the suite never bounces the
   * developer's own phantombot.service. Production leaves it undefined and the
   * dispatcher picks up `defaultServiceControl()`.
   */
  serviceControl?: ServiceControl;
}

export async function openChat(input: OpenChatInput): Promise<ChatSession> {
  let config = input.config;
  const persona = input.persona;
  const agentDir = personaDir(config, persona);
  const conversation = tuiConversationKey(persona);

  let harnesses = input.harnesses;
  if (!harnesses) {
    // Resolve against the live filesystem exactly as `run` and `ask` do, so a
    // PATH-relative harness still starts when phantombot was launched from a
    // narrow environment.
    ({ config } = await resolveHarnessBinsForConfig(config));
    harnesses = buildHarnessChain(
      config,
      input.stderr ?? process.stderr,
      persona,
    );
  }

  const memory = input.memory ?? (await openMemoryStore(config.memoryDbPath));
  const ownsMemory = !input.memory;
  const startedAt = Date.now();
  /**
   * The turn in flight, for `/stop` and for `/status`'s "what is it doing".
   *
   * The screen owns a controller too (it is what `^c` aborts), so the session
   * keeps its OWN and forwards the screen's abort into it. Two entry points to
   * one interrupt: without this, `/stop` would have nothing to abort, because
   * an `AbortSignal` cannot be aborted by whoever merely holds it.
   */
  let activeTurn: ActiveTurnHandle | undefined;

  const prior = await memory.recentTurnsForConversationDisplay(
    persona,
    conversation,
    input.historyLimit ?? 40,
  );
  // Replayed turns keep the time they actually happened. `at: 0` here is what
  // made the transcript "lose" every timestamp the moment the app restarted:
  // the rows were fine, they just had no clock on them. Date.parse of a bad or
  // missing stamp is NaN, so fall back to 0 (renders as no time) rather than
  // 1970.
  const history: ChatMessage[] = prior.map((turn) => {
    const at = turn.createdAt?.getTime?.() ?? NaN;
    return {
      role: turn.role === "user" ? ("user" as const) : ("assistant" as const),
      text: turn.text,
      at: Number.isFinite(at) ? at : 0,
    };
  });

  async function* send(
    text: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatEvent> {
    if (harnesses!.length === 0) {
      yield {
        type: "error",
        message:
          "No harness available. Open settings (ctrl+s) → the phantom's Brain to pick one.",
      };
      return;
    }
    const tools: ChatToolCall[] = [];
    let final = "";
    // True once runTurn reported completion, which is also when it wrote the
    // turn to history. An abort that lands after that must not write a second,
    // "interrupted" copy of a turn that actually finished.
    let completed = false;
    const controller = new AbortController();
    if (signal) {
      // Forward the REASON too ("stop" / "interrupt" / "reset"): the
      // interrupted-turn writer skips "reset", and a bare abort() would fold
      // every cause into "aborted".
      if (signal.aborted) controller.abort(signal.reason);
      else
        signal.addEventListener("abort", () => controller.abort(signal.reason), {
          once: true,
        });
    }
    /**
     * Keep the user's message when the turn is stopped (^c, `/stop`) or
     * superseded by a new message. runTurn only writes history on success, so
     * without this the terminal forgot what it had been asked, exactly the
     * PhantomChat loss of 2026-09-16. Shared helper: see core/interrupted.ts.
     */
    const persistIfInterrupted = async (): Promise<boolean> => {
      if (!controller.signal.aborted || completed) return false;
      await persistInterruptedTurn({
        memory,
        persona,
        conversation,
        reason: abortReasonString(controller.signal.reason),
        userMessage: text,
        partialReply: final,
        trusted: true,
        channel: "tui",
      });
      return true;
    };
    activeTurn = { controller, startTime: Date.now() };
    try {
      for await (const chunk of runTurn({
        persona,
        conversation,
        userMessage: text,
        agentDir,
        // The directory the TUI was launched from (issue #575), resolved once
        // at startup; home when the caller did not say.
        workingDir: input.workingDir ?? homedir(),
        harnesses: harnesses!,
        memory,
        idleTimeoutMs: config.harnessIdleTimeoutMs,
        hardTimeoutMs: config.harnessHardTimeoutMs,
        toolTimeoutMs: config.harnessToolTimeoutMs,
        thinkingTimeoutMs: config.harnessThinkingTimeoutMs,
        // A terminal conversation is a conversation: history, retrieval,
        // durable facts and turn indexing all behave as they do on Telegram.
        noHistory: false,
        retrieve: makeRetriever(config, persona, agentDir, conversation),
        indexTurns: makeTurnIndexer(config, persona, conversation, memory),
        pullFacts: makeDurableFactPuller(config, persona, conversation, memory),
        extractFacts: makeFactExtractor(
          config,
          persona,
          conversation,
          memory,
          harnesses!,
          agentDir,
        ),
        // See the trust note at the top of this file. Trusted turns skip the
        // threat screen, so no screener is built here.
        trusted: true,
        // Interactive and private: this turn is eligible to receive pending
        // background-turn digests, which is exactly where the owner should
        // see what a poller did on their behalf.
        origin: "channel",
        replyAudience: "private",
        // Pre-tool narration: the intent sentence flushes before the tool's
        // silence begins, which is the whole reason tool calls are visible on
        // this screen.
        toolNarration: true,
        signal: controller.signal,
      })) {
        if (chunk.type === "text") {
          final += chunk.text;
          yield { type: "text", text: chunk.text };
        } else if (chunk.type === "progress") {
          const now = Date.now();
          if (activeTurn) activeTurn.lastProgressNote = chunk.note;
          const last = tools[tools.length - 1];
          if (last && last.durationMs === undefined) {
            last.durationMs = now - last.startedAt;
            yield { type: "tool-done", index: tools.length - 1, ms: last.durationMs };
          }
          tools.push({ title: chunk.note, startedAt: now });
          yield { type: "tool", index: tools.length - 1, title: chunk.note };
        } else if (chunk.type === "replay") {
          // Narration-decay liveness (issue #551). A dedicated kind — it is
          // NOT a tool boundary: the in-flight tool row stays open with its
          // real duration, no tool row is appended, and the note only rides
          // the activity line.
          if (activeTurn) activeTurn.lastProgressNote = chunk.note;
          yield { type: "reasoning", text: chunk.note };
        } else if (chunk.type === "heartbeat") {
          yield { type: "thinking" };
        } else if (chunk.type === "done") {
          const last = tools[tools.length - 1];
          if (last && last.durationMs === undefined) {
            last.durationMs = Date.now() - last.startedAt;
            yield {
              type: "tool-done",
              index: tools.length - 1,
              ms: last.durationMs,
            };
          }
          final = chunk.finalText;
          completed = true;
          yield { type: "done", text: chunk.finalText };
        } else if (chunk.type === "error") {
          // A stop is not a failure: the harness's "aborted" error chunk
          // would otherwise paint a red error under a turn the user ended.
          if (controller.signal.aborted) continue;
          // Surface EVERY error chunk that gets this far, `recoverable` or not.
          //
          // The flag describes what the ORCHESTRATOR may do about it, not
          // whether the user was spared: a recoverable error with another
          // harness left is consumed inside `runWithFallback` and never
          // yielded, so the only error chunks that reach a channel are the
          // terminal ones and the chain-exhausted ones — both of which mean
          // the user got no reply. Filtering on `!recoverable` here therefore
          // dropped exactly the failures worth showing (a missing harness
          // binary exits this way), and the screen rendered a blank bubble
          // with no hint that anything had gone wrong. Every other channel
          // (engine, reactions, the ACP bridge) already surfaces both.
          yield { type: "error", message: chunk.error };
        }
      }
      if (await persistIfInterrupted()) {
        yield { type: "done", text: final };
      }
    } catch (e) {
      // An aborted turn is the user pressing ^c (or typing /stop), or a new
      // message superseding it, not a failure to report as one.
      if (controller.signal.aborted) {
        await persistIfInterrupted();
        yield { type: "done", text: final };
        return;
      }
      yield { type: "error", message: (e as Error).message };
    } finally {
      activeTurn = undefined;
    }
  }

  async function reloadHarnesses(next: Config): Promise<string[]> {
    // An injected chain is a test seam and the caller owns it; re-resolving
    // would silently replace the fake with whatever the host happens to have.
    if (input.harnesses) return input.harnesses.map((h) => h.id);
    const resolved = await resolveHarnessBinsForConfig(next);
    config = resolved.config;
    harnesses = buildHarnessChain(
      config,
      input.stderr ?? process.stderr,
      persona,
    );
    return harnesses.map((h) => h.id);
  }

  async function command(text: string): Promise<ChatCommandResult | null> {
    // Command-SHAPED but not ours: answered here rather than sent to the
    // harness, so a typo gets a list instead of a paragraph of improvisation.
    if (isUnknownCommand(text)) return { reply: unknownCommandReply(text) };
    if (!isKnownCommand(text)) return null;
    const result = await handleSlashCommand(text, {
      // The terminal has no chat id; the conversation key is the only
      // identifier there is, and it is what the logs should name.
      chatId: conversation,
      persona,
      conversation,
      memory,
      harnesses: harnesses!,
      startedAt,
      activeTurn,
      config,
      serviceControl: input.serviceControl,
    });
    // Advertised but unhandled should be impossible; say so rather than
    // silently falling through to the model with a command the user believes
    // this surface owns.
    return result ?? { reply: unknownCommandReply(text) };
  }

  return {
    persona,
    conversation,
    history,
    send,
    command,
    reloadHarnesses,
    async close() {
      if (ownsMemory) await memory.close();
    },
  };
}
