/**
 * Lending stdin to a `@clack` prompt (or `$EDITOR`) and getting it back.
 *
 * The failure this pins is a WEDGE, not a cosmetic one. Suspending the TUI
 * detaches its `data` tap, which removes the last `data` listener and drops
 * Node's stdin out of flowing mode. `readline` — which every clack prompt is
 * built on — listens for `keypress`, not `data`, and never resumes the stream
 * itself. So the prompt drew, the cursor blinked, and no keystroke arrived:
 * not an answer, and not the ^c that would have cancelled it. Reproduced live
 * on the Telegram-token prompt: the only way out was killing the process.
 */

import { describe, expect, test } from "bun:test";

import { lendStdin } from "../src/tui/stdinHandover.ts";

function fakeStream() {
  const map = new Map<string, Array<(...a: unknown[]) => void>>();
  let resumed = 0;
  return {
    resumeCount: () => resumed,
    listeners: (event: string) => [...(map.get(event) ?? [])],
    listenerCount: (event: string) => (map.get(event) ?? []).length,
    off(event: string, fn: (...a: unknown[]) => void) {
      map.set(event, (map.get(event) ?? []).filter((f) => f !== fn));
      return this;
    },
    resume() {
      resumed += 1;
    },
    add(event: string, fn: (...a: unknown[]) => void) {
      map.set(event, [...(map.get(event) ?? []), fn]);
    },
  };
}

describe("lendStdin", () => {
  test("resumes the stream BEFORE the borrower reads from it", () => {
    const stream = fakeStream();
    expect(stream.resumeCount()).toBe(0);

    lendStdin(stream as never);

    // Resumed on the way out, not on the way back: a prompt that only gets a
    // flowing stream after it has finished got nothing while it ran.
    expect(stream.resumeCount()).toBe(1);
  });

  test("still restores the listener set the borrower changed", () => {
    const stream = fakeStream();
    const ours = () => {};
    stream.add("data", ours);

    const takeBack = lendStdin(stream as never);
    stream.add("keypress", () => {});
    stream.add("data", () => {});
    takeBack();

    expect(stream.listeners("data")).toEqual([ours]);
    expect(stream.listenerCount("keypress")).toBe(0);
  });

  test("survives a stream with no resume (a non-TTY stand-in)", () => {
    const stream = fakeStream() as Record<string, unknown>;
    delete stream.resume;
    expect(() => lendStdin(stream as never)()).not.toThrow();
  });
});

describe("lendStdin keeps the stream flowing for the WHOLE borrow", () => {
  /**
   * A borrow is not always one prompt. `phantombot harness` asks a sequence,
   * and each readline interface pauses stdin when it closes — so the second
   * prompt onwards renders against a dead stream even though the borrow
   * resumed it on the way in. That is the Brain wedge.
   */
  test("re-resumes a stream that a closed prompt paused", async () => {
    const stream = fakeStream();
    let paused = false;
    const borrowable = {
      ...stream,
      isPaused: () => paused,
      resume() {
        paused = false;
        stream.resume();
      },
    };
    const takeBack = lendStdin(borrowable as never, { pollMs: 5 });
    const afterLend = stream.resumeCount();

    paused = true; // a clack prompt closed its readline
    await new Promise((r) => setTimeout(r, 30));

    expect(stream.resumeCount()).toBeGreaterThan(afterLend);
    expect(paused).toBe(false);
    takeBack();
  });

  test("stops re-resuming once the terminal is taken back", async () => {
    const stream = fakeStream();
    let paused = false;
    const borrowable = {
      ...stream,
      isPaused: () => paused,
      resume() {
        paused = false;
        stream.resume();
      },
    };
    const takeBack = lendStdin(borrowable as never, { pollMs: 5 });
    takeBack();
    const settled = stream.resumeCount();
    paused = true;
    await new Promise((r) => setTimeout(r, 30));
    expect(stream.resumeCount()).toBe(settled);
  });
});
