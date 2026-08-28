/**
 * Should a bare `phantombot` open the full-screen TUI?
 *
 * This is a SECOND question asked after `isReadOnlyInvocation`, never a change
 * to it. That distinction is load-bearing:
 *
 *   `isReadOnlyInvocation(argv)` answers "may this invocation touch disk?" — and
 *   a bare call answers **true**, on purpose. CI uses bare `phantombot` and
 *   `--help` as "does the binary run?" smoke tests, and every shell <TAB> shells
 *   out through the same entrypoint, so the bare path must stay free of vault
 *   migration, persona provisioning and the tmp sweep.
 *
 *   `shouldOpenTui(argv, tty)` answers a different question: "is a HUMAN sitting
 *   in front of this?" Only when both stdin and stdout are TTYs do we boot the
 *   vault and open the app.
 *
 * The gate is therefore TTY-based, not argv-based. Getting that backwards is
 * not a cosmetic bug: an argv-based gate makes `phantombot | head` hang forever
 * waiting on a cursor-addressed renderer nobody is watching, and makes the CI
 * smoke test write to disk on a runner where nothing is configured.
 *
 * | invocation                              | result                            |
 * |-----------------------------------------|-----------------------------------|
 * | bare, stdin and stdout both TTYs        | open the TUI (chat / wizard)      |
 * | bare, piped / redirected / CI / cron    | today's usage text, read-only     |
 * | bare `--no-tui`                         | line-mode REPL, no full-screen    |
 * | `--help` / `--version` / `help` / any subcommand | unchanged            |
 *
 * `--no-tui` is accepted on the bare invocation only. It is NOT a global flag:
 * every existing subcommand keeps its exact argument surface (the hard non-goal
 * of issue #471), so `phantombot doctor --no-tui` remains an unknown flag to
 * doctor, exactly as it is today.
 */

/** The flag that opts a bare invocation out of the full-screen renderer. */
export const NO_TUI_FLAG = "--no-tui";

export type BareInvocationMode =
  /** Full-screen Ink app: chat with the default phantom, or the wizard. */
  | "tui"
  /** Same pipeline, plain line-mode REPL, no cursor addressing. */
  | "repl"
  /** Today's behaviour: print usage, touch nothing. */
  | "usage";

export interface TtyState {
  stdin: boolean;
  stdout: boolean;
}

/**
 * Classify a bare invocation. `argv` is the full `process.argv`.
 *
 * Anything with a subcommand returns `"usage"` — meaning "not our business,
 * let Citty dispatch" — so a caller only has to special-case `tui` and `repl`.
 */
export function bareInvocationMode(
  argv: string[],
  tty: TtyState,
): BareInvocationMode {
  const args = argv.slice(2);
  if (args.length === 0) {
    // A REPL still needs a keyboard; without one, a bare pipe gets usage text.
    return tty.stdin && tty.stdout ? "tui" : "usage";
  }
  if (args.length === 1 && args[0] === NO_TUI_FLAG) {
    return tty.stdin ? "repl" : "usage";
  }
  return "usage";
}

/** Convenience wrapper: true when the full-screen app should open. */
export function shouldOpenTui(argv: string[], tty: TtyState): boolean {
  return bareInvocationMode(argv, tty) === "tui";
}

/** Read the live TTY state off a process-like object. */
export function currentTty(
  proc: { stdin: { isTTY?: boolean }; stdout: { isTTY?: boolean } } = process,
): TtyState {
  return {
    stdin: proc.stdin.isTTY === true,
    stdout: proc.stdout.isTTY === true,
  };
}
