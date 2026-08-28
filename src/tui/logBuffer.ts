/**
 * The log pane's store: a bounded ring of recent log lines.
 *
 * While the TUI runs, log output is CAPTURED rather than printed (see
 * `lib/logSink.ts`) — otherwise the orchestrator's JSON lines land on top of
 * the frame, which is what made the app look like a widget pasted into a shell.
 * Captured is not discarded, though: `^l` shows this buffer, so "what is it
 * doing?" is still answerable without leaving the app or tailing a file.
 *
 * Bounded on purpose. A long-running session with debug logging on would
 * otherwise grow without limit in a process the user never restarts.
 */

export interface LogLine {
  at: number;
  level: string;
  msg: string;
  /** The original line, for anything the parse missed. */
  raw: string;
}

export class LogBuffer {
  private lines: LogLine[] = [];
  private listeners = new Set<() => void>();

  constructor(private readonly limit = 500) {}

  /** Accepts a raw sink line (may contain several newline-separated lines). */
  push(chunk: string): void {
    for (const raw of chunk.split("\n")) {
      if (!raw.trim()) continue;
      this.lines.push(parseLogLine(raw));
    }
    if (this.lines.length > this.limit) {
      this.lines.splice(0, this.lines.length - this.limit);
    }
    for (const listener of [...this.listeners]) listener();
  }

  /** Most recent last. */
  all(): readonly LogLine[] {
    return this.lines;
  }

  /** The last `n` lines, oldest first. */
  tail(n: number): LogLine[] {
    return this.lines.slice(Math.max(0, this.lines.length - n));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * Parse a logger line. The logger writes JSON, but a harness's stderr is
 * captured into the same buffer and is free-form — so a line that is not JSON
 * is kept verbatim rather than dropped, at level `raw`.
 */
export function parseLogLine(raw: string): LogLine {
  try {
    const parsed = JSON.parse(raw) as {
      ts?: string;
      level?: string;
      msg?: string;
    };
    if (parsed && typeof parsed === "object" && parsed.msg !== undefined) {
      return {
        at: parsed.ts ? Date.parse(parsed.ts) : Date.now(),
        level: parsed.level ?? "info",
        msg: String(parsed.msg),
        raw,
      };
    }
  } catch {
    // Not JSON: harness stderr, a stack trace, a warning from a dependency.
  }
  return { at: Date.now(), level: "raw", msg: raw, raw };
}

/** The process-wide buffer the TUI installs as the log sink. */
export const logBuffer = new LogBuffer();
