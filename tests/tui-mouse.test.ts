/**
 * Mouse input for the TUI (issue #471).
 *
 * The two behaviours under test are the two findings that dictated the design:
 * mouse bytes must never reach Ink as keystrokes, and a click must go to the
 * TOPMOST registered rect.
 */

import { describe, expect, test } from "bun:test";

import {
  MouseDispatcher,
  hitTest,
  stripMouseSequences,
  MOUSE_ON,
  MOUSE_OFF,
  installMouse,
  type MouseEvent,
} from "../src/tui/mouse.ts";
import { captureStdinListeners } from "../src/tui/stdinHandover.ts";

describe("stripMouseSequences", () => {
  test("decodes a left-click press and release", () => {
    const down = stripMouseSequences("\x1b[<0;42;7M");
    expect(down.events).toEqual([
      { kind: "down", column: 42, row: 7, button: 0 },
    ]);
    const up = stripMouseSequences("\x1b[<0;42;7m");
    expect(up.events[0]!.kind).toBe("up");
  });

  test("decodes wheel up and wheel down", () => {
    expect(stripMouseSequences("\x1b[<64;10;3M").events[0]!.kind).toBe(
      "wheel-up",
    );
    expect(stripMouseSequences("\x1b[<65;10;3M").events[0]!.kind).toBe(
      "wheel-down",
    );
  });

  test("a click leaves NOTHING behind for the keyboard consumer", () => {
    // This is the whole point of the gate: unfiltered, Ink hands `[<0;42;7M`
    // to every useInput handler as a keystroke, so clicking anywhere fires
    // shortcuts at random.
    const { rest } = stripMouseSequences("\x1b[<0;42;7M");
    expect(rest).toBe("");
  });

  test("keystrokes around a mouse report survive intact and in order", () => {
    const { events, rest } = stripMouseSequences("ab\x1b[<0;5;5Mcd\x1b[<0;5;5me");
    expect(rest).toBe("abcde");
    expect(events.map((e) => e.kind)).toEqual(["down", "up"]);
  });

  test("input with no mouse report is passed through untouched", () => {
    const chunk = "hello\r";
    expect(stripMouseSequences(chunk)).toEqual({ events: [], rest: chunk });
  });
});

describe("hitTest", () => {
  const rects = [
    { id: "row", top: 5, left: 1, width: 40, height: 1 },
    { id: "modal", top: 5, left: 1, width: 40, height: 1 },
  ];

  test("a later registration wins — a modal takes the click from the row", () => {
    expect(hitTest(rects, 10, 5)?.id).toBe("modal");
  });

  test("a point outside every rect hits nothing", () => {
    expect(hitTest(rects, 10, 9)).toBeUndefined();
    expect(hitTest(rects, 99, 5)).toBeUndefined();
  });

  test("the rect is half-open: left/top inclusive, right/bottom exclusive", () => {
    const one = [{ id: "a", top: 2, left: 3, width: 2, height: 2 }];
    expect(hitTest(one, 3, 2)?.id).toBe("a");
    expect(hitTest(one, 4, 3)?.id).toBe("a");
    expect(hitTest(one, 5, 3)).toBeUndefined();
    expect(hitTest(one, 4, 4)).toBeUndefined();
  });
});

describe("MouseDispatcher", () => {
  test("routes a click to the topmost handler and reports it handled", () => {
    const d = new MouseDispatcher();
    const fired: string[] = [];
    d.register({ id: "under", top: 1, left: 1, width: 10, height: 1 }, () =>
      fired.push("under"),
    );
    d.register({ id: "over", top: 1, left: 1, width: 10, height: 1 }, () =>
      fired.push("over"),
    );
    expect(d.click(2, 1)).toBe(true);
    expect(fired).toEqual(["over"]);
    expect(d.click(50, 50)).toBe(false);
  });

  test("re-registering the same id moves it to the top", () => {
    // Rows re-register on every render; a stale rect would send clicks to the
    // wrong row.
    const d = new MouseDispatcher();
    const fired: string[] = [];
    d.register({ id: "a", top: 1, left: 1, width: 10, height: 1 }, () =>
      fired.push("a"),
    );
    d.register({ id: "b", top: 1, left: 1, width: 10, height: 1 }, () =>
      fired.push("b"),
    );
    d.register({ id: "a", top: 1, left: 1, width: 10, height: 1 }, () =>
      fired.push("a2"),
    );
    d.click(2, 1);
    expect(fired).toEqual(["a2"]);
  });

  test("unregister removes both the rect and its handler", () => {
    const d = new MouseDispatcher();
    d.register({ id: "a", top: 1, left: 1, width: 10, height: 1 }, () => {});
    d.unregister("a");
    expect(d.hitRects()).toEqual([]);
    expect(d.click(2, 1)).toBe(false);
  });

  test("a throwing listener does not take the input pump down", () => {
    const d = new MouseDispatcher();
    const seen: MouseEvent[] = [];
    d.onMouse(() => {
      throw new Error("boom");
    });
    d.onMouse((e) => seen.push(e));
    d.dispatch({ kind: "down", column: 1, row: 1, button: 0 });
    expect(seen).toHaveLength(1);
  });
});

