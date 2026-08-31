/**
 * The bare-invocation gate (issue #471).
 *
 * These tests exist because getting this backwards is silent and expensive:
 * an argv-based gate makes CI's `phantombot` smoke test write to disk, and
 * makes `phantombot | head` hang forever on a renderer nobody is watching.
 */

import { describe, expect, test } from "bun:test";

import {
  bareInvocationMode,
  currentTty,
  shouldOpenTui,
  NO_TUI_FLAG,
} from "../src/lib/tuiGate.ts";
import { isReadOnlyInvocation } from "../src/lib/cliInvocation.ts";

const argv = (...args: string[]) => ["/usr/bin/bun", "phantombot", ...args];
const tty = (stdin: boolean, stdout: boolean) => ({ stdin, stdout });

describe("bareInvocationMode", () => {
  test("bare on a TTY opens the TUI", () => {
    expect(bareInvocationMode(argv(), tty(true, true))).toBe("tui");
    expect(shouldOpenTui(argv(), tty(true, true))).toBe(true);
  });

  test("bare with stdout redirected prints usage, never the TUI", () => {
    expect(bareInvocationMode(argv(), tty(true, false))).toBe("usage");
  });

  test("bare with stdin piped prints usage, never the TUI", () => {
    // `echo hi | phantombot` must not open a full-screen app.
    expect(bareInvocationMode(argv(), tty(false, true))).toBe("usage");
  });

  test("bare with neither (CI, cron) prints usage", () => {
    expect(bareInvocationMode(argv(), tty(false, false))).toBe("usage");
    expect(shouldOpenTui(argv(), tty(false, false))).toBe(false);
  });

  test("--no-tui gives the line-mode REPL when there is a keyboard", () => {
    expect(bareInvocationMode(argv(NO_TUI_FLAG), tty(true, true))).toBe("repl");
    expect(bareInvocationMode(argv(NO_TUI_FLAG), tty(true, false))).toBe("repl");
  });

  test("--no-tui with no keyboard falls back to usage", () => {
    expect(bareInvocationMode(argv(NO_TUI_FLAG), tty(false, true))).toBe(
      "usage",
    );
  });

  test("every other invocation is Citty's business, TTY or not", () => {
    for (const args of [
      ["--help"],
      ["--version"],
      ["help"],
      ["_complete", "--", "do"],
      ["doctor"],
      ["persona", "new", "x"],
      // --no-tui is only meaningful bare; it must not change a subcommand.
      ["doctor", NO_TUI_FLAG],
    ]) {
      expect(bareInvocationMode(argv(...args), tty(true, true))).toBe("usage");
    }
  });
});

describe("the gate does not change isReadOnlyInvocation", () => {
  test("bare is still read-only by that predicate", () => {
    // The TUI is a SECOND question asked after this one, not a redefinition of
    // it: CI's smoke test and every <TAB> still take the read-only path.
    expect(isReadOnlyInvocation(argv())).toBe(true);
    expect(isReadOnlyInvocation(argv("--help"))).toBe(true);
    expect(isReadOnlyInvocation(argv("_complete"))).toBe(true);
  });

  test("--no-tui is not read-only — the REPL needs the vault", () => {
    expect(isReadOnlyInvocation(argv(NO_TUI_FLAG))).toBe(false);
  });
});

describe("currentTty", () => {
  test("reads isTTY off a process-like object, defaulting to false", () => {
    expect(currentTty({ stdin: {}, stdout: {} })).toEqual({
      stdin: false,
      stdout: false,
    });
    expect(
      currentTty({ stdin: { isTTY: true }, stdout: { isTTY: true } }),
    ).toEqual({ stdin: true, stdout: true });
  });
});
