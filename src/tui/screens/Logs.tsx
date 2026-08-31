/**
 * Screen 10 — the log pane (`^l`).
 *
 * Log output used to be printed straight to the terminal the app draws on, so
 * a chat reply arrived with JSON lines stacked underneath it and the frame
 * shredded wherever one wrapped. The TUI now captures those lines instead
 * (`lib/logSink.ts` → `logBuffer.ts`), and this is where they went: capturing
 * output the user cannot reach would be hiding a failure, not fixing a layout.
 *
 * Newest at the bottom, the same direction as a terminal, clipped to the
 * window by the same rule as the transcript.
 */

import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";

import { Frame } from "../components/Frame.tsx";
import { logBuffer, type LogLine } from "../logBuffer.ts";
import { badge, theme } from "../theme.ts";
import { useTerminalSize, viewportRows } from "../terminal.ts";
import { frameChromeRows } from "../chrome.ts";

export const LEVEL_COLOR: Record<string, string> = {
  error: theme.bad,
  warn: theme.warn,
  info: theme.ok,
  debug: theme.dim,
  raw: theme.dim,
};

export function timeOf(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export function LogsScreen(props: {
  onBack: () => void;
}): React.ReactElement {
  const size = useTerminalSize();
  const rows = viewportRows(size, 6 + frameChromeRows());
  const [lines, setLines] = useState<LogLine[]>(() => logBuffer.tail(rows));

  // Re-read on every push rather than holding a copy: the buffer is the store.
  useEffect(() => {
    const update = () => setLines(logBuffer.tail(rows));
    update();
    return logBuffer.subscribe(update);
  }, [rows]);

  useInput((_char, key) => {
    if (key.escape) props.onBack();
  });

  return (
    <Frame
      title={["phantombot", "host logs"]}
      status={`${logBuffer.all().length} lines captured`}
      footer={[{ icon: badge.back, key: "esc", label: "Back" }]}
    >
      <Box flexDirection="column" overflow="hidden">
        {lines.length === 0 ? (
          <Text color={theme.dim}>
            Nothing logged yet — this fills up as the phantom works.
          </Text>
        ) : (
          lines.map((line, i) => (
            <Box key={i}>
              <Text color={theme.dim}>{timeOf(line.at)} </Text>
              <Box width={6}>
                <Text color={LEVEL_COLOR[line.level] ?? theme.dim}>
                  {line.level}
                </Text>
              </Box>
              <Box flexGrow={1}>
                <Text wrap="truncate">{line.msg}</Text>
              </Box>
            </Box>
          ))
        )}
      </Box>
    </Frame>
  );
}
