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
import { enterFullScreen } from "../src/tui/terminal.ts";

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
      // at a frozen frame with no keys forwarded.
      expect(events).toEqual(["suspend", "resume"]);
    } finally {
      restore();
    }
  });

  test("without a host installed the call still runs — tests and non-TUI callers", async () => {
    expect(await withPromptTerminal(async () => "ran")).toBe("ran");
  });
});

// Model only the terminal's documented private-mode operations, independently
// of the application's constants. In particular, DECRST must not masquerade
// as restoring a terminal whose alternate-scroll mode was initially enabled.
for (const initial of [false, true]) {
  for (const saveRestoreSupported of [false, true]) {
    test(`handovers preserve alternate scrolling (initial=${initial}, save/restore=${saveRestoreSupported})`, async () => {
      let alternateScroll = initial;
      let saved = initial;
      const writes: string[] = [];
      const stdout = {
        write(chunk: string) {
          writes.push(chunk);
          for (const match of chunk.matchAll(/\x1b\[\?1007([hlsr])/g)) {
            switch (match[1]) {
              case "h":
                alternateScroll = true;
                break;
              case "l":
                alternateScroll = false;
                break;
              case "s":
                if (saveRestoreSupported) saved = alternateScroll;
                break;
              case "r":
                if (saveRestoreSupported) alternateScroll = saved;
                break;
            }
          }
          return true;
        },
      } as unknown as NodeJS.WriteStream;
      const screen = enterFullScreen(stdout);
      const restoreHost = setPromptHost(async (fn) => {
        screen.restore();
        try {
          return await fn();
        } finally {
          screen.enter();
        }
      });
      const restored = saveRestoreSupported ? initial : true;
      try {
        expect(alternateScroll).toBe(true);
        for (let i = 0; i < 2; i++) {
          expect(
            await withPromptTerminal(async () => {
              expect(alternateScroll).toBe(restored);
              return "borrowed";
            }),
          ).toBe("borrowed");
          expect(alternateScroll).toBe(true);
        }
        await expect(
          withPromptTerminal(async () => {
            expect(alternateScroll).toBe(restored);
            throw new Error("borrower failed");
          }),
        ).rejects.toThrow("borrower failed");
        expect(alternateScroll).toBe(true);
      } finally {
        restoreHost();
        screen.restore();
      }
      expect(alternateScroll).toBe(restored);
      // Overlapping exit handlers must not overwrite or re-restore the slot.
      const count = writes.length;
      screen.restore();
      expect(writes.length).toBe(count);
      expect(writes.join("")).not.toContain("\x1b[?1007l");
    });
  }
}
