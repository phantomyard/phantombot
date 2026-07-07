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

import { execFileSync } from "node:child_process";
import { basename, delimiter, dirname, isAbsolute } from "node:path";
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
  // Only act on an ABSOLUTE path — a bare command name is resolved via the
  // existing PATH and `dirname("pi")` is "." which we must never inject.
  // `isAbsolute` + the platform `delimiter` (":" on POSIX, ";" on Windows)
  // keep this correct on both without changing POSIX behaviour.
  if (!isAbsolute(bin)) return env;
  const binDir = dirname(bin);
  const currentPath = env.PATH ?? "";
  const entries = currentPath.split(delimiter);
  if (entries.includes(binDir)) return env;
  return {
    ...env,
    PATH: currentPath ? `${binDir}${delimiter}${currentPath}` : binDir,
  };
}

/**
 * Ensure phantombot's OWN executable directory is on the child's PATH.
 *
 * Why this exists (the Windows "phantombot: command not found" bug,
 * 2026-07-07): a harness turn spawns tool subprocesses — notably the agent's
 * Bash tool — that call back into the `phantombot` CLI (`phantombot memory
 * search`, `phantombot task add`, `phantombot notify`, ...). Those shells
 * inherit the harness's env/PATH. On Windows the daemon is launched by a
 * Scheduled Task whose environment carries only the *machine* PATH, while the
 * phantombot install dir is registered on the *user* PATH — so the CLI is
 * invisible to the spawned shell and every self-call dies with exit 127 /
 * "phantombot: command not found". (The same class bites any launch context
 * with a narrower PATH than the interactive session the install dir lives in.)
 *
 * The install dir is not on any reliably-inherited PATH, but it IS
 * `dirname(process.execPath)` whenever phantombot runs as its compiled
 * single-file binary. Prepend that dir to the child PATH so the agent's shell
 * can always find the CLI, no matter how the daemon was launched. Same spirit
 * as withCommandDirOnPath (#240), but for phantombot's own binary rather than
 * the harness's.
 *
 * Guarded: only acts when the running executable is the phantombot binary
 * itself (not `bun`/`node` running a source checkout), so a dev run never gets
 * the runtime's dir injected. No-op when the dir is already present. Returns a
 * FRESH object; never mutates the caller's env (may be shared `process.env`).
 *
 * Exported for testing.
 */
export function withPhantombotBinDirOnPath(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const exe = process.execPath;
  if (!exe || !isAbsolute(exe)) return env;
  // Only when running AS the compiled phantombot binary — under `bun run`/
  // `node` from source, execPath is the runtime and its dir must NOT be
  // injected (would shadow nothing useful and add noise). The compiled binary
  // is named `phantombot` / `phantombot.exe`.
  const base = basename(exe).toLowerCase();
  if (!base.startsWith("phantombot")) return env;
  const binDir = dirname(exe);
  const currentPath = env.PATH ?? "";
  const entries = currentPath.split(delimiter);
  if (entries.includes(binDir)) return env;
  return {
    ...env,
    PATH: currentPath ? `${binDir}${delimiter}${currentPath}` : binDir,
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
  // Two PATH augmentations, both copy-on-write:
  //  1. withCommandDirOnPath — the HARNESS binary's own dir, so a
  //     `#!/usr/bin/env node` shebang finds its interpreter (exit-127, #240).
  //  2. withPhantombotBinDirOnPath — PHANTOMBOT's own install dir, so the
  //     agent's Bash tool can call back into the `phantombot` CLI even when the
  //     daemon was launched with a narrow PATH (Windows Scheduled Task /
  //     machine-PATH-only, "phantombot: command not found", 2026-07-07).
  const env = opts.env
    ? withPhantombotBinDirOnPath(
        withCommandDirOnPath(
          cmd[0]!,
          opts.env as Record<string, string | undefined>,
        ),
      )
    : opts.env;
  return Bun.spawn(cmd, {
    ...opts,
    env,
    // POSIX only: `detached` (undocumented but stable Bun option, maps to
    // POSIX_SPAWN_SETSID) puts the child in its own session so pid==pgid and a
    // single negative-pid signal reaches the whole descendant group. See the
    // module docstring for why this beats a `setsid` wrapper.
    //
    // Windows has no POSIX process groups — we bring the tree down with
    // `taskkill /T` by PID instead — and detaching there can prevent Bun from
    // observing the child's exit, leaving `proc.exited` permanently unresolved
    // (killProcessGroup would then hang). So we only detach on POSIX.
    detached: process.platform !== "win32",
    // Windows only (issue #271): suppress the console window Windows opens for
    // every child of a GUI/service process. Without it, each harness turn (and
    // each tool subprocess it spawns) flashes a cmd/console window on the
    // desktop. No-op on POSIX. Covers all four harnesses (claude/gemini/codex/pi)
    // in one place since they all spawn through here.
    windowsHide: true,
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
 * On POSIX this wraps `process.kill` with a negative pid — the convention for
 * "this entire process group". Windows has no process groups or signals in the
 * POSIX sense, so there we shell out to `taskkill /T` (walk and terminate the
 * child tree by PID). Anything other than "already gone" is logged and treated
 * as a delivered signal (best-effort; the caller still waits on proc.exited).
 */
function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  if (process.platform === "win32") return windowsKillTree(pid);
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

/**
 * Windows equivalent of a process-group kill: `taskkill /PID <pid> /T /F` walks
 * the descendant tree and force-terminates it.
 *
 * Why always force (`/F`), ignoring the SIGTERM/SIGKILL distinction: a Windows
 * console process tree (cmd + its children) does not honour the graceful
 * WM_CLOSE that `taskkill` without `/F` sends, and — critically — `taskkill /T`
 * WITHOUT `/F` returns exit 128 against a still-alive console tree, which is
 * indistinguishable from "no such process". Treating that as "already gone"
 * made killProcessGroup skip escalation and await a never-resolving exit. With
 * `/F`, exit 128 reliably means the PID genuinely doesn't exist, so we can map
 * it to the POSIX ESRCH branch. The grace window still applies: the caller
 * races proc.exited against it, and a forced kill resolves proc.exited well
 * inside a normal grace, so the escalation path simply never needs to fire.
 *
 * Returns false when the process is already gone (exit 128, mirroring the POSIX
 * ESRCH branch) or when `taskkill` itself is missing (ENOENT) — in both cases no
 * signal was delivered, so the caller must not treat the tree as reaped.
 */
function windowsKillTree(pid: number): boolean {
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      // Suppress the taskkill console window that would otherwise flash on every
      // process-group teardown (issue #271).
      windowsHide: true,
    });
    return true;
  } catch (e) {
    // taskkill exits 128 ("process not found") when the tree is already gone.
    const status = (e as { status?: number }).status;
    if (status === 128) return false;
    // taskkill missing from PATH: nothing was killed, so report failure rather
    // than a misleading "signal delivered".
    const code = (e as { code?: string }).code;
    if (code === "ENOENT") {
      log.warn("processGroup: taskkill not found on PATH", { pid });
      return false;
    }
    log.warn("processGroup: taskkill failed", {
      pid,
      status,
      error: (e as Error).message,
    });
    return true;
  }
}
