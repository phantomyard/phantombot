/**
 * Process-group spawn + kill helpers.
 *
 * Why this exists: a phantombot harness (claude/gemini/pi) commonly
 * spawns its own subprocesses to execute tool calls — `Bash`, `WebFetch`,
 * `gemini usage`, etc. When phantombot kills the harness on timeout or
 * /stop, `Bun.spawn`'s `proc.kill(SIGTERM)` only signals the direct
 * subprocess. The grandchildren are reparented to PID 1 and keep
 * running.
 *
 * The motivating bug (kw-openclaw, 2026-05-02): a `gemini usage` tool
 * call wedged on a TCP read inside the gemini subprocess. After the
 * 600s wall-clock timeout fired, gemini died — but `gemini usage`
 * survived as an orphan with the open socket, eating fds and
 * confusing later runs.
 *
 * Fix: spawn the binary with Bun's `detached: true` option. This puts
 * the spawned process in its own session and process group BEFORE
 * exec, so `pid == pgid == sid` from the moment Bun.spawn returns.
 * We can then signal the entire descendant tree in one syscall via
 * `process.kill(-pid, sig)` — the kernel routes a negative pid to
 * every member of the matching pgid.
 *
 * Why this option vs a `setsid <cmd>` wrapper: a setsid prefix would
 * also work, but it has a brief race — the setsid() syscall doesn't
 * happen until after Bun.spawn returns and the child actually exec's
 * setsid. If you try to kill the group within ~50ms of spawn (rare
 * in production but real in tests), the new pgroup doesn't exist
 * yet and you get ESRCH. Bun's `detached` does the setsid before
 * exec, so the pgroup is live by the time `proc.pid` is observable
 * in the caller.
 *
 * `detached` is undocumented in Bun's public API as of 1.3.x but
 * works reliably (it maps to posix_spawn's POSIX_SPAWN_SETSID flag).
 * If a future Bun release changes this, the fallback is to wrap the
 * cmd in `setsid` and accept the spawn-time race.
 */

import { dirname } from "node:path";
import type { Subprocess, SpawnOptions } from "bun";
import { log } from "./logger.ts";

/**
 * Ensure an absolute executable's OWN directory is on the child's PATH.
 *
 * Why this exists (the systemd-vs-Zed harness bug, 2026-07-01): the harness
 * CLIs (`pi`, and any nvm/fnm/volta-installed `claude`/`gemini`/`codex`) are
 * Node scripts whose shebang is `#!/usr/bin/env node`. The kernel honors the
 * shebang by re-invoking `env node`, which needs `node` ON PATH. An
 * nvm-installed `pi` lives at `~/.nvm/versions/node/<v>/bin/pi` with `node`
 * RIGHT NEXT TO IT in the same directory — but that directory is only on PATH
 * inside an interactive/desktop session.
 *
 * phantombot's `harnessSearchPath()` is smart enough to FIND `pi` on the
 * filesystem and spawn it by absolute path, so the spawn itself succeeds. But
 * the child inherits phantombot's PATH, and under systemd that PATH is narrow
 * (no nvm dir) — so the shebang's `env node` fails and the process dies with
 * exit 127. Under Zed / VS Code the extension host inherits the desktop
 * session's PATH (nvm already on it), so `node` is found and it Just Works —
 * which is exactly why the same bot answers from the editor but not Telegram.
 *
 * The fix is transport-agnostic: prepend the executable's own directory to the
 * child PATH so `env node` resolves the interpreter sitting beside the binary,
 * no matter how narrow the parent PATH is. This makes systemd behave like the
 * editor without tampering with the user's shell/systemd config.
 *
 * Only acts when `bin` is ABSOLUTE — a bare command name (`"pi"`) is being
 * resolved via the existing PATH, and `dirname("pi")` is `"."`, which we must
 * never inject. Returns a FRESH object (never mutates the caller's env, which
 * may be the shared `process.env` reference) and is a no-op when the directory
 * is already present.
 *
 * Exported for testing.
 */
