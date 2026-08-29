/**
 * The stdin tap: a filtered view of the real stdin that Ink reads from, so the
 * entrypoint can silence the TUI's input without knowing Ink's internals.
 *
 * ## Why a tap at all
 *
 * Ink cannot be paused. When a line-mode prompt (`@clack`) borrows the
 * terminal, the renderer's writes are gated off, but Ink is still listening —
 * and would race the prompt for the same bytes. With the tap, `setForwarding`
 * is the single switch that detaches the TUI from the keyboard and re-attaches
 * it afterwards.
 *
 * The tap delegates TTY affordances (`isTTY`, `setRawMode`, `ref`/`unref`) to
 * the real stream rather than faking them — raw mode has to reach the actual
 * terminal or nothing arrives at all.
 */

import { PassThrough } from "node:stream";

export interface StdinTap {
  /** The stream Ink must read from — `render(<App />, { stdin: tap.stdin })`. */
  stdin: NodeJS.ReadStream;
  /**
   * Hand the real stdin over to a line-mode prompt or a child process, and take
   * it back afterwards.
   *
   * This is a full DETACH, not a flag. `false` removes the tap's `data`
   * listener and drops raw mode; `true` re-attaches, restores raw mode and —
   * the part that matters — calls `resume()` on the real stdin.
   *
   * Resuming is not belt-and-braces. `@clack` reads through `readline`, and
   * closing a readline interface PAUSES its input stream; a child spawned
   * with an inherited stdin can leave it paused too. A paused stdin never
   * emits `data` again, so the tap goes quiet, nothing reaches Ink, and the
   * app comes back from the prompt DEAF to every keystroke while still drawing
   * perfectly. Verified in a pty: after one clack prompt,
   * `process.stdin.isPaused()` is true and stays true.
   */
  setForwarding: (on: boolean) => void;
  /** Release the real stdin. Idempotent; call it from every exit path. */
  teardown: () => void;
}

/**
 * Tap the real stdin and return the filtered stream for Ink to consume.
 *
 * With no TTY this is a no-op that hands the real stdin straight back, so a
 * caller never has to ask whether there is a terminal at all.
 */
export function installStdinTap(
  stdin: NodeJS.ReadStream = process.stdin,
): StdinTap {
  if (!stdin.isTTY) {
    return { stdin, setForwarding: () => {}, teardown: () => {} };
  }

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
    if (chunk.length > 0) (filtered as unknown as PassThrough).write(chunk);
  };
  stdin.on("data", onData);

  let torn = false;
  return {
    stdin: filtered,
    setForwarding: (on: boolean) => {
      if (on === forwarding) return;
      forwarding = on;
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
    },
    teardown: () => {
      if (torn) return;
      torn = true;
      stdin.off("data", onData);
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
