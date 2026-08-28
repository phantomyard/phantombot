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
 *   - **Scrollback IS the conversation store.** History comes from the memory
 *     store on open, so leaving for settings and coming back shows the same
 *     thread, and so does reopening the app tomorrow.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";

import { Frame } from "../components/Frame.tsx";
import { useElapsedSeconds, useSpinnerFrame } from "../components/Spinner.tsx";
import { badge, humanDuration, theme } from "../theme.ts";
import { useTerminalSize, viewportRows } from "../terminal.ts";
import { frameChromeRows } from "../chrome.ts";
import { transcriptLines, transcriptWindow } from "../transcript.ts";
import type { TranscriptLine } from "../transcript.ts";
import { mouse } from "../mouse.ts";
import { applyTextChunk } from "../textInput.ts";
import type { ChatMessage, ChatSession } from "../chatSession.ts";

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
    return (
      <Box paddingLeft={2}>
        <Text color={theme.dim}>
          {"\u203a "}
          {line.title}
        </Text>
        <Box flexGrow={1} />
        <Text color={theme.dim}>{line.duration}</Text>
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
      <Text color={theme.dim}>^c interrupts</Text>
    </Box>
  );
}

export function ChatScreen(props: {
  session: ChatSession;
  /** Title-bar status: brain, service state, channels. */
  status: string;
  onSettings: () => void;
  onQuit: () => void;
}): React.ReactElement {
  const [messages, setMessages] = useState<ChatMessage[]>(
    props.session.history,
  );
  const [input, setInputState] = useState("");
  /** Mirrors `input` synchronously so a burst of keystrokes cannot lose one. */
  const inputRef = useRef("");
  const setInputValue = useCallback((next: string) => {
    inputRef.current = next;
    setInputState(next);
  }, []);
  const [busy, setBusy] = useState(false);
  /** When the in-flight turn started, for the elapsed counter. */
  const [busySince, setBusySince] = useState<number | undefined>();
  /** What the phantom is doing right now: a tool title, or "thinking". */
  const [activity, setActivity] = useState("thinking");
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  /**
   * Rows scrolled UP from the live bottom. 0 means "stuck to the bottom", and
   * new output keeps it there; anything else is the user reading back, and is
   * left exactly where they put it.
   */
  const [scroll, setScroll] = useState(0);
  /** Mirrors `scroll` so a burst of wheel events cannot lose one (see input). */
  const scrollRef = useRef(0);
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

  // Reset the transcript when the session changes (^p switched phantom).
  useEffect(() => {
    setMessages(props.session.history);
    scrollRef.current = 0;
    setScroll(0);
  }, [props.session]);

  const submit = useCallback(
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
      setMessages((prev) => [
        ...prev,
        { role: "user", text, at: Date.now() },
        { role: "assistant", text: "", at: Date.now(), tools: [] },
      ]);
      const patch = (fn: (m: ChatMessage) => ChatMessage) =>
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = fn(next[next.length - 1]!);
          return next;
        });
      try {
        for await (const event of props.session.send(text, controller.signal)) {
          if (event.type === "text") {
            setActivity("writing the reply");
            patch((m) => ({ ...m, text: m.text + event.text }));
          } else if (event.type === "thinking") {
            // The harness is alive but silent. Say so rather than freezing the
            // label on whatever the last tool happened to be.
            setActivity("thinking");
          } else if (event.type === "tool") {
            setActivity(event.title.split("\n")[0] ?? "working");
            patch((m) => ({
              ...m,
              tools: [
                ...(m.tools ?? []),
                { title: event.title, startedAt: Date.now() },
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
              return { ...m, tools };
            });
          } else if (event.type === "done") {
            patch((m) => ({ ...m, text: event.text || m.text }));
          } else if (event.type === "error") {
            patch((m) => ({ ...m, error: event.message }));
          }
        }
      } finally {
        setBusy(false);
        setBusySince(undefined);
        abortRef.current = null;
      }
    },
    [props.session],
  );

  // The wheel scrolls the transcript. Three rows per notch is what every
  // terminal pager does; one row feels broken and a page feels like a jump.
  useEffect(() => {
    if (!mouse.enabled) return;
    return mouse.onMouse((event) => {
      if (event.kind === "wheel-up") scrollBy(3);
      else if (event.kind === "wheel-down") scrollBy(-3);
    });
  }, [scrollBy]);

  useInput((char, key) => {
    // ^c interrupts the TURN. It never quits: losing an app mid-answer because
    // you wanted the answer to stop is the wrong trade.
    if (key.ctrl && char === "c") {
      abortRef.current?.abort();
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
    // Scrolling works WHILE A TURN IS RUNNING — reading back is exactly what
    // you do while waiting — so it sits above the `busy` gate.
    const page = Math.max(1, pageRef.current - 1);
    if (key.pageUp) return scrollBy(page);
    if (key.pageDown) return scrollBy(-page);
    if (key.shift && key.upArrow) return scrollBy(1);
    if (key.shift && key.downArrow) return scrollBy(-1);
    if (key.home) return scrollBy(Number.MAX_SAFE_INTEGER);
    if (key.end) return scrollBy(-Number.MAX_SAFE_INTEGER);
    if (busy) return;
    if (key.upArrow || key.downArrow) {
      const sent = messages.filter((m) => m.role === "user").map((m) => m.text);
      if (sent.length === 0) return;
      const at =
        historyIndex === null
          ? key.upArrow
            ? sent.length - 1
            : null
          : Math.min(
              sent.length - 1,
              Math.max(0, historyIndex + (key.upArrow ? -1 : 1)),
            );
      setHistoryIndex(at);
      setInputValue(at === null ? "" : (sent[at] ?? ""));
      return;
    }
    if (key.return) {
      const text = input.trim();
      if (!text) return;
      setInputValue("");
      setHistoryIndex(null);
      void submit(text);
      return;
    }
    if (key.backspace || key.delete) {
      setInputValue(inputRef.current.slice(0, -1));
      return;
    }
    if (char && !key.ctrl && !key.meta) {
      // A chunk can carry a newline INSIDE it: a paste, or a terminal that
      // batched keystrokes. Shared with the wizard's name field, which had the
      // same bug — see `textInput.ts`.
      // From the REF: two keystrokes can land between renders, and reading
      // `input` out of the closure loses the first of them.
      const applied = applyTextChunk(inputRef.current, char);
      setInputValue(applied.text);
      if (applied.submit) {
        setHistoryIndex(null);
        if (!busy) void submit(applied.submit);
      }
    }
  });

  const size = useTerminalSize();
  const rows = viewportRows(size, CHAT_CHROME_ROWS + frameChromeRows());
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
      footer={[
        { icon: badge.send, key: "↵", label: "Send" },
        { icon: badge.history, key: "↑↓", label: "History" },
        { icon: badge.scroll, key: "PgUp/PgDn", label: "Scroll" },
        {
          icon: badge.settings,
          key: "^s",
          label: "Settings",
          onPress: props.onSettings,
        },
        { icon: badge.quit, key: "^q", label: "Quit" },
      ]}
    >
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {lines.length === 0 ? (
          <Text color={theme.dim}>
            Say something to {props.session.persona}. ^s for settings.
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
      <Box
        borderStyle="round"
        borderColor={busy ? theme.dim : theme.accent}
        paddingX={1}
      >
        <Text color={busy ? theme.dim : theme.accent}>{"› "}</Text>
        <Text>{input}</Text>
        <Text color={theme.accent}>{busy ? "" : "▌"}</Text>
      </Box>
    </Frame>
  );
}
