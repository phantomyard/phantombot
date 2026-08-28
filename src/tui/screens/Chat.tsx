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
import type { ChatMessage, ChatSession } from "../chatSession.ts";

/**
 * Rows the chat chrome takes: frame border (2), title (1), title gap (1),
 * activity line (1), input box (3), footer (1), and one row of slack.
 *
 * A constant, not a measurement: measuring would mean a component reading the
 * layout back out of Yoga mid-render, and being one row conservative costs a
 * blank line while being one row optimistic tears the frame.
 */
export const CHAT_CHROME_ROWS = 10;

function timeOf(at: number): string {
  const d = at ? new Date(at) : new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
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
        <Text color={theme.dim}>{"  " + timeOf(props.message.at)}</Text>
      </Box>
      {(props.message.tools ?? []).map((tool, i) => (
        <Box key={i} paddingLeft={2}>
          <Text color={theme.dim}>
            {"› "}
            {props.showTools ? tool.title : tool.title.split("\n")[0]}
          </Text>
          <Box flexGrow={1} />
          <Text color={theme.dim}>
            {tool.durationMs === undefined
              ? "…"
              : humanDuration(tool.durationMs)}
          </Text>
        </Box>
      ))}
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
  const [input, setInput] = useState("");
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
      setInput(at === null ? "" : (sent[at] ?? ""));
      return;
    }
    if (key.return) {
      const text = input.trim();
      if (!text) return;
      setInput("");
      setHistoryIndex(null);
      void submit(text);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((v) => v.slice(0, -1));
      return;
    }
    if (char && !key.ctrl && !key.meta) {
      // A chunk can carry a newline INSIDE it: a paste, or a terminal that
      // batched keystrokes. Ink only reports `key.return` for a chunk that is
      // exactly "\r", so without this the newline is typed into the box as a
      // literal character and the message is never sent.
      const parts = char.split(/\r\n|\r|\n/);
      if (parts.length === 1) {
        setInput((v) => v + char);
        return;
      }
      const head = parts[0] ?? "";
      const rest = parts.slice(1).join(" ").trim();
      const text = (input + head).trim();
      setInput(rest);
      setHistoryIndex(null);
      if (text && !busy) void submit(text);
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
        { key: "^t", label: "tools" },
        { key: "^c", label: "interrupt" },
        { key: `${glyph.gear} ^s`, label: "settings", onPress: props.onSettings },
        { key: "^p", label: "phantom" },
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
