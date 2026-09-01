import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";

import { Frame, Rule } from "../components/Frame.tsx";
import { badge, glyph, theme } from "../theme.ts";
import { type LogLine } from "../logBuffer.ts";
import {
  DEFAULT_SOURCE_LIMIT,
  logSources,
  EMPTY_SOURCE,
  type LogSource,
} from "../logSources.ts";
import type { HostSnapshot } from "../snapshot.ts";
import type { SystemSnapshot, SystemState } from "../systemSnapshot.ts";
import { useTerminalSize, viewportRows } from "../terminal.ts";
import { frameChromeRows } from "../chrome.ts";
import { maxOffset, nudgeOffset, tailViewport } from "../logViewport.ts";

const LEVEL_COLOR: Record<string, string> = {
  error: theme.bad,
  warn: theme.warn,
  info: theme.ok,
  debug: theme.dim,
  trace: theme.dim,
  raw: theme.dim,
};

function timeOf(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

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
  host: HostSnapshot;
  personas: string[];
  onBack: () => void;
  /** Test seam: the sources to offer instead of reading the real host. */
  sources?: LogSource[];
}): React.ReactElement {
  const [tab, setTab] = useState<"overview" | "logs">("overview");
  const [type, setType] = useState("all");
  const [persona, setPersona] = useState("all");
  // Defaults to `all` (#478): the pane now reads durable sources — an audit
  // file, a journal, task_runs — where the interesting line is usually OLDER
  // than the window. A 1h default silently hid them and read as "no logs".
  const [time, setTime] = useState<LogTimeRange>("all");
  const [text, setText] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const sources = useMemo(
    () => props.sources ?? logSources({ host: props.host }),
    [props.sources, props.host],
  );
  const [sourceIdx, setSourceIdx] = useState(0);
  const source = sources[sourceIdx] ?? EMPTY_SOURCE;
  const [lines, setLines] = useState<readonly LogLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [reloads, setReloads] = useState(0);
  // Lines above the tail; 0 = following the newest line (see logViewport.ts).
  const [offset, setOffset] = useState(0);
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

  // Sources are read on demand, not subscribed to: the daemon's journal and
  // the audit files belong to other processes, so there is nothing to listen
  // to. `r` re-reads; opening the tab reads once.
  useEffect(() => {
    if (tab !== "logs") return;
    let live = true;
    // Aborting on cleanup does more than drop the result: sources that spawn a
    // child (journalctl, tail, PowerShell) kill it, so cycling sources or
    // hammering `r` cannot leave abandoned tailers running.
    const abort = new AbortController();
    setLoading(true);
    source
      .read(DEFAULT_SOURCE_LIMIT, abort.signal)
      .then((read) => {
        if (live) setLines(read);
      })
      .catch((err: unknown) => {
        // A source that throws must not blank the pane — say so in a row.
        if (live)
          setLines([
            {
              at: Date.now(),
              level: "error",
              msg: `could not read ${source.id}: ${String(err)}`,
              type: source.id,
              raw: "",
            },
          ]);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      abort.abort();
    };
  }, [tab, source, reloads]);
  const filtered = useMemo(
    () => filterLogs(lines, { type, persona, time, text }),
    [lines, type, persona, time, text],
  );
  // Reserve the two marker rows only when there is something to hide, so a
  // stream that fits uses the whole window.
  const bodyRows = filtered.length > rows ? Math.max(1, rows - 2) : rows;
  const view = tailViewport(filtered.length, bodyRows, offset);
  const visible = filtered.slice(view.start, view.end);
  // Changing what is being read is a new stream: go back to live rather than
  // holding a scroll position that meant something in the previous one.
  useEffect(() => {
    setOffset(0);
  }, [source, type, persona, time, text, reloads]);

  useInput((char, key) => {
    // Scroll first, and before the search branch: arrows and page keys carry
    // no character, so they are meaningless to the filter box and a user
    // mid-search still expects to be able to look back through the stream.
    if (tab === "logs") {
      const page = Math.max(1, bodyRows - 1);
      const nudge = (delta: number) =>
        setOffset((o) => nudgeOffset(o, delta, filtered.length, bodyRows));
      if (key.upArrow) return nudge(1);
      if (key.downArrow) return nudge(-1);
      if (key.pageUp) return nudge(page);
      if (key.pageDown) return nudge(-page);
      if (key.home) return setOffset(maxOffset(filtered.length, bodyRows));
      if (key.end) return setOffset(0);
    }
    if (tab === "logs" && searchFocused) {
      if (key.escape) return setSearchFocused(false);
      if (key.backspace || key.delete) return setText((s) => s.slice(0, -1));
      if (char && !key.ctrl && !key.meta && !key.return)
        return setText((s) => s + char);
      return;
    }
    if (key.escape) return props.onBack();
    if (key.tab || char === "o" || char === "l")
      return setTab(tab === "overview" ? "logs" : "overview");
    if (tab !== "logs") return;
    if (char === "/") setSearchFocused(true);
    else if (char === "v") setType(types[(types.indexOf(type) + 1) % types.length]!);
    else if (char === "p")
      setPersona(personas[(personas.indexOf(persona) + 1) % personas.length]!);
    else if (char === "t")
      setTime(times[(times.indexOf(time) + 1) % times.length]!);
    else if (char === "s")
      setSourceIdx((i) => (sources.length ? (i + 1) % sources.length : 0));
    else if (char === "r") setReloads((n) => n + 1);
    else if (key.backspace || key.delete) setText((s) => s.slice(0, -1));
    else if (char && !key.ctrl && !key.meta && !key.return)
      setText((s) => s + char);
  });

  return (
    <Frame
      title={["phantombot", "system", tab]}
      status={
        tab === "logs"
          ? `${source.label} · ${filtered.length}/${lines.length} · ${
              view.following ? "following" : `paused ${view.below} from live`
            }${loading ? " · reading…" : ""}`
          : `sampled ${shortTime(props.snapshot.capturedAt)}`
      }
      footer={
        tab === "overview"
          ? [
              { icon: badge.open, key: "tab", label: "Logs" },
              { icon: badge.back, key: "esc", label: "Back" },
            ]
          : [
              {
                icon: badge.open,
                key: searchFocused ? "type" : "/",
                label: searchFocused ? "Search (esc done)" : "Search",
              },
              { icon: badge.history, key: "s", label: `Source ${source.id}` },
              { icon: badge.change, key: "v", label: `Type ${type}` },
              { icon: badge.phantoms, key: "p", label: `Persona ${persona}` },
              { icon: badge.history, key: "t", label: `Time ${time}` },
              { icon: badge.change, key: "r", label: "Reload" },
              {
                icon: badge.history,
                key: "↑↓ pgup/pgdn",
                label: view.following ? "Scroll" : "Scroll (end = live)",
              },
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
              filter: {text || "—"} {searchFocused ? "◂ typing" : "(/ to search)"}
            </Text>
          </Box>
          <Box>
            <Text color={theme.dim} wrap="truncate">
              {glyph.up} {source.location}
            </Text>
          </Box>
          {source.command ? (
            <Box>
              <Text color={theme.dim} wrap="truncate">
                {"  full stream: "}
                {source.command}
              </Text>
            </Box>
          ) : null}
          <Rule />
          {view.above > 0 ? (
            <Text color={theme.dim}>
              {`▲ ${view.above} older — ↑/pgup, home for oldest`}
            </Text>
          ) : null}
          {filtered.length === 0 ? (
            <Text color={theme.dim}>
              {loading
                ? "Reading…"
                : `No lines from ${source.id} match these filters. 's' cycles source, 't' widens the time window.`}
            </Text>
          ) : (
            visible.map((line, i) => (
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
          {view.below > 0 ? (
            <Text color={theme.warn}>
              {`▼ ${view.below} newer — ↓/pgdn, end to follow live`}
            </Text>
          ) : null}
        </Box>
      )}
    </Frame>
  );
}
