/**
 * Where log lines go.
 *
 * The logger writes JSON lines to stderr, which is correct for a daemon and
 * wrong for a full-screen app: stderr is the same terminal the TUI is drawing
 * on, so every `log.info` lands on top of the frame. That is exactly what a
 * user sees as "logs underneath the box" — the app looks broken and the frame
 * shears where a line wraps.
 *
 * So the destination is installable. Nothing about WHAT is logged changes:
 * levels, redaction and formatting all stay in `logger.ts`. This module only
 * owns the last hop, and the default hop is the same `process.stderr.write` as
 * before, so every non-TUI entrypoint is byte-identical.
 *
 * The TUI installs a sink that appends to a ring buffer (`^l` shows it) and
 * removes it on exit. It is deliberately a single sink rather than a list: two
 * writers to one terminal is the bug being fixed here, not a feature.
 */

export type LogSink = (line: string) => void;

const defaultSink: LogSink = (line) => {
  process.stderr.write(line);
};

let current: LogSink = defaultSink;

/** Install a sink; returns a function restoring the previous one. */
export function setLogSink(sink: LogSink): () => void {
  const previous = current;
  current = sink;
  return () => {
    current = previous;
  };
}

/** Route one already-formatted, already-redacted line. */
export function writeLogLine(line: string): void {
  current(line);
}

/** True when logs are being captured rather than written to the terminal. */
export function logSinkIsCaptured(): boolean {
  return current !== defaultSink;
}
