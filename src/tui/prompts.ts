/**
 * The bracket that lends the terminal to something that is not Ink.
 *
 * The TUI no longer ASKS anything here: yes/no is `screens/Confirm.tsx`, a
 * typed value is `screens/Ask.tsx` and a list is `screens/Choose.tsx`, all
 * inside the app with its header, footer and `esc`. What remains is the
 * hand-over itself, which is still needed for the two things that genuinely
 * are other programs: `$EDITOR`, and the `@clack` subcommand flows behind
 * Brain and Channels until those are ported too.
 *
 * ## Handing the terminal over and taking it back
 *
 * Clack writes to the terminal directly and reads the real stdin; Ink cannot be
 * paused. Running both at once interleaves two applications on one screen. So a
 * prompt is bracketed by a HOST that suspends the renderer: Ink's writes are
 * gated off, keystrokes stop being forwarded to it, and the alternate screen
 * is left so the prompt appears on the user's normal terminal. Afterwards the reverse happens and a full frame is
 * repainted.
 *
 * The host is installed by the entrypoint. Its default is a pass-through, so
 * these functions are directly callable from tests and from any non-TUI caller
 * without a terminal dance.
 *
 * ## Cancel is a first-class answer
 *
 * The screens that replaced these prompts keep the rule they established: a
 * cancelled question resolves `undefined`, never an empty string. `""` would
 * be written to the vault and erase a credential the user only looked at.
 */

export type PromptHost = <T>(fn: () => Promise<T>) => Promise<T>;

let host: PromptHost = (fn) => fn();

/** Install the suspend/resume bracket. Returns a restore function. */
export function setPromptHost(next: PromptHost): () => void {
  const previous = host;
  host = next;
  return () => {
    host = previous;
  };
}

/** Run `fn` with the renderer suspended. Exposed for composite flows. */
export function withPromptTerminal<T>(fn: () => Promise<T>): Promise<T> {
  return host(fn);
}
