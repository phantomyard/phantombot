/**
 * Lending the real stdin to something that is not Ink, and getting it back
 * intact.
 *
 * Two different consumers borrow the terminal while the TUI is suspended: a
 * `@clack` prompt (which reads stdin through `readline`) and `$EDITOR` (a child
 * process with an inherited stdin). Both leave the stream in a state the TUI
 * cannot live with, and both failures look identical to the user — the app
 * repaints correctly and then ignores every key.
 *
 * `installStdinTap().setForwarding(true)` fixes the paused-stream half of that.
 * This module fixes the other half: LISTENERS THAT DO NOT LEAVE. A closed
 * readline interface leaves a `data` (and `keypress`) handler attached to
 * stdin; open the settings screen a dozen times and you accumulate a dozen of
 * them, complete with Node's max-listeners warning printed onto the canvas.
 *
 * The rule is deliberately narrow: restore the listener set to exactly what it
 * was before the prompt ran. We never remove a listener we did not see appear,
 * so nothing the app itself installed can be swept up by this.
 */

type Emitterish = Pick<
  NodeJS.EventEmitter,
  "listeners" | "off" | "listenerCount"
>;

/** Events a borrowed stdin is known to leave handlers on. */
const WATCHED = ["data", "keypress", "readable"] as const;

/**
 * Snapshot stdin's listeners. The returned function removes any that appeared
 * in the meantime and were not there when the snapshot was taken.
 */
export function captureStdinListeners(
  stream: Emitterish = process.stdin,
): () => void {
  const before = new Map<string, Set<unknown>>();
  for (const event of WATCHED) {
    before.set(event, new Set(stream.listeners(event)));
  }
  return () => {
    for (const event of WATCHED) {
      const known = before.get(event)!;
      for (const listener of stream.listeners(event)) {
        if (!known.has(listener)) {
          stream.off(event, listener as (...args: unknown[]) => void);
        }
      }
    }
  };
}

/** The subset of stdin a borrow needs: listeners, plus the flow control. */
type Borrowable = Emitterish & {
  resume?: () => unknown;
  isPaused?: () => boolean;
};

/**
 * Lend stdin to a prompt or a child process, and take it back intact.
 *
 * Two things have to happen on the way OUT, not only on the way back:
 *
 *  1. Snapshot the listeners, so whatever the borrower leaves behind can be
 *     removed (see `captureStdinListeners`).
 *  2. RESUME the stream. Detaching the TUI's tap removes the last `data`
 *     listener, which drops Node out of flowing mode. A borrower that attaches
 *     `keypress` instead of `data` — every `readline`-based prompt, which is
 *     all of `@clack` — never resumes it, so the prompt renders and then
 *     receives nothing: not the answer, and not the ^c that would cancel it.
 *     That is a hard wedge with no key out of it, on a screen that looks alive.
 *
 * Returns the take-it-back function.
 */
export function lendStdin(
  stream: Borrowable = process.stdin,
  options: { pollMs?: number } = {},
): () => void {
  const restoreListeners = captureStdinListeners(stream);
  stream.resume?.();
  // A borrow is not always ONE prompt. `phantombot harness` asks a whole
  // sequence, and each `readline` interface PAUSES the stream when it closes —
  // so prompt two onwards renders against a dead stdin even though the borrow
  // resumed it on the way in. Nothing tells us a prompt ended, so the flow is
  // re-asserted on a timer for as long as the borrow lasts. Resuming an already
  // flowing stream is a no-op, and the timer is unref'd so it can never hold
  // the process open.
  const pollMs = options.pollMs ?? 50;
  const keepFlowing = setInterval(() => {
    if (stream.isPaused?.() === false) return;
    stream.resume?.();
  }, pollMs);
  (keepFlowing as { unref?: () => void }).unref?.();
  return () => {
    clearInterval(keepFlowing as unknown as ReturnType<typeof setInterval>);
    restoreListeners();
  };
}
