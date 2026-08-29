/**
 * TUI signal-exit handlers (phantombot#485).
 *
 * `process.once("SIGINT", restore)` alone SUPPRESSES Node's default
 * termination: an outside `kill` restored the terminal and the app kept
 * running, painting over the user's shell until a second signal arrived.
 * The handler must restore, then exit with 128 + signal.
 */
import { describe, expect, test } from "bun:test";

import { installSignalExit } from "../src/tui/index.tsx";

function fakeExit(calls: string[]): (code: number) => never {
  return ((code: number) => {
    calls.push(`exit:${code}`);
    return undefined as never;
  }) as (code: number) => never;
}

describe("installSignalExit", () => {
  test("SIGINT restores the terminal, then exits 130", () => {
    const calls: string[] = [];
    const teardown = installSignalExit(
      () => calls.push("restore"),
      fakeExit(calls),
    );
    try {
      process.emit("SIGINT");
      expect(calls).toEqual(["restore", "exit:130"]);
    } finally {
      teardown();
    }
  });

  test("SIGTERM restores the terminal, then exits 143", () => {
    const calls: string[] = [];
    const teardown = installSignalExit(
      () => calls.push("restore"),
      fakeExit(calls),
    );
    try {
      process.emit("SIGTERM");
      expect(calls).toEqual(["restore", "exit:143"]);
    } finally {
      teardown();
    }
  });

  test("a second signal does nothing — `once` consumed the handler", () => {
    const calls: string[] = [];
    // Other test files share this process and may hold their own SIGINT
    // listeners, so only the RELATIVE count proves our handler is gone.
    const countBefore = process.listenerCount("SIGINT");
    const teardown = installSignalExit(
      () => calls.push("restore"),
      fakeExit(calls),
    );
    expect(process.listenerCount("SIGINT")).toBe(countBefore + 1);
    try {
      process.emit("SIGINT");
      expect(calls).toEqual(["restore", "exit:130"]);
      // Emitting a bare second SIGINT could terminate the test runner itself —
      // the consumed handler is proven by the listener count dropping back.
      expect(process.listenerCount("SIGINT")).toBe(countBefore);
    } finally {
      teardown();
    }
  });

  test("teardown removes all listeners, including the exit backstop", () => {
    const calls: string[] = [];
    const exitCountBefore = process.listenerCount("exit");
    const teardown = installSignalExit(
      () => calls.push("restore"),
      fakeExit(calls),
    );
    expect(process.listenerCount("exit")).toBe(exitCountBefore + 1);
    teardown();
    expect(process.listenerCount("exit")).toBe(exitCountBefore);
    // A sacrificial listener keeps the runner alive if ours is the only
    // SIGINT listener — a bare emit with zero listeners exits the process.
    const noop = () => {};
    process.on("SIGINT", noop);
    process.emit("SIGINT");
    process.off("SIGINT", noop);
    expect(calls).toEqual([]);
  });
});
