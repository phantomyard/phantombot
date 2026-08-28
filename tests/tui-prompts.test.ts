/**
 * The terminal hand-over bracket.
 *
 * Nothing is ASKED here any more — yes/no, a typed value and a list are all
 * screens inside the app (tests/tui-confirm.test.tsx, tests/tui-ask.test.tsx).
 * What is left is the bracket that lends the terminal to `$EDITOR` and to the
 * remaining clack subcommand flows, and it has to suspend for the whole call
 * and resume exactly once afterwards — Ink cannot be paused, so an
 * un-bracketed hand-over interleaves two applications on one screen.
 */

import { describe, expect, test } from "bun:test";

const { setPromptHost, withPromptTerminal } =
  await import("../src/tui/prompts.ts");

describe("the prompt host", () => {
  test("brackets the call, and unbrackets even when it throws", async () => {
    const events: string[] = [];
    const restore = setPromptHost(async (fn) => {
      events.push("suspend");
      try {
        return await fn();
      } finally {
        events.push("resume");
      }
    });
    try {
      expect(await withPromptTerminal(async () => "ok")).toBe("ok");
      expect(events).toEqual(["suspend", "resume"]);
      events.length = 0;
      await expect(
        withPromptTerminal(async () => {
          throw new Error("prompt blew up");
        }),
      ).rejects.toThrow("prompt blew up");
      // A throwing hand-over that never resumed would leave the user staring
      // at a frozen frame with mouse reporting off and no keys forwarded.
      expect(events).toEqual(["suspend", "resume"]);
    } finally {
      restore();
    }
  });

  test("without a host installed the call still runs — tests and non-TUI callers", async () => {
    expect(await withPromptTerminal(async () => "ran")).toBe("ran");
  });
});
