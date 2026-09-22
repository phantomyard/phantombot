/**
 * The TURN lifecycle, owned by the SESSION rather than any screen
 * (phantombot#604, review of 2d345c4).
 *
 * The first cut of session-owned state moved only the transcript. The turn's
 * controller, in-flight promise and generation counter stayed screen-local —
 * and `App` renders screens as an exclusive switch, so navigating away
 * mid-stream unmounted them with the screen. Coming back and submitting again
 * started a SECOND `session.send()` while the first was still running (both
 * writing the same conversation, out of order), and the second displaced the
 * session's `activeTurn` handle, so `/stop` could no longer abort the older
 * turn. Reproduced by review on a real Ink remount.
 *
 * The session outlives every screen switch, so the turn lifecycle lives here
 * next to the transcript it writes: one controller, one in-flight promise, one
 * generation counter per session. A screen that remounts mid-turn re-attaches
 * to the still-running turn through `TurnStore` (a plain subscribable, the
 * same contract `TranscriptStore` uses for `useSyncExternalStore`), and a
 * prompt typed after a remount interrupts the SAME in-flight turn it always
 * would have — no second generator, no displaced `/stop`.
 *
 * Deliberately framework-free, like the rest of `chatSession.ts`. The
 * `send`/`transcript` pair is injected, so tests build fake sessions through
 * the same runner the real session uses — one consumption loop, not two.
 */

import type {
  ChatEvent,
  ChatMessage,
  ChatMessagePart,
} from "./chatSession.ts";
import type { TranscriptStore } from "./transcriptStore.ts";

/** Live state of the session-owned turn, read by the screen each render. */
export interface TurnState {
  busy: boolean;
  /** When the in-flight turn started, for the elapsed counter. */
  busySince?: number;
  /** What the phantom is doing right now: a tool title, or "thinking". */
  activity: string;
}

/**
 * The subscribable half of the runner: what the screen needs to DRAW the
 * turn (busy state, elapsed clock, activity label). Same React contract as
 * `TranscriptStore` — `getSnapshot` returns the same reference until the next
 * mutation, so `Object.is` change detection neither misses an update nor
 * re-renders in a loop.
 */
export class TurnStore {
  private state: TurnState = { busy: false, activity: "thinking" };
  private readonly listeners = new Set<() => void>();

  getSnapshot(): TurnState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** A turn started: busy from `since`, activity reset to "thinking". */
  start(since: number): void {
    this.set({ busy: true, busySince: since, activity: "thinking" });
  }

  setActivity(activity: string): void {
    if (this.state.activity === activity) return;
    this.set({ ...this.state, activity });
  }

  /** The turn ended, whatever the way: no busy state survives it. */
  idle(): void {
    if (!this.state.busy) return;
    this.set({ busy: false, activity: "thinking" });
  }

