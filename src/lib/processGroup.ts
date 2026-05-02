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

import type { Subprocess, SpawnOptions } from "bun";
import { log } from "./logger.ts";

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
  return Bun.spawn(cmd, {
    ...opts,
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
