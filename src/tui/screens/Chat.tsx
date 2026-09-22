/**
 * Screen 0 — the default view.
 *
 * `phantombot` with no arguments does not print usage and does not open a
 * menu: it opens a conversation with the default phantom, full screen, cursor
 * in the box. Same shape as the `pi` harness's own CLI — a scrolling
 * transcript, one input line, a thin status bar, nothing else.
 *
 * That is the whole product in one screen: the shortest possible loop between
 * installing this thing and talking to it. Settings are one keypress away
 * (`^s`) and out of the way until you want them.
 *
 * Rules this screen keeps:
 *
 *   - **Tool calls are visible but collapsed** — one dim line per call with its
 *     duration; `^t` expands. A phantom that silently pauses for eleven seconds
 *     looks broken; the same phantom showing `› gh release view` does not.
 *   - **`^c` interrupts the turn, it does not kill the app.** `^q` quits.
 *     Quitting is never something you do by accident mid-answer.
 *   - **Streaming, not a blob** — text lands as it is produced.
 *   - **Slash commands are phantombot's, not the model's** (#480) — `/status`,
 *     `/stop`, `/update` and the rest are dispatched ahead of the harness
 *     through the same handler Telegram and phantomchat use, so a command works
 *     while a turn is hung, which is exactly when you need it.
 *   - **Replies are rendered markdown** (#481) — headings, lists, tables and
 *     fenced code, flattened to rows by `markdown.ts` before layout sees them.
 *   - **Scrollback IS the conversation store.** History comes from the memory
 *     store on open, so leaving for settings and coming back shows the same
 *     thread, and so does reopening the app tomorrow.
 */

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Box, Text, useInput } from "ink";

import { Frame } from "../components/Frame.tsx";
import { useElapsedSeconds, useSpinnerFrame } from "../components/Spinner.tsx";
import { badge, humanDuration, theme } from "../theme.ts";
import { useTerminalSize, viewportRows } from "../terminal.ts";
import { rawKeyFeed } from "../stdinTap.ts";
import { frameChromeRows } from "../chrome.ts";
import { transcriptLines, transcriptWindow } from "../transcript.ts";
import type { TranscriptLine } from "../transcript.ts";
import type { Span } from "../markdown.ts";
import { commandHints, commandName, completeCommand } from "../slash.ts";
import {
  backspaceAtCursor,
  cursorEnd,
  cursorHome,
  cursorLeft,
  cursorRight,
  graphemeCount,
  insertAtCursor,
  promptRows,
  promptState,
  type PromptState,
} from "../promptBox.ts";
import type {
  ChatMessage,
  ChatMessagePart,
  ChatSession,
} from "../chatSession.ts";

/**
 * Rows the chat chrome takes INSIDE the frame: header (1), header gap (1),
 * activity line (1), input box (3), footer (1), and one row of slack. The
 * frame's own cost (a border, or nothing) is added by `frameChromeRows`, so
 * dropping the border hands those two rows to the transcript instead of
 * leaving a gap where the border used to be.
 *
 * A constant, not a measurement: measuring would mean a component reading the
 * layout back out of Yoga mid-render, and being one row conservative costs a
 * blank line while being one row optimistic tears the frame.
 */
export const CHAT_CHROME_ROWS = 8;

/**
 * The type-ahead never grows the chrome without paying for it: the rows it
 * occupies are subtracted from the transcript in the same render, so on a full
 * screen the drawn height is unchanged and a `/` keystroke cannot push the
 * frame off the bottom. Capped so a long command list cannot eat the
 * conversation.
 */
export const MAX_COMMAND_HINTS = 5;

/**
 * One transcript row.
 *
 * The screen draws exactly the lines `transcript.ts` produced — no component
 * decides how tall a message is any more, because the thing that measures and
 * the thing that draws are now the same list. That is what makes a row of
 * scroll mean a row on screen.
 */