  private set(next: TurnState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

/** The session's turn primitive: one user message, UI events as it streams. */
export type TurnSend = (
  text: string,
  signal?: AbortSignal,
) => AsyncGenerator<ChatEvent>;

export interface TurnRunner {
  /** Observable turn state for the view. */
  turn: TurnStore;
  /**
   * Submit a prompt. A prompt typed WHILE a turn runs interrupts it, the same
   * design every other channel follows ("type to interrupt"): the running
   * turn is aborted with reason "interrupt" (its message is kept in history
   * by the session, marked interrupted), and the new prompt starts once the
   * old turn has unwound, so history lands in the order it was typed.
   */
  submit(text: string): Promise<void>;
  /**
   * Abort the turn in flight with a recorded reason ("stop" from ^c;
   * `/stop` reaches the same controller through the session's `activeTurn`).
   */
  abortTurn(reason: string): void;
}

/**
 * Build the session-owned turn lifecycle over a `send` primitive and the
 * transcript it writes to.
 */
export function createTurnRunner(
  send: TurnSend,
  transcript: TranscriptStore,
): TurnRunner {
  const turn = new TurnStore();
  /** The controller of the turn in flight — what ^c aborts. */
  let abortController: AbortController | null = null;
  /**
   * The submit in flight (including one still waiting for the turn it
   * interrupted to unwind), and a generation counter so a message superseded
   * while it waited is dropped, the same backlog flush Telegram and
   * PhantomChat do on an interrupt.
   */
  let inFlight: Promise<void> | null = null;
  let generation = 0;

  async function runTurn(text: string): Promise<void> {
    const controller = new AbortController();
    abortController = controller;
    turn.start(Date.now());
    // Patch by IDENTITY, not by "the last message": a slash command can be
    // typed while this turn is streaming (that is what `/stop` is for), and
    // its bubble lands after this one — "the last message" would then be the
    // command's, and the streaming text would overwrite its reply.
    let slot: ChatMessage = {
      role: "assistant",
      text: "",
      at: Date.now(),
      tools: [],
      parts: [],
    };
    transcript.append({ role: "user", text, at: Date.now() }, slot);
    const patch = (fn: (m: ChatMessage) => ChatMessage) => {
      slot = transcript.patch(slot, fn);
    };
    try {
      for await (const event of send(text, controller.signal)) {
        if (event.type === "text") {
          turn.setActivity("writing the reply");
          patch((m) => {
            // Ordered timeline: a text run continues the trailing text part,
            // or opens a new one after a tool call — narration keeps its
            // place in the order it happened instead of pooling above the
            // whole reply.
            const parts = [...(m.parts ?? [])];
            const last = parts[parts.length - 1];
            if (last?.kind === "text") {
              parts[parts.length - 1] = {
                kind: "text",
                text: last.text + event.text,
              };
            } else {
              parts.push({ kind: "text", text: event.text });
            }
            return { ...m, text: m.text + event.text, parts };
          });
        } else if (event.type === "thinking") {
          // The harness is alive but silent. Say so rather than freezing the
          // label on whatever the last tool happened to be.
          turn.setActivity("thinking");
        } else if (event.type === "reasoning") {
          // Narration-decay replay (issue #551): model-written reasoning as
          // liveness on the activity line. Trimmed to the first line — it
          // is a label, not a transcript row — and never persisted.
          const firstLine = event.text.split("\n")[0] ?? event.text;
          turn.setActivity(
            firstLine.length > 120
              ? `${Array.from(firstLine).slice(0, 120).join("")}…`
              : firstLine,
          );
        } else if (event.type === "tool") {
          turn.setActivity(event.title.split("\n")[0] ?? "working");
          const startedAt = Date.now();
          patch((m) => ({
            ...m,
            tools: [
              ...(m.tools ?? []),
              { title: event.title, startedAt },
            ],
            parts: [
              ...(m.parts ?? []),
              { kind: "tool", title: event.title, startedAt },
            ],
          }));
        } else if (event.type === "tool-done") {
          patch((m) => {
            const tools = [...(m.tools ?? [])];
            if (tools[event.index]) {
              tools[event.index] = {
                ...tools[event.index]!,
                durationMs: event.ms,
              };
            }
            // `event.index` addresses the k-th TOOL call, not the k-th part
            // — find the k-th tool entry of the timeline.
            const parts = [...(m.parts ?? [])];
            let k = -1;
            for (let i = 0; i < parts.length; i++) {
              const part = parts[i]!;
              if (part.kind !== "tool") continue;
              if (++k === event.index) {
                parts[i] = { ...part, durationMs: event.ms };
                break;
              }
            }
            return { ...m, tools, parts };
          });
        } else if (event.type === "done") {
          patch((m) => {
            const parts = m.parts ?? [];
            const streamed = parts
              .filter(
                (p): p is Extract<ChatMessagePart, { kind: "text" }> =>
                  p.kind === "text",
              )
              .map((p) => p.text)
              .join("");
            let next = parts;
            if (event.text && event.text !== streamed) {
              // The terminal `done` carries the authoritative final text,
              // which can cover only the harness that actually answered
              // (chain fallback): replace the trailing text run after the
              // last tool call and keep the earlier narration. When it
              // matches what streamed, the timeline already IS the reply.
              let cut = -1;
              for (let i = parts.length - 1; i >= 0; i--) {
                if (parts[i]!.kind === "tool") {
                  cut = i;
                  break;
                }
              }
              next = [...parts.slice(0, cut + 1), { kind: "text", text: event.text }];
            }
            return { ...m, text: event.text || m.text, parts: next };
          });
        } else if (event.type === "error") {
          patch((m) => ({ ...m, error: event.message }));
        }
      }
      // A finished turn that said nothing and reported nothing must still
      // SAY so. A bubble with a header and no body is indistinguishable
      // from a reply that is still streaming, and it is exactly what a dead
      // harness chain used to draw — the user reads it as "it answered and
      // the answer was blank" rather than "nothing answered". Every other
      // channel already renders this placeholder (`core/engine.ts`).
      // A stopped or superseded turn says THAT, not "(no reply)": nothing
      // failed to answer, the user ended it.
      const placeholder = controller.signal.aborted
        ? "(interrupted)"
        : "(no reply)";
      patch((m) =>
        m.text === "" && m.error === undefined
          ? {
              ...m,
              text: placeholder,
              // The placeholder rides the timeline too, so a turn that
              // called tools but said nothing still shows it under them.
              parts: [...(m.parts ?? []), { kind: "text", text: placeholder }],
            }
          : m,
      );
    } finally {
      turn.idle();
      if (abortController === controller) abortController = null;
    }
  }

  return {
    turn,
    submit(text: string): Promise<void> {
      const previous = inFlight;
      const gen = ++generation;
      abortController?.abort("interrupt");
      const run = (async () => {
        if (previous) await previous.catch(() => {});
        // Superseded by a newer prompt while waiting: drop it, as the other
        // channels flush their backlog on interrupt.
        if (gen !== generation) return;
        await runTurn(text);
      })();
      inFlight = run;
      void run.finally(() => {
        if (inFlight === run) inFlight = null;
      });
      return run;
    },
    abortTurn(reason: string): void {
      abortController?.abort(reason);
    },
  };
}
