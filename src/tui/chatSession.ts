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

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  at: number;
  /** Assistant only: the tool calls made while producing this reply. */
  tools?: ChatToolCall[];
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
          "No harness available. Open settings (^s) → the phantom's Brain to pick one.",
      };
      return;
    }
    const tools: ChatToolCall[] = [];
    let final = "";
    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    activeTurn = { controller, startTime: Date.now() };
    try {
      for await (const chunk of runTurn({
        persona,
        conversation,
        userMessage: text,
        agentDir,
        // Same cwd choice as `ask`: the owner asks for work on repos all over
        // their home dir.
        workingDir: homedir(),
        harnesses: harnesses!,
        memory,
        idleTimeoutMs: config.harnessIdleTimeoutMs,
        hardTimeoutMs: config.harnessHardTimeoutMs,
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
          yield { type: "done", text: chunk.finalText };
        } else if (chunk.type === "error" && !chunk.recoverable) {
          // A RECOVERABLE error is the orchestrator moving to the next harness
          // in the chain; surfacing it would report a failure the user never
          // experienced.
          yield { type: "error", message: chunk.error };
        }
      }
    } catch (e) {
      // An aborted turn is the user pressing ^c (or typing /stop), not a
      // failure to report as one.
      if (controller.signal.aborted) {
        yield { type: "done", text: final };
        return;
      }
      yield { type: "error", message: (e as Error).message };
    } finally {
      activeTurn = undefined;
    }
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
    async close() {
      if (ownsMemory) await memory.close();
    },
  };
}
