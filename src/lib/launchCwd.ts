/**
 * The directory an interactive TUI turn works in (issue #575).
 *
 * A human who runs `phantombot` from `~/Work/project` means "work here" — the
 * same contract as `pi`, `claude` and `codex`, and what Omarchy's launcher
 * relies on when it starts agents in `~/Work`. Before #575 the chat TUI
 * hard-coded `homedir()`, so that directory was silently ignored.
 *
 * SCOPE: interactive launches only (the full-screen TUI and its `--no-tui`
 * line-mode twin). `phantombot ask` and every channel (Telegram, PhantomChat,
 * scheduled tasks) keep `homedir()` — nobody launches those from a directory,
 * and `ask` is the unattended, judge-screened path.
 *
 * Falls back to the home directory when the launch cwd is gone (deleted out
 * from under the shell, so `process.cwd()` throws) or is not a directory the
 * user can list: a harness spawned in an unreadable cwd fails in ways that look
 * nothing like the cause.
 */

import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";

export function launchWorkingDir(
  cwd: () => string = () => process.cwd(),
  home: () => string = homedir,
): string {
  try {
    const dir = cwd();
    if (statSync(dir).isDirectory()) {
      accessSync(dir, constants.R_OK | constants.X_OK);
      return dir;
    }
  } catch {
    // fall through to home
  }
  return home();
}