function Line(props: { line: TranscriptLine }): React.ReactElement {
  const line = props.line;
  if (line.kind === "gap") return <Text> </Text>;
  if (line.kind === "header") {
    return (
      <Box>
        <Text
          backgroundColor={line.role === "user" ? theme.accent : theme.ok}
          color="black"
          bold
        >
          {` ${line.name} `}
        </Text>
        <Text color={theme.dim}>{line.time ? `  ${line.time}` : ""}</Text>
      </Box>
    );
  }
  if (line.kind === "tool") {
    // `wrap="truncate"` is the BACKSTOP, not the fit: `transcript.ts` already
    // cut the title to the drawable width, and this guarantees that even if
    // that arithmetic is ever wrong again the row cannot become two and take
    // the frame's repaint math with it (phantombot#556).
    return (
      <Box paddingLeft={2}>
        <Text color={theme.dim} wrap="truncate">
          {"\u203a "}
          {line.title}
        </Text>
        <Box flexGrow={1} />
        <Text color={theme.dim} wrap="truncate">
          {line.duration}
        </Text>
      </Box>
    );
  }
  if (line.kind === "rich") {
    // A blank markdown row must still DRAW a row. An empty Ink box collapses
    // to zero height, and a row that measures one and draws none is exactly
    // the measurement/rendering drift this transcript is built to prevent —
    // every scroll offset below it would be out by one.
    if (line.spans.length === 0) return <Text> </Text>;
    // Markdown, already flattened to ONE row by `markdown.ts`: the spans carry
    // attributes, never a line break, so this stays a single Ink row and the
    // transcript's row arithmetic still holds (phantombot#481).
    return (
      <Box paddingLeft={2 + line.indent}>
        <Text>
          {line.spans.map((span, i) => (
            <Text
              key={i}
              bold={span.bold}
              italic={span.italic}
              underline={span.underline}
              color={toneColor(span)}
            >
              {span.text}
            </Text>
          ))}
        </Text>
      </Box>
    );
  }
  return (
    <Box paddingLeft={2}>
      <Text color={line.error ? theme.bad : undefined}>{line.text}</Text>
    </Box>
  );
}

/**
 * A span's semantic tone, resolved to the theme's colours. Code carries one
 * whether or not the renderer gave it an explicit tone.
 */
function toneColor(span: Span): string | undefined {
  if (span.tone === "dim") return theme.dim;
  if (span.tone === "accent") return theme.accent;
  if (span.tone === "ok") return theme.ok;
  return span.code ? theme.ok : undefined;
}

/**
 * The live activity line.
 *
 * This is the fix for "I do not know what it is doing": a moving spinner, the
 * step the phantom is actually on, and a seconds counter that keeps climbing.
 * The previous static `thinking…` sat inside the input box and was, by the
 * user's own report, not noticed at all — nothing on the screen changed, so a
 * long turn and a hung turn looked the same.
 */
function Activity(props: {
  since: number;
  note: string;
}): React.ReactElement {
  const frame = useSpinnerFrame(true);
  const seconds = useElapsedSeconds(props.since);
  return (
    <Box paddingX={1}>
      <Text color={theme.accent}>{frame} </Text>
      <Text color={theme.dim}>{props.note}</Text>
      <Text color={theme.dim}>{` · ${seconds}s`}</Text>
      <Box flexGrow={1} />
      <Text color={theme.dim}>ctrl+c interrupts</Text>
    </Box>
  );
}

