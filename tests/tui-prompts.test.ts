/**
 * Value and choice prompts are clack, and the terminal is handed over around
 * them. (Yes/no lives in the app now — see tests/tui-confirm.test.tsx.)
 *
 * Two things have to hold or the app breaks in ways a screenshot does not
 * show: a CANCELLED prompt must change nothing, and the renderer must be
 * suspended for the whole prompt and resumed exactly once afterwards — Ink
 * cannot be paused, so an un-bracketed prompt interleaves two applications on
 * one screen.
 */

import { describe, expect, mock, test } from "bun:test";

const CANCEL = Symbol.for("clack.cancel");
let passwordAnswer: unknown = "hunter2";

mock.module("@clack/prompts", () => ({
  intro: () => {},
  outro: () => {},
  cancel: () => {},
  note: () => {},
  isCancel: (v: unknown) => v === CANCEL,
  password: async () => passwordAnswer,
  text: async () => passwordAnswer,
  select: async () => passwordAnswer,
}));

const { promptValue, setPromptHost, withPromptTerminal } =
  await import("../src/tui/prompts.ts");

describe("promptValue", () => {
  test("a cancelled secret is undefined, never an empty string", async () => {
    // The difference matters: "" would be written to the vault as a value,
    // erasing a credential the user only meant to look at.
    passwordAnswer = CANCEL;
    expect(
      await promptValue({ message: "Set TOKEN", masked: true }),
    ).toBeUndefined();
    passwordAnswer = "hunter2";
    expect(await promptValue({ message: "Set TOKEN", masked: true })).toBe(
      "hunter2",
    );
  });
});

describe("the prompt host", () => {
  test("brackets the prompt, and unbrackets even when it throws", async () => {
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
      passwordAnswer = "hunter2";
      await promptValue({ message: "Set TOKEN", masked: true });
      expect(events).toEqual(["suspend", "resume"]);
      events.length = 0;
      await expect(
        withPromptTerminal(async () => {
          throw new Error("prompt blew up");
        }),
      ).rejects.toThrow("prompt blew up");
      // A throwing prompt that never resumed would leave the user staring at a
      // frozen frame with mouse reporting off and no keys forwarded.
      expect(events).toEqual(["suspend", "resume"]);
    } finally {
      restore();
    }
  });

  test("without a host installed the prompt still runs — tests and non-TUI callers", async () => {
    passwordAnswer = "hunter2";
    expect(await promptValue({ message: "Set TOKEN", masked: true })).toBe(
      "hunter2",
    );
  });
});
