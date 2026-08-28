/**
 * Settings prompts, drawn by `@clack/prompts`.
 *
 * The split is deliberate: **Ink renders the app** (chat, dashboard, the
 * screens you look at), **clack renders the questions** (a value to type, a
 * choice to make). Clack is what every existing
 * `phantombot` subcommand already asks with — `create-persona`, `voice`,
 * `embedding` — so a question looks and behaves identically whether it was
 * reached from the TUI or from a subcommand, and there is one implementation of
 * masked input, cancel semantics and validation instead of two.
 *
 * ## Handing the terminal over and taking it back
 *
 * Clack writes to the terminal directly and reads the real stdin; Ink cannot be
 * paused. Running both at once interleaves two applications on one screen. So a
 * prompt is bracketed by a HOST that suspends the renderer: Ink's writes are
 * gated off, keystrokes stop being forwarded to it, mouse reporting is
 * disabled, and the alternate screen is left so the prompt appears on the
 * user's normal terminal. Afterwards the reverse happens and a full frame is
 * repainted.
 *
 * The host is installed by the entrypoint. Its default is a pass-through, so
 * these functions are directly callable from tests and from any non-TUI caller
 * without a terminal dance.
 *
 * ## Cancel is a first-class answer
 *
 * `clack.isCancel` (^c or esc) resolves as `undefined` here, never as an empty
 * string. A cancelled value must not read as "the user typed nothing" — `""`
 * would be written to the vault and erase a credential they only looked at.
 *
 * Yes/no questions are NOT here: they are `screens/Confirm.tsx`, an Ink screen
 * inside the app with the same header, footer and `esc` as everything else.
 */

import * as clack from "@clack/prompts";

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

/** A value to type. `masked` for credentials. Undefined means cancelled. */
export async function promptValue(input: {
  message: string;
  hint?: string;
  masked?: boolean;
  initial?: string;
}): Promise<string | undefined> {
  return withPromptTerminal(async () => {
    clack.intro(input.message);
    const answer = input.masked
      ? await clack.password({ message: input.hint ?? "value" })
      : await clack.text({
          message: input.hint ?? "value",
          initialValue: input.initial,
        });
    if (clack.isCancel(answer)) {
      clack.cancel("cancelled — nothing was changed");
      return undefined;
    }
    clack.outro("saved");
    return String(answer);
  });
}

/** One choice from a list. Undefined means cancelled. */
export async function promptSelect<T extends string>(input: {
  message: string;
  options: Array<{ value: T; label: string; hint?: string }>;
  initial?: T;
}): Promise<T | undefined> {
  return withPromptTerminal(async () => {
    const answer = await clack.select({
      message: input.message,
      // Clack types an option as a conditional on `Value extends Primitive`,
      // which TypeScript cannot resolve while `T` is still generic. The cast
      // asserts only what the constraint already guarantees: `T` is a string.
      options: input.options as unknown as Array<{
        value: T;
        label: string;
        hint?: string;
      }> & Parameters<typeof clack.select<T>>[0]["options"],
      initialValue: input.initial,
    });
    if (clack.isCancel(answer)) return undefined;
    return answer as T;
  });
}
