/**
 * Mouse support for the TUI.
 *
 * Ink has no mouse support of its own — there is no `useMouse`, and no
 * `ink-mouse` package exists on npm. So this is ours: enable SGR mouse
 * reporting, parse the escape sequences the terminal sends back, and dispatch
 * them on a channel of our own.
 *
 * Two findings from driving a real Ink app inside a pty dictate the shape of
 * this module, and neither is obvious from the code:
 *
 * 1. **The stdin tap must be registered at MODULE SCOPE, before `render()`.**
 *    With the same listener attached from inside a `useEffect`, presses and
 *    wheel events arrive but the **release event is swallowed**, reproducibly —
 *    plain node raw stdin in the same pty received all three, so it is Ink's
 *    input layer and not the terminal. Anything needing press-and-release (a
 *    drag, a click that must not fire until release) breaks silently otherwise.
 *    Hence `installMouse()` is called by the entrypoint BEFORE rendering, not
 *    by a component.
 *
 * 2. **Mouse bytes leak into `useInput` as keystrokes.** Ink's input layer is
 *    not mouse-aware, so a click is handed to every `useInput` handler as the
 *    literal string `[<0;42;7M` — meaning a click anywhere would fire keyboard
 *    shortcuts at random. `stripMouseSequences` is the gate: mouse bytes are
 *    consumed here and only the residual keystrokes are forwarded to Ink.
 *
 * Design rules, the same ones that govern the borders:
 *
 *   - **A component may not know where it is on screen.** Hit-testing is done
 *     by having each interactive row register its own MEASURED rect
 *     (`measureElement`) with the dispatcher. Nothing computes coordinates from
 *     `stdout.columns`.
 *   - **Mouse is an addition, never a requirement.** Every clickable target has
 *     a key on the footer; the TUI is fully usable with mouse reporting off.
 *   - **Exiting restores the terminal.** Mouse mode is disabled on exit and on
 *     every fatal path, so a crash cannot leave the user's terminal emitting
 *     escape codes into their shell prompt.
 */

import { PassThrough } from "node:stream";

/** Enable SGR (1006) mouse reporting with button + drag tracking (1000/1002). */
export const MOUSE_ON = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
/** Disable it again, in the reverse order. Must run on every exit path. */
export const MOUSE_OFF = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";

export type MouseEventKind = "down" | "up" | "move" | "wheel-up" | "wheel-down";

export interface MouseEvent {
  kind: MouseEventKind;
  /** 1-based terminal column, as the terminal reports it. */
  column: number;
  /** 1-based terminal row. */
  row: number;
  /** Raw SGR button code, kept for debugging and future middle/right handling. */
  button: number;
}

/**
 * SGR mouse report: `ESC [ < button ; column ; row (M|m)`.
 * `M` is a press/motion, `m` is a release.
 */
const SGR_MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
const SGR_MOUSE_GLOBAL = new RegExp(SGR_MOUSE.source, "g");

function classify(button: number, final: string): MouseEventKind {
  // Bit 6 (64) marks the wheel; low two bits then pick the direction.
  if (button & 64) return (button & 1) === 0 ? "wheel-up" : "wheel-down";
  // Bit 5 (32) marks motion-with-button-held (drag), reported as `M`.
  if (button & 32) return "move";
  return final === "m" ? "up" : "down";
}

/**
 * Split a raw stdin chunk into decoded mouse events and the keystrokes left
 * over. The residual string is what may safely reach Ink.
 *
 * Written as one pass over the chunk rather than "parse, then replace", so a
 * literal `[<0;1;1M` typed by a human inside a longer paste cannot desync the
 * two views of the same bytes.
 */
export function stripMouseSequences(chunk: string): {
  events: MouseEvent[];
  rest: string;
} {
  if (!chunk.includes("\x1b[<")) return { events: [], rest: chunk };
  const events: MouseEvent[] = [];
  let rest = "";
  let index = 0;
  SGR_MOUSE_GLOBAL.lastIndex = 0;
  for (
    let match = SGR_MOUSE_GLOBAL.exec(chunk);
    match !== null;
    match = SGR_MOUSE_GLOBAL.exec(chunk)
  ) {
    rest += chunk.slice(index, match.index);
    const button = Number(match[1]);
    events.push({
      kind: classify(button, match[4]!),
      column: Number(match[2]),
      row: Number(match[3]),
      button,
    });
    index = match.index + match[0].length;
  }
  rest += chunk.slice(index);
  return { events, rest };
}

