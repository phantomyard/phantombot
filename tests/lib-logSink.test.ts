/**
 * Log capture.
 *
 * The user's screenshot showed JSON log lines stacked underneath the frame:
 * the logger writes to stderr, which is the same terminal the TUI draws on, so
 * the app looked broken and the border tore wherever a line wrapped. The fix
 * is an installable sink — captured while the TUI runs, shown on `^l`, and
 * byte-identical to before for every other entrypoint.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { log } from "../src/lib/logger.ts";
import { logSinkIsCaptured, setLogSink } from "../src/lib/logSink.ts";
import { LogBuffer, parseLogLine } from "../src/tui/logBuffer.ts";

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

describe("setLogSink", () => {
  test("captures logger output instead of writing to the terminal", () => {
    const captured: string[] = [];
    restore = setLogSink((line) => captured.push(line));
    log.warn("tui: something happened", { detail: 7 });
    expect(captured).toHaveLength(1);
    const parsed = JSON.parse(captured[0]!) as { msg: string; detail: number };
    expect(parsed.msg).toBe("tui: something happened");
    // Formatting, levels and redaction all stay in the logger: the sink owns
    // only the last hop.
    expect(parsed.detail).toBe(7);
    expect(logSinkIsCaptured()).toBe(true);
  });

  test("restores the previous destination, so the daemon logs to stderr again", () => {
    const undo = setLogSink(() => {});
    expect(logSinkIsCaptured()).toBe(true);
    undo();
    expect(logSinkIsCaptured()).toBe(false);
  });

  test("redaction still applies — the sink must not become a secret leak", () => {
    const captured: string[] = [];
    restore = setLogSink((line) => captured.push(line));
    log.warn("tui: harness failed", {
      error: "TELEGRAM_BOT_TOKEN=123456:super-secret-value",
    });
    expect(captured[0]).not.toContain("super-secret-value");
  });
});

describe("LogBuffer", () => {
  test("parses logger JSON and keeps free-form harness stderr verbatim", () => {
    const json = parseLogLine(
      '{"ts":"2026-08-28T10:00:00.000Z","level":"warn","msg":"hello"}',
    );
    expect(json.level).toBe("warn");
    expect(json.msg).toBe("hello");
    // A harness writes prose and stack traces to stderr. Dropping what does
    // not parse would hide exactly the failure the pane exists to show.
    const raw = parseLogLine("Error: spawn claude ENOENT");
    expect(raw.level).toBe("raw");
    expect(raw.msg).toBe("Error: spawn claude ENOENT");
  });

  test("splits multi-line chunks and stays bounded", () => {
    const buffer = new LogBuffer(3);
    buffer.push("a\nb\n\nc\n");
    buffer.push("d\n");
    // Bounded: a long session with debug logging on would otherwise grow
    // without limit in a process the user never restarts.
    expect(buffer.all().map((l) => l.msg)).toEqual(["b", "c", "d"]);
    expect(buffer.tail(2).map((l) => l.msg)).toEqual(["c", "d"]);
  });

  test("notifies subscribers so the pane repaints as lines land", () => {
    const buffer = new LogBuffer();
    let calls = 0;
    const off = buffer.subscribe(() => calls++);
    buffer.push("one\n");
    expect(calls).toBe(1);
    off();
    buffer.push("two\n");
    expect(calls).toBe(1);
  });
});
