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
 * `installMouse().setForwarding(true)` fixes the paused-stream half of that.
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