/** A rect registered by an interactive row, in terminal coordinates. */
export interface HitRect {
  id: string;
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Which registered rect contains this point? Later registrations win, so a
 * modal drawn over a list takes the click rather than the row underneath it.
 */
export function hitTest(
  rects: readonly HitRect[],
  column: number,
  row: number,
): HitRect | undefined {
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i]!;
    if (
      column >= r.left &&
      column < r.left + r.width &&
      row >= r.top &&
      row < r.top + r.height
    ) {
      return r;
    }
  }
  return undefined;
}

type MouseListener = (event: MouseEvent) => void;

/**
 * The dispatcher. One per process, installed before `render()`.
 *
 * It owns the stdin tap, so it is also the thing that decides what Ink sees:
 * `onKeys` is handed the residual keystrokes and is wired to Ink's own stdin
 * consumer by `installMouse`.
 */
export class MouseDispatcher {
  private listeners = new Set<MouseListener>();
  private rects = new Map<string, HitRect>();
  private handlers = new Map<string, () => void>();
  /** False until `installMouse()` succeeds, so components can degrade. */
  enabled = false;

  /**
   * Register an interactive rect and what to run when it is clicked.
   *
   * Rows register on every render (their position moves as content above them
   * changes), so this is an upsert. Registration ORDER is what makes a modal
   * take a click from the list underneath it — see `hitTest`.
   */
  register(rect: HitRect, onPress?: () => void): void {
    this.rects.delete(rect.id);
    this.rects.set(rect.id, rect);
    if (onPress) this.handlers.set(rect.id, onPress);
  }

  unregister(id: string): void {
    this.rects.delete(id);
    this.handlers.delete(id);
  }

  /**
   * Route a click to the topmost registered rect containing it. Returns true
   * when something handled it, so a caller can fall back to its own behaviour.
   */
  click(column: number, row: number): boolean {
    const hit = hitTest(this.hitRects(), column, row);
    if (!hit) return false;
    const handler = this.handlers.get(hit.id);
    if (!handler) return false;
    try {
      handler();
    } catch {
      // A throwing row handler must not kill the input pump.
    }
    return true;
  }

  /** Registered rects in insertion order — youngest last, as hitTest expects. */
  hitRects(): HitRect[] {
    return [...this.rects.values()];
  }

  onMouse(listener: MouseListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispatch(event: MouseEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A throwing listener must not take the input pump down with it: the
        // user would lose the keyboard too, in a full-screen app with no
        // visible shell to escape to.
      }
    }
  }
}

export const mouse = new MouseDispatcher();

export interface InstallMouseOptions {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  dispatcher?: MouseDispatcher;
}

export interface InstalledMouse {
  /**
   * The stream Ink must read from — `render(<App />, { stdin: mouse.stdin })`.
   *
   * This is NOT the real stdin. It is a filtered view: mouse reports have been
   * removed, so no `useInput` handler can ever see `[<0;42;7M` as a keystroke.
   * Passing the real stdin to Ink instead reintroduces finding (2) at the top
   * of this file — clicking anywhere fires keyboard shortcuts at random.
   */
  stdin: NodeJS.ReadStream;
  /**
   * Hand the real stdin over to a line-mode prompt or a child process, and take
   * it back afterwards.
   *
   * This is a full DETACH, not a flag. `false` removes our `data` listener and
   * drops raw mode; `true` re-attaches, restores raw mode and — the part that
   * matters — calls `resume()` on the real stdin.
   *
   * Resuming is not belt-and-braces. `@clack` reads through `readline`, and
   * closing a readline interface PAUSES its input stream; an editor spawned
   * with an inherited stdin can leave it paused too. A paused stdin never emits
   * `data` again, so the tap goes quiet, nothing reaches Ink, and the app comes
   * back from the prompt DEAF to every keystroke while still drawing perfectly.
   * Verified in a pty: after one clack prompt, `process.stdin.isPaused()` is
   * true and stays true.
   *
   * Detaching (rather than merely not forwarding) also stops us competing with
   * the prompt for the same bytes while it owns the terminal.
   */
  setForwarding: (on: boolean) => void;
  /** Restore the terminal. Idempotent; call it from every exit path. */
  teardown: () => void;
  /** False when there was no TTY to enable reporting on. */
  enabled: boolean;
}

