import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";

import { Frame, Rule } from "../components/Frame.tsx";
import { badge, glyph, theme } from "../theme.ts";
import { logBuffer, type LogLine } from "../logBuffer.ts";
import type { SystemSnapshot, SystemState } from "../systemSnapshot.ts";
import { useTerminalSize, viewportRows } from "../terminal.ts";
import { frameChromeRows } from "../chrome.ts";
import { timeOf, LEVEL_COLOR } from "./Logs.tsx";

export type LogTimeRange = "15m" | "1h" | "24h" | "all";
export interface LogFilters {
  type: string;
  persona: string;
  time: LogTimeRange;
  text: string;
}

export function filterLogs(
  lines: readonly LogLine[],
  filters: LogFilters,
  now = Date.now(),
): LogLine[] {
  const windows: Record<LogTimeRange, number> = {
    "15m": 900_000,
    "1h": 3_600_000,
    "24h": 86_400_000,
    all: Infinity,
  };
  const needle = filters.text.toLowerCase();
  return lines.filter(
    (line) =>
      (filters.type === "all" || line.type === filters.type) &&
      (filters.persona === "all" || line.persona === filters.persona) &&
      now - line.at <= windows[filters.time] &&
      (!needle || `${line.msg} ${line.raw}`.toLowerCase().includes(needle)),
  );
}

const stateColor: Record<SystemState, string> = {
  healthy: theme.ok,
  running: theme.ok,
  delayed: theme.warn,
  failed: theme.bad,
  unavailable: theme.dim,
};

function shortTime(value?: string): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function spark(values: number[]): string {
  return values.length ? values.map((v) => (v ? "▇" : "▁")).join("") : "—";
}

export function SystemScreen(props: {
  snapshot: SystemSnapshot;
  personas: string[];
  onBack: () => void;
}): React.ReactElement {
  const [tab, setTab] = useState<"overview" | "logs">("overview");
  const [type, setType] = useState("all");
  const [persona, setPersona] = useState("all");
  const [time, setTime] = useState<LogTimeRange>("1h");
  const [text, setText] = useState("");
  const [lines, setLines] = useState<readonly LogLine[]>(logBuffer.all());
  const size = useTerminalSize();
  const rows = viewportRows(size, 9 + frameChromeRows());
  const types = useMemo(
    () => [
      "all",
      ...new Set(
        lines.map((line) => line.type).filter((v): v is string => Boolean(v)),
      ),
    ],
    [lines],
  );
  const personas = ["all", ...props.personas];
  const times: LogTimeRange[] = ["15m", "1h", "24h", "all"];

  useEffect(
    () => logBuffer.subscribe(() => setLines([...logBuffer.all()])),
    [],
  );
  const filtered = useMemo(
    () => filterLogs(lines, { type, persona, time, text }).slice(-rows),
    [lines, type, persona, time, text, rows],
  );

  useInput((char, key) => {
    if (key.escape) return props.onBack();
    if (key.tab || char === "o" || char === "l")
      return setTab(tab === "overview" ? "logs" : "overview");
    if (tab !== "logs") return;
    if (char === "v") setType(types[(types.indexOf(type) + 1) % types.length]!);
    else if (char === "p")
      setPersona(personas[(personas.indexOf(persona) + 1) % personas.length]!);
    else if (char === "t")
      setTime(times[(times.indexOf(time) + 1) % times.length]!);
    else if (key.backspace || key.delete) setText((s) => s.slice(0, -1));
    else if (char && !key.ctrl && !key.meta && !key.return)
      setText((s) => s + char);
  });

  return (
    <Frame
      title={["phantombot", "system", tab]}
      status={
        tab === "logs"
          ? `${filtered.length}/${lines.length} lines`
          : `sampled ${shortTime(props.snapshot.capturedAt)}`
      }
      footer={
        tab === "overview"
          ? [
              { icon: badge.open, key: "tab", label: "Logs" },
              { icon: badge.back, key: "esc", label: "Back" },
            ]
          : [
              { icon: badge.change, key: "v", label: `Type ${type}` },
              { icon: badge.phantoms, key: "p", label: `Persona ${persona}` },
              { icon: badge.history, key: "t", label: `Time ${time}` },
              { icon: badge.back, key: "esc", label: "Back" },
            ]
      }
    >
      {tab === "overview" ? (
        <Box flexDirection="column">
          <Box>
            <Text color={theme.accent} bold>
              SERVICES
            </Text>
            <Box flexGrow={1} />
            <Text color={theme.dim}>cross-platform runtime state</Text>
          </Box>
          <Rule />
          <Box>
            <Box width="18%">
              <Text color={theme.dim}>process</Text>
            </Box>
            <Box width="15%">
              <Text color={theme.dim}>state</Text>
            </Box>
            <Box width="29%">
              <Text color={theme.dim}>detail</Text>
            </Box>
            <Box width="12%">
              <Text color={theme.dim}>last</Text>
            </Box>
            <Box width="12%">
              <Text color={theme.dim}>next</Text>
            </Box>
            <Box width="14%">
              <Text color={theme.dim}>recent</Text>
            </Box>
          </Box>
          <Rule />
          {props.snapshot.services.map((service) => (
            <Box key={service.id}>
              <Box width="18%">
                <Text bold>{service.id}</Text>
              </Box>
              <Box width="15%">
                <Text color={stateColor[service.state]}>
                  {service.state === "healthy" || service.state === "running"
                    ? glyph.up
                    : service.state === "unavailable"
                      ? "—"
                      : glyph.warn}{" "}
                  {service.state}
                </Text>
              </Box>
              <Box width="29%">
                <Text wrap="truncate" color={theme.dim}>
                  {service.detail}
                </Text>
              </Box>
              <Box width="12%">
                <Text>{shortTime(service.last)}</Text>
              </Box>
              <Box width="12%">
                <Text>{shortTime(service.next)}</Text>
              </Box>
              <Box width="14%">
                <Text color={service.failures ? theme.bad : theme.ok}>
                  {spark(service.history)}
                </Text>
              </Box>
            </Box>
          ))}
          <Rule />
          <Text color={theme.dim}>
            Unavailable metrics never block the terminal. Failed and delayed
            services remain visible until their runtime markers recover.
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" overflow="hidden">
          <Box>
            <Text color={theme.accent} bold>
              LOGS
            </Text>
            <Box flexGrow={1} />
            <Text color={theme.dim}>
              filter: {text || "—"} (type to search)
            </Text>
          </Box>
          <Rule />
          {filtered.length === 0 ? (
            <Text color={theme.dim}>
              No captured log lines match these filters.
            </Text>
          ) : (
            filtered.map((line, i) => (
              <Box key={`${line.at}-${i}`}>
                <Text color={theme.dim}>{timeOf(line.at)} </Text>
                <Box width={6}>
                  <Text color={LEVEL_COLOR[line.level] ?? theme.dim}>
                    {line.level}
                  </Text>
                </Box>
                <Box width="14%">
                  <Text color={theme.dim} wrap="truncate">
                    {line.persona ?? "host"}
                  </Text>
                </Box>
                <Box flexGrow={1}>
                  <Text wrap="truncate">{line.msg}</Text>
                </Box>
              </Box>
            ))
          )}
        </Box>
      )}
    </Frame>
  );
}