export function ChatScreen(props: {
  session: ChatSession;
  /** Title-bar status: release ring, autostart state. */
  status: string;
  /** Loud-state override for the status text (red `autostart: off`). */
  statusColor?: string;
  onSettings: () => void;
  onQuit: () => void;
  /**
   * Sent once on mount as if typed and submitted (`phantombot --prompt`,
   * issue #575). A slash command runs as a command, like a typed one.
   */
  seedPrompt?: string;
  /** Called the moment the seed is taken, so the owner never offers it again. */
  onSeedSent?: () => void;
}): React.ReactElement {
  /**
   * The visible conversation lives on the SESSION, not here
   * (phantombot#604). Screens unmount on every navigation (`^l`, `^s`, …),
   * and a screen-local copy died with each unmount — coming back re-seeded
   * from the open-time snapshot and the current session vanished from the
   * screen. The session outlives the screen switch; this screen is now a
   * pure view of its store. Scroll resets to the live bottom on return:
   * the newest exchange is where a returning reader looks.
   */
  const transcript = props.session.transcript;
  const subscribe = useCallback(
    (onStoreChange: () => void) => transcript.subscribe(onStoreChange),
    [transcript],
  );
  const getSnapshot = useCallback(
    () => transcript.getSnapshot(),
    [transcript],
  );
  const messages = useSyncExternalStore(subscribe, getSnapshot);
  const [input, setInputState] = useState<PromptState>(() => promptState(""));
  /** Mirrors `input` synchronously so a burst of keystrokes cannot lose one. */
  const inputRef = useRef<PromptState>(input);
  const setInputValue = useCallback((next: PromptState) => {
    inputRef.current = next;
    setInputState(next);
  }, []);
  const [busy, setBusy] = useState(false);
  /** When the in-flight turn started, for the elapsed counter. */
  const [busySince, setBusySince] = useState<number | undefined>();
  /** What the phantom is doing right now: a tool title, or "thinking". */
  const [activity, setActivity] = useState("thinking");
  /**
   * Rows scrolled UP from the live bottom. 0 means "stuck to the bottom", and
   * new output keeps it there; anything else is the user reading back, and is
   * left exactly where they put it.
   */
  const [scroll, setScroll] = useState(0);
  /** Mirrors `scroll` so a burst of wheel events cannot lose one (see input). */
  const scrollRef = useRef(0);
  /** ^k raw key inspector: what the terminal actually sent, latest last. */
  const [showKeys, setShowKeys] = useState(false);
  const [rawKeys, setRawKeys] = useState<string[]>([]);
  useEffect(() => {
    if (!showKeys) return;
    setRawKeys(rawKeyFeed.recent());
    return rawKeyFeed.subscribe(() => setRawKeys(rawKeyFeed.recent()));
  }, [showKeys]);
  /**
   * How many transcript rows are on screen, for PgUp/PgDn.
   *
   * A ref, written during render: the key handler is created before the size
   * is known, and reading it out of the closure would page by whatever the
   * window was when the handler was made — wrong after any resize.
   */
  const pageRef = useRef(10);
  const scrollBy = useCallback((rows: number) => {
    const next = Math.max(0, scrollRef.current + rows);
    scrollRef.current = next;
    setScroll(next);
  }, []);
  const abortRef = useRef<AbortController | null>(null);
  /**
   * The submit in flight (including one still waiting for the turn it
   * interrupted to unwind), and a generation counter so a message superseded
   * while it waited is dropped, the same backlog flush Telegram and
   * PhantomChat do on an interrupt.
   */
  const turnRef = useRef<Promise<void> | null>(null);
  const genRef = useRef(0);

  // A switched session (^p changed the phantom) is a different transcript:
  // the store re-binds through the `subscribe`/`getSnapshot` deps above, so
  // only the viewport needs resetting — back to the live bottom.
  useEffect(() => {
    scrollRef.current = 0;
    setScroll(0);
  }, [transcript]);

  const runSubmit = useCallback(
    async (text: string) => {
      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(true);
      setBusySince(Date.now());
      // Sending is an implicit "take me back to the live end": the reply you
      // just asked for must not arrive off screen above you.
      scrollRef.current = 0;
      setScroll(0);
      setActivity("thinking");
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
        for await (const event of props.session.send(text, controller.signal)) {
          if (event.type === "text") {
            setActivity("writing the reply");
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
            setActivity("thinking");
          } else if (event.type === "reasoning") {
            // Narration-decay replay (issue #551): model-written reasoning as
            // liveness on the activity line. Trimmed to the first line — it
            // is a label, not a transcript row — and never persisted.
            const firstLine = event.text.split("\n")[0] ?? event.text;
            setActivity(
              firstLine.length > 120
                ? `${Array.from(firstLine).slice(0, 120).join("")}…`
                : firstLine,
            );
          } else if (event.type === "tool") {
            setActivity(event.title.split("\n")[0] ?? "working");
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
                  (
                    p,
                  ): p is Extract<ChatMessagePart, { kind: "text" }> =>
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
        setBusy(false);
        setBusySince(undefined);
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [props.session, transcript],
  );

  /**
   * Send a prompt. A prompt typed WHILE a turn runs interrupts it, the same
   * design every other channel follows ("type to interrupt"): the running
   * turn is aborted with reason "interrupt" (its message is kept in history
   * by the session, marked interrupted), and the new prompt starts once the
   * old turn has unwound, so history lands in the order it was typed.
   */
  const submit = useCallback(
    (text: string) => {
      const previous = turnRef.current;
      const gen = ++genRef.current;
      abortRef.current?.abort("interrupt");
      const run = (async () => {
        if (previous) await previous.catch(() => {});
        // Superseded by a newer prompt while waiting: drop it, as the other
        // channels flush their backlog on interrupt.
        if (gen !== genRef.current) return;
        await runSubmit(text);
      })();
      turnRef.current = run;
      void run.finally(() => {
        if (turnRef.current === run) turnRef.current = null;
      });
    },
    [runSubmit],
  );

  /**
   * A slash command: answered by phantombot itself, never by the model.
   *
   * Deliberately does NOT take the `busy` lock. `/stop` is only useful while a
   * turn is running and `/status` is most useful then too — gating commands on
   * the turn they exist to inspect or interrupt is the bug the other channels
   * already avoid by dispatching ahead of the harness.
   */
  const runCommand = useCallback(
    async (text: string) => {
      scrollRef.current = 0;
      setScroll(0);
      let slot: ChatMessage = {
        role: "assistant",
        text: "\u2026",
        at: Date.now(),
      };
      transcript.append({ role: "user", text, at: Date.now() }, slot);
      const patch = (fn: (m: ChatMessage) => ChatMessage) => {
        slot = transcript.patch(slot, fn);
      };
      try {
        const result = await props.session.command(text);
        patch((m) => ({ ...m, text: result?.reply ?? "" }));
        // Strictly after the reply is on screen: /update and /restart end this
        // process, and a heads-up that lands after the process dies is no
        // heads-up at all.
        if (result?.afterSend) await result.afterSend();
      } catch (e) {
        patch((m) => ({ ...m, error: (e as Error).message }));
      }
    },
    [props.session, transcript],
  );

  // The launch prompt (issue #575). Taken exactly once per mount, and the
  // owner is told immediately, so a remount (^s then esc) never resends it.
  // Dispatched through the same split as Enter, so it is indistinguishable from
  // the user typing it: trusted because the human who launched it is watching.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || props.seedPrompt === undefined) return;
    seededRef.current = true;
    props.onSeedSent?.();
    const text = props.seedPrompt.trim();
    if (!text) return;
    if (commandName(text) !== undefined) void runCommand(text);
    else submit(text);
    // Mount-only by design; see above.
  }, []);

  useInput((char, key) => {
    // ^c interrupts the TURN. It never quits: losing an app mid-answer because
    // you wanted the answer to stop is the wrong trade. Reason "stop", the
    // same one `/stop` uses, so both are recorded identically.
    if (key.ctrl && char === "c") {
      abortRef.current?.abort("stop");
      return;
    }
    if (key.ctrl && char === "q") {
      props.onQuit();
      return;
    }
    if (key.ctrl && char === "s") {
      props.onSettings();
      return;
    }
    // ^k toggles the raw key inspector — what the terminal actually sent for
    // each chunk, so modifier problems ("ctrl+enter just submits") can be
    // diagnosed from inside the app instead of by guesswork.
    if (key.ctrl && char === "k") {
      setShowKeys((v) => !v);
      return;
    }
    // Scrolling works WHILE A TURN IS RUNNING — reading back is exactly what
    // you do while waiting — so it sits above the `busy` gate.
    const page = Math.max(1, pageRef.current - 1);
    if (key.pageUp) return scrollBy(page);
    if (key.pageDown) return scrollBy(-page);
    if (key.shift && key.upArrow) return scrollBy(1);
    if (key.shift && key.downArrow) return scrollBy(-1);
    if (key.home) return scrollBy(Number.MAX_SAFE_INTEGER);
    if (key.end) return scrollBy(-Number.MAX_SAFE_INTEGER);
    // Tab completes a half-typed command. Only there: anywhere else a tab is a
    // literal character the user meant to type.
    if (key.tab && !key.shift) {
      const completed = completeCommand(inputRef.current.text);
      if (completed !== inputRef.current.text) setInputValue(promptState(completed));
      return;
    }
    // Shift/Ctrl/Alt+Enter inserts a newline instead of sending. Terminals
    // that report modifiers (kitty protocol, CSI-u) get real multi-line
    // input; a legacy terminal sends a bare \r for all of them and there is
    // no way to tell them apart there — ctrl+J still works everywhere.
    if (key.return && (key.shift || key.ctrl || key.meta)) {
      setInputValue(insertAtCursor(inputRef.current, "\n"));
      return;
    }
    if (key.return) {
      const text = inputRef.current.text.trim();
      if (!text) return;
      // Commands are dispatched ahead of the harness, so they work WHILE a
      // turn is in flight; an ordinary prompt interrupts the running turn
      // (see `submit`).
      const isCommand = commandName(text) !== undefined;
      setInputValue(promptState(""));
      if (isCommand) void runCommand(text);
      else void submit(text);
      return;
    }
    // ←→ move the cursor inside the box — the editing primitive that was
    // missing: without it a typo could only be fixed by deleting back to it.
    // Plain ↑↓ still scroll the transcript (one line, like PgUp/PgDn, works
    // while a turn runs); there is no input history to walk, and vertical
    // cursor movement inside a chat box is what ↑↓ history is FOR.
    if (key.upArrow) return scrollBy(1);
    if (key.downArrow) return scrollBy(-1);
    if (key.leftArrow) return void setInputValue(cursorLeft(inputRef.current));
    if (key.rightArrow) return void setInputValue(cursorRight(inputRef.current));
    // Line editing: ^a/^e move to start/end (readline muscle memory; the
    // Home/End KEYS are taken by transcript scrolling above).
    if (key.ctrl && char === "a") {
      setInputValue(cursorHome(inputRef.current));
      return;
    }
    if (key.ctrl && char === "e") {
      setInputValue(cursorEnd(inputRef.current));
      return;
    }
    if (key.backspace || key.delete) {
      // Both names mean BACKSPACE here. Ink names 0x7f — what the Backspace
      // key sends on essentially every terminal — `delete`, and cannot tell
      // it from the forward-delete key (ESC[3~) by flag. `main` treated the
      // two as one thing and was right to: routing `delete` to forward-delete
      // made Backspace a silent no-op while typing. Forward-delete stays
      // unreachable until we sniff the raw sequence (rawKeys inspector sees
      // ESC[3~); until then this conservative branch matches the bytes.
      setInputValue(backspaceAtCursor(inputRef.current));
      return;
    }
    if (char && !key.ctrl && !key.meta) {
      // A bare \n chunk (ctrl+J, some terminals' shift/alt+enter) is a
      // newline in the box, never a submit.
      if (char === "\n") {
        setInputValue(insertAtCursor(inputRef.current, "\n"));
        return;
      }
      if (/\r|\n/.test(char)) {
        // \r is normalised to \n: that is what the viewport wraps on.
        const normalised = char.replace(/\r\n?/g, "\n");
        // text + ONE trailing newline is a fast typist's batched Enter — the
        // terminal delivered the typed text and Enter in a single read. That
        // is a SUBMIT (the bug #509 exists for), not a paste — but only when
        // the cursor is at the END, i.e. the batch landed where the typist
        // was. A cursor mid-text makes it a paste, below.
        const batched = /^(.+)\n$/.exec(normalised);
        const body = batched?.[1];
        const atEnd = inputRef.current.cursor >= graphemeCount(inputRef.current.text);
        if (body !== undefined && !body.includes("\n") && atEnd) {
          const text = `${inputRef.current.text}${body}`.trim();
          const isCommand = commandName(text) !== undefined;
          // Busy or not, this is a submit: a prompt typed during a turn
          // interrupts it, exactly as the plain-Enter branch does.
          if (!text) return;
          setInputValue(promptState(""));
          if (isCommand) void runCommand(text);
          else void submit(text);
          return;
        }
        // Anything with INTERIOR newlines is a paste: in chat a paste is
        // NEVER a submit — the whole block lands in the box so it can be
        // reviewed and edited first. (The wizard's name field uses
        // applyTextChunk's split-and-submit rule instead — see
        // `textInput.ts`.)
        setInputValue(insertAtCursor(inputRef.current, normalised));
        return;
      }
      // From the REF: two keystrokes can land between renders, and reading
      // `input` out of the closure loses the first of them.
      setInputValue(insertAtCursor(inputRef.current, char));
    }
  });

  const size = useTerminalSize();
  // The type-ahead is part of the chrome while it is up, so the transcript
  // gives back exactly the rows it takes.
  const hints = commandHints(input.text).slice(0, MAX_COMMAND_HINTS);
  // The input box is PRE-WRAPPED here (promptBox.ts), so its row count is a
  // known constant before layout — no Yoga measurement involved. The chrome
  // constant assumes ONE input row; every extra wrapped row is paid for by
  // the transcript in the same render, so a long prompt shrinks the scroll
  // region instead of pushing the footer off the screen.
  const inputRows = promptRows(
    input.text,
    input.cursor,
    Math.max(8, size.columns - 4),
    // The box stays LIVE during a turn (caret shown, text undimmed): typing
    // a prompt mid-turn interrupts it, so what you are typing must be
    // visible. The dim rules around it remain the "turn running" cue.
  );
  // Same for the key inspector: it borrows rows from the transcript, never
  // overflows the frame — one header + one per recorded chunk.
  const keyRows = showKeys ? rawKeys.length + 1 : 0;
  const rows = viewportRows(
    size,
    CHAT_CHROME_ROWS +
      hints.length +
      keyRows +
      Math.max(0, inputRows.length - 1) +
      frameChromeRows(),
  );
  pageRef.current = rows;
  // ONE flat list of rows: what is measured is what is drawn. Clipping happens
  // before layout — overflowing the window is what pushes the border off the
  // bottom of the screen. See `transcript.ts`.
  const lines = transcriptLines(messages, size.columns, {
    personaName: props.session.persona,
    formatDuration: (ms) => (ms === undefined ? "\u2026" : humanDuration(ms)),
  });
  // The marker row is reserved whenever the conversation is TALLER than the
  // window — not only while scrolled. Reserving it lazily means the row that
  // turns the marker on is the row that pushes the bottom line off screen.
  const overflowing = lines.length > rows;
  const view = transcriptWindow(lines, overflowing ? rows - 1 : rows, scroll);
  // Clamp: the conversation grows and the window resizes underneath us, so an
  // offset that was valid a moment ago may now be past the top.
  useEffect(() => {
    if (view.offset !== scrollRef.current) {
      scrollRef.current = view.offset;
      setScroll(view.offset);
    }
  }, [view.offset]);

  return (
    <Frame
      title={[props.session.persona]}
      status={props.status}
      statusColor={props.statusColor}
      footer={[
        { icon: badge.send, key: "↵", label: "Send" },
        { icon: badge.send, key: "Alt+↵", label: "Line" },
        { icon: badge.run, key: "/", label: "Cmds" },
        { icon: badge.scroll, key: "↑↓", label: "Scroll" },
        {
          icon: badge.settings,
          key: "ctrl+s",
          label: "Settings",
          onPress: props.onSettings,
        },
        { icon: badge.quit, key: "ctrl+q", label: "Quit" },
      ]}
    >
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {lines.length === 0 ? (
          <Text color={theme.dim}>
            Say something to {props.session.persona}. ctrl+s for settings.
          </Text>
        ) : (
          <>
            {overflowing ? (
              <Text color={theme.dim}>
                {`\u25b2 ${view.above} above` +
                  (view.below > 0
                    ? ` \u00b7 \u25bc ${view.below} below \u00b7 End to catch up`
                    : "")}
              </Text>
            ) : null}
            {view.lines.map((line, i) => (
              <Line key={`${view.above + i}`} line={line} />
            ))}
          </>
        )}
      </Box>
      {busy && busySince !== undefined ? (
        <Activity since={busySince} note={activity} />
      ) : (
        <Box paddingX={1}>
          <Text color={theme.dim}> </Text>
        </Box>
      )}
      {hints.length > 0 ? (
        <Box flexDirection="column" paddingX={2}>
          {hints.map((hint) => (
            <Text key={hint.name} color={theme.dim}>
              <Text color={theme.accent}>{`/${hint.name}`}</Text>
              {`  ${hint.description}`}
            </Text>
          ))}
        </Box>
      ) : null}
      {showKeys ? (
        <Box flexDirection="column" paddingX={2}>
          <Text color={theme.dim}>
            {"KEY INSPECTOR — ctrl+k to close, bytes the terminal sent (latest last):"}
          </Text>
          {rawKeys.length === 0 ? (
            <Text color={theme.dim}>{"  (press any key)"}</Text>
          ) : (
            rawKeys.map((k, i) => (
              <Text key={`${i}-${k}`} color={theme.accent}>{`  ${k}`}</Text>
            ))
          )}
        </Box>
      ) : null}
      {/* FRAMELESS prompt strip: a rule above and below, open at the sides —
          the claude/codex/pi look. No corners to shear, and the two rule rows
          cost exactly what the old border's top+bottom rows cost, so the
          chrome budget is unchanged. Each rule is a border-only box sized by
          the layout engine (never a run of `─` characters). The marginBottom
          on the lower rule keeps a blank row of air above the footer. */}
      <Box
        borderStyle="single"
        borderColor={busy ? theme.dim : theme.accent}
        borderTop={false}
        borderLeft={false}
        borderRight={false}
      />
      <Box paddingX={1} flexDirection="column">
        {/* The rows are pre-wrapped to the inner width by promptBox.ts — what
            is measured is what is drawn. The caret is a span IN the wrap
            stream, so it never overflows a row. */}
        {inputRows.map((row, i) => (
          <Text key={i}>
            {row.map((seg, j) =>
              seg.caret ? (
                <Text key={j} color={theme.accent}>
                  {seg.text}
                </Text>
              ) : (
                <Text
                  key={j}
                  color={
                    seg.tone === "dim"
                      ? theme.dim
                      : seg.tone === "accent"
                        ? theme.accent
                        : undefined
                  }
                >
                  {seg.text}
                </Text>
              ),
            )}
          </Text>
        ))}
      </Box>
      <Box
        borderStyle="single"
        borderColor={busy ? theme.dim : theme.accent}
        borderTop={false}
        borderLeft={false}
        borderRight={false}
        marginBottom={1}
      />
    </Frame>
  );
}