describe("installMouse", () => {
  function fakeTty() {
    const written: string[] = [];
    const handlers: Array<(chunk: string) => void> = [];
    const calls: string[] = [];
    const stdin = {
      isTTY: true,
      on(_event: string, fn: (chunk: string) => void) {
        handlers.push(fn);
      },
      off() {},
      setRawMode(mode: boolean) {
        calls.push(`rawMode:${mode}`);
      },
      pause() {
        calls.push("pause");
      },
      resume() {
        calls.push("resume");
      },
      unref() {
        calls.push("unref");
      },
    } as unknown as NodeJS.ReadStream;
    const stdout = {
      isTTY: true,
      write: (chunk: string) => written.push(chunk),
    } as unknown as NodeJS.WriteStream;
    return { stdin, stdout, written, handlers, calls };
  }

  test("enables reporting on install and restores the terminal on teardown", () => {
    const { stdin, stdout, written } = fakeTty();
    const installed = installMouse({ stdin, stdout, dispatcher: new MouseDispatcher() });
    expect(written).toContain(MOUSE_ON);
    installed.teardown();
    expect(written).toContain(MOUSE_OFF);
    // Idempotent: a crash path may call it after `exit` already did.
    installed.teardown();
    expect(written.filter((w) => w === MOUSE_OFF)).toHaveLength(1);
  });

  test("teardown RELEASES the real stdin so the process can exit", () => {
    // `^q` used to leave the process alive with no frame on the screen: Ink
    // only ever cleans up the FILTERED stream it was handed, so the TTY we
    // resumed stayed a referenced handle and held the event loop open. Nothing
    // about the frame shows this, which is why the assertion is on the stream.
    const { stdin, stdout, calls } = fakeTty();
    const installed = installMouse({
      stdin,
      stdout,
      dispatcher: new MouseDispatcher(),
    });
    installed.teardown();
    expect(calls).toContain("pause");
    expect(calls).toContain("unref");
    expect(calls).toContain("rawMode:false");
  });

  test("Ink's stdin receives keystrokes but never mouse bytes", async () => {
    const { stdin, stdout, handlers } = fakeTty();
    const dispatcher = new MouseDispatcher();
    const events: MouseEvent[] = [];
    dispatcher.onMouse((e) => events.push(e));
    const installed = installMouse({ stdin, stdout, dispatcher });

    const seen: string[] = [];
    installed.stdin.on("data", (chunk: Buffer | string) =>
      seen.push(chunk.toString()),
    );
    handlers[0]!("a\x1b[<0;9;9Mb");
    await new Promise((r) => setTimeout(r, 5));

    expect(seen.join("")).toBe("ab");
    expect(events.map((e) => e.kind)).toEqual(["down"]);
    installed.teardown();
  });

  test("with no TTY it is a no-op that hands the real stdin back", () => {
    const stdin = { isTTY: false } as unknown as NodeJS.ReadStream;
    const stdout = { isTTY: false, write: () => {} } as unknown as NodeJS.WriteStream;
    const installed = installMouse({ stdin, stdout, dispatcher: new MouseDispatcher() });
    expect(installed.enabled).toBe(false);
    expect(installed.stdin).toBe(stdin);
  });
});

/**
 * Forwarding is gated while a line-mode prompt owns the terminal.
 *
 * A clack prompt reads the REAL stdin. Anything still forwarded to Ink would
 * be typed into a screen the user cannot see, and the mouse reports the
 * terminal keeps sending would arrive at the prompt as garbage.
 */
