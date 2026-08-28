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
import { glyph, humanDuration, theme } from "../theme.ts";
import { useTerminalSize, viewportRows } from "../terminal.ts";
import { visibleMessages } from "../transcript.ts";
import { applyTextChunk } from "../textInput.ts";
import type { ChatMessage, ChatSession, ChatToolCall } from "../chatSession.ts";

/**
 * Rows the chat chrome takes: frame border (2), title (1), title gap (1),
 * activity line (1), input box (3), footer (1), and one row of slack.
 *
 * A constant, not a measurement: measuring would mean a component reading the
 * layout back out of Yoga mid-render, and being one row conservative costs a
 * blank line while being one row optimistic tears the frame.
 */
export const CHAT_CHROME_ROWS = 10;

/**
 * `14:07`, or nothing at all.
 *
 * History loaded from the memory store carries no timestamp (`at: 0`), and
 * stamping those rows with `new Date()` labelled yesterday's conversation with
 * this minute — every message in a reopened thread claimed to have been sent
 * seconds ago. An absent time is honest; a wrong one is not.
 */
function timeOf(at: number): string {
  if (!at) return "";
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * The tool calls behind one reply — collapsed to a single summary row, or
 * expanded to one row per call.
 *
 * The first cut rendered the same single line in both states, because a
 * progress note is one line long: `^t` was wired, handled, and had no visible
 * effect whatsoever, which reads to a user as a broken key. Collapsed is now
 * genuinely a SUMMARY — how many steps and how long they took, which is what
 * you want while reading an answer — and expanded is the itemised list with
 * each step's own duration.
 *
 * `transcript.ts` measures these rows for clipping, so the two must agree on
 * how many lines each state occupies.
 */
function Tools(props: {
  tools: ChatToolCall[];
  expanded: boolean;
}): React.ReactElement | null {
  if (props.tools.length === 0) return null;
  if (props.expanded) {
    return (
      <>
        {props.tools.map((tool, i) => (
          <Box key={i} paddingLeft={2}>
            <Text color={theme.dim}>
              {"› "}
              {tool.title}
            </Text>
            <Box flexGrow={1} />
            <Text color={theme.dim}>
              {tool.durationMs === undefined
                ? "…"
                : humanDuration(tool.durationMs)}
            </Text>
          </Box>
        ))}
      </>
    );
  }
  const done = props.tools.filter((t) => t.durationMs !== undefined);
  const total = done.reduce((ms, t) => ms + (t.durationMs ?? 0), 0);
  const running = props.tools.length - done.length;
  return (
    <Box paddingLeft={2}>
      <Text color={theme.dim}>
        {`› ${props.tools.length} step${props.tools.length === 1 ? "" : "s"}`}
        {running > 0 ? " · running" : total > 0 ? ` · ${humanDuration(total)}` : ""}
      </Text>
      <Box flexGrow={1} />
      <Text color={theme.dim}>^t details</Text>
    </Box>
  );
}

function Message(props: {
  message: ChatMessage;
  showTools: boolean;
  personaName: string;
}): React.ReactElement {
  const isUser = props.message.role === "user";
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text
          backgroundColor={isUser ? theme.accent : theme.ok}
          color="black"
          bold
        >
          {` ${isUser ? "you" : props.personaName} `}
        </Text>
        <Text color={theme.dim}>
          {props.message.at ? `  ${timeOf(props.message.at)}` : ""}
        </Text>
      </Box>
      <Tools tools={props.message.tools ?? []} expanded={props.showTools} />
      <Box paddingLeft={2}>
        <Text color={props.message.error ? theme.bad : undefined}>
          {props.message.error ?? props.message.text}
        </Text>
      </Box>
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
  onSwitchPersona: () => void;
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
  const [showTools, setShowTools] = useState(false);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Reset the transcript when the session changes (^p switched phantom).
  useEffect(() => {
    setMessages(props.session.history);
  }, [props.session]);

  const submit = useCallback(
    async (text: string) => {
      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(true);
      setBusySince(Date.now());
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
    if (key.ctrl && char === "p") {
      props.onSwitchPersona();
      return;
    }
    if (key.ctrl && char === "t") {
      setShowTools((v) => !v);
      return;
    }
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
  const rows = viewportRows(size, CHAT_CHROME_ROWS);
  // Clip before layout: overflowing the window is what pushes the border off
  // the bottom of the screen. See `transcript.ts`.
  const shown = visibleMessages(messages, rows, size.columns, { showTools });

  return (
    <Frame
      title={[props.session.persona]}
      status={props.status}
      footer={[
        { key: "↵", label: "send" },
        { key: "↑↓", label: "history" },
        { key: "^t", label: showTools ? "hide steps" : "steps" },
        { key: "^c", label: "interrupt" },
        { key: `${glyph.gear} ^s`, label: "settings", onPress: props.onSettings },
        { key: "^p", label: "phantoms" },
        { key: "^q", label: "quit" },
      ]}
    >
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {shown.length === 0 ? (
          <Text color={theme.dim}>
            Say something to {props.session.persona}. ^s for settings.
          </Text>
        ) : (
          shown.map((message, i) => (
            <Message
              key={`${messages.length - shown.length + i}`}
              message={message}
              showTools={showTools}
              personaName={props.session.persona}
            />
          ))
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