/**
 * Turn mouse reporting on, tap the real stdin, and return a FILTERED stdin for
 * Ink to consume.
 *
 * Must be called BEFORE `render()` — see finding (1) at the top of this file.
 *
 * With no TTY this is a no-op that hands the real stdin straight back, so a
 * caller never has to ask whether the mouse is available.
 */
export function installMouse(options: InstallMouseOptions = {}): InstalledMouse {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const dispatcher = options.dispatcher ?? mouse;
  if (!stdin.isTTY || !stdout.isTTY) {
    return { stdin, setForwarding: () => {}, teardown: () => {}, enabled: false };
  }

  stdout.write(MOUSE_ON);
  dispatcher.enabled = true;

  // A PassThrough carrying only the keystrokes. Ink asks its stdin for TTY
  // affordances (`isTTY`, `setRawMode`, `ref`/`unref`), so those are delegated
  // to the real stream rather than faked — raw mode has to reach the actual
  // terminal or nothing arrives at all.
  const filtered = new PassThrough() as unknown as NodeJS.ReadStream;
  filtered.isTTY = true;
  filtered.setRawMode = ((mode: boolean) => {
    stdin.setRawMode?.(mode);
    return filtered;
  }) as NodeJS.ReadStream["setRawMode"];
  filtered.ref = (() => filtered) as NodeJS.ReadStream["ref"];
  filtered.unref = (() => filtered) as NodeJS.ReadStream["unref"];

  let forwarding = true;
  const onData = (data: Buffer | string) => {
    if (!forwarding) return;
    const chunk = typeof data === "string" ? data : data.toString("utf8");
    const { events, rest } = stripMouseSequences(chunk);
    for (const event of events) dispatcher.dispatch(event);
    // Forward what is left — an empty string would be a spurious wake for
    // every keyboard consumer, so drop a chunk that was pure mouse traffic.
    if (rest.length > 0) (filtered as unknown as PassThrough).write(rest);
  };
  stdin.on("data", onData);

  let torn = false;
  return {
    stdin: filtered,
    enabled: true,
    setForwarding: (on: boolean) => {
      if (on === forwarding) return;
      forwarding = on;
      dispatcher.enabled = on;
      if (on) {
        stdin.setRawMode?.(true);
        stdin.on("data", onData);
        // See the doc comment on `setForwarding`: a readline close or an
        // inherited-stdin child leaves the stream paused, and a paused stdin
        // never emits `data` again.
        stdin.resume?.();
      } else {
        stdin.off("data", onData);
        // The prompt wants a cooked terminal; Ink is not reading anyway.
        stdin.setRawMode?.(false);
      }
      stdout.write(on ? MOUSE_ON : MOUSE_OFF);
    },
    teardown: () => {
      if (torn) return;
      torn = true;
      stdin.off("data", onData);
      dispatcher.enabled = false;
      stdout.write(MOUSE_OFF);
      // RELEASE THE REAL STDIN, or the process never exits.
      //
      // Ink is handed the FILTERED stream, so the cleanup it does on unmount —
      // drop raw mode, pause, unref — lands on the PassThrough, not on the TTY
      // we actually resumed. A resumed TTY stdin is a referenced handle: the
      // event loop stays alive with nothing drawing on the screen, which is
      // exactly the `^q` symptom (frame gone, shell not back, only SIGINT
      // ends it). Removing our `data` listener is not enough; the stream has
      // to be paused and unreferenced.
      stdin.setRawMode?.(false);
      stdin.pause?.();
      stdin.unref?.();
    },
  };
}