export function withCommandDirOnPath(
  bin: string,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  if (!bin.startsWith("/")) return env;
  const binDir = dirname(bin);
  const currentPath = env.PATH ?? "";
  const entries = currentPath.split(":");
  if (entries.includes(binDir)) return env;
  return {
    ...env,
    PATH: currentPath ? `${binDir}:${currentPath}` : binDir,
  };
}

/**
 * Spawn a subprocess as the leader of a fresh process group/session.
 *
 * Identical to `Bun.spawn` except the resulting process's `pid` doubles
 * as a `pgid` you can pass to `killProcessGroup` to bring the whole
 * descendant tree down with one signal.
 */
export function spawnInNewSession<
  Stdin extends SpawnOptions.Writable,
  Stdout extends SpawnOptions.Readable,
  Stderr extends SpawnOptions.Readable,
>(
  cmd: string[],
  opts: SpawnOptions.OptionsObject<Stdin, Stdout, Stderr>,
): Subprocess<Stdin, Stdout, Stderr> {
  if (cmd.length === 0) {
    throw new Error("spawnInNewSession: cmd cannot be empty");
  }
  // Make the child's PATH self-sufficient for a `#!/usr/bin/env node` shebang:
  // prepend the binary's own directory (where the matching `node` lives for an
  // nvm/fnm/volta install) so the interpreter resolves under a narrow systemd
  // PATH exactly as it does under a desktop/editor session. See
  // withCommandDirOnPath for the full rationale (exit-127 bug, 2026-07-01).
  const env = opts.env
    ? withCommandDirOnPath(cmd[0]!, opts.env as Record<string, string | undefined>)
    : opts.env;
  return Bun.spawn(cmd, {
    ...opts,
    env,
    // Undocumented but stable Bun option (maps to POSIX_SPAWN_SETSID).
    // See module docstring for why this beats a `setsid` wrapper.
    detached: true,
  } as typeof opts) as Subprocess<Stdin, Stdout, Stderr>;
}

/**
 * Kill the entire process group of `proc` with SIGTERM, then escalate
 * to SIGKILL after `graceMs` if the process hasn't exited.
 *
 * Resolves when the process is reaped (proc.exited resolves), regardless
 * of which signal finally killed it. Safe to call multiple times — the
 * second call is a no-op once the process is gone.
 *
 * Errors during signalling (other than ESRCH = "process is already
 * gone") are logged and swallowed. The caller is past the point of
 * recovery once kill is needed.
 */
export async function killProcessGroup(
  proc: Subprocess<
    SpawnOptions.Writable,
    SpawnOptions.Readable,
    SpawnOptions.Readable
  >,
  graceMs: number = 5000,
): Promise<void> {
  const pid = proc.pid;
  if (typeof pid !== "number" || pid <= 0) return;

  if (!signalGroup(pid, "SIGTERM")) {
    // ESRCH path — already dead. proc.exited has already resolved or is
    // about to. Just await it.
    await proc.exited;
    return;
  }

  // Race the natural exit against the grace window.
  const escalated = await Promise.race([
    proc.exited.then(() => false),
    new Promise<true>((resolve) => setTimeout(() => resolve(true), graceMs)),
  ]);

  if (!escalated) return;

  log.warn("processGroup: SIGTERM ignored within grace, escalating to SIGKILL", {
    pid,
    graceMs,
  });
  signalGroup(pid, "SIGKILL");
  // SIGKILL can't be ignored; proc.exited resolves shortly.
  await proc.exited;
}

/**
 * Send `signal` to every process in the group whose pgid is `pid`.
 * Returns true if the signal was delivered (or the kernel accepted it),
 * false if the group is already gone (ESRCH).
 *
 * Wraps `process.kill` with negative pid — the POSIX convention for
 * "this entire process group". Anything other than ESRCH is logged
 * and treated as a delivered signal (best-effort; the caller still
 * waits on proc.exited).
 */
function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    log.warn("processGroup: kill failed", {
      pid,
      signal,
      code,
      error: (e as Error).message,
    });
    return true;
  }
}