describe("installMouse forwarding gate", () => {
  function fakeTty() {
    const written: string[] = [];
    const handlers = new Set<(chunk: string) => void>();
    const calls: string[] = [];
    const stdin = {
      isTTY: true,
      on(_event: string, fn: (chunk: string) => void) {
        handlers.add(fn);
      },
      off(_event: string, fn: (chunk: string) => void) {
        handlers.delete(fn);
      },
      setRawMode(mode: boolean) {
        calls.push(`raw:${mode}`);
      },
      resume() {
        calls.push("resume");
      },
    } as unknown as NodeJS.ReadStream;
    const stdout = {
      isTTY: true,
      write: (chunk: string) => written.push(chunk),
    } as unknown as NodeJS.WriteStream;
    const feed = (chunk: string) => {
      for (const fn of [...handlers]) fn(chunk);
    };
    return { stdin, stdout, written, feed, handlers, calls };
  }

  test("stops feeding Ink and turns reporting off, then restores both", async () => {
    const { stdin, stdout, written, feed } = fakeTty();
    const dispatcher = new MouseDispatcher();
    const installed = installMouse({ stdin, stdout, dispatcher });
    const seen: string[] = [];
    installed.stdin.on("data", (chunk: Buffer | string) =>
      seen.push(chunk.toString()),
    );

    feed("a");
    installed.setForwarding(false);
    expect(dispatcher.enabled).toBe(false);
    expect(written.at(-1)).toBe(MOUSE_OFF);
    // Typed at the clack prompt: it must reach the prompt, and NOT the hidden
    // Ink screen underneath it.
    feed("b");

    installed.setForwarding(true);
    expect(dispatcher.enabled).toBe(true);
    expect(written.at(-1)).toBe(MOUSE_ON);
    feed("c");
    await new Promise((r) => setTimeout(r, 5));

    expect(seen.join("")).toBe("ac");
    installed.teardown();
  });

  /**
   * The `$EDITOR` freeze (dogfooded on Kai): open settings → edit identity →
   * leave the editor, and the app repaints perfectly and then ignores every
   * key.
   *
   * Verified in a real pty: `@clack` reads through `readline`, and closing a
   * readline interface PAUSES its input stream — `process.stdin.isPaused()` is
   * true afterwards and stays true. A paused stdin never emits `data` again, so
   * our tap goes quiet forever and Ink is fed nothing. Merely flipping a
   * forwarding flag back on cannot fix that; the stream has to be RESUMED.
   */
  test("taking the terminal back detaches, then re-attaches and resumes stdin", () => {
    const { stdin, stdout, handlers, calls } = fakeTty();
    const installed = installMouse({ stdin, stdout, dispatcher: new MouseDispatcher() });
    expect(handlers.size).toBe(1);

    installed.setForwarding(false);
    // While the prompt owns the terminal we must not be reading the same bytes.
    expect(handlers.size).toBe(0);
    expect(calls).toContain("raw:false");

    installed.setForwarding(true);
    expect(handlers.size).toBe(1);
    expect(calls).toContain("raw:true");
    expect(calls).toContain("resume");
    installed.teardown();
    expect(handlers.size).toBe(0);
  });
});

/**
 * Listener hygiene across the handover.
 *
 * A closed readline interface leaves its handlers on stdin. Without this, every
 * visit to a settings prompt leaks one — and Node eventually prints a
 * max-listeners warning onto the canvas the TUI is drawing on.
 */
describe("captureStdinListeners", () => {
  function fakeStream() {
    const map = new Map<string, Array<(...a: unknown[]) => void>>();
    return {
      listeners: (event: string) => [...(map.get(event) ?? [])],
      listenerCount: (event: string) => (map.get(event) ?? []).length,
      off(event: string, fn: (...a: unknown[]) => void) {
        map.set(event, (map.get(event) ?? []).filter((f) => f !== fn));
        return this;
      },
      add(event: string, fn: (...a: unknown[]) => void) {
        map.set(event, [...(map.get(event) ?? []), fn]);
      },
    };
  }

  test("removes handlers the borrower left behind, and only those", () => {
    const stream = fakeStream();
    const ours = () => {};
    stream.add("data", ours);
    const restore = captureStdinListeners(stream as never);

    const borrowed = () => {};
    stream.add("data", borrowed);
    stream.add("keypress", () => {});
    expect(stream.listenerCount("data")).toBe(2);

    restore();
    expect(stream.listeners("data")).toEqual([ours]);
    expect(stream.listenerCount("keypress")).toBe(0);
  });
});
