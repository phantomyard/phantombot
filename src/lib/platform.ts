/**
 * Cross-platform service-manager router.
 *
 * Phantombot ships on Linux (systemd --user), macOS (launchd, per-user
 * LaunchAgents) and Windows (per-user Task Scheduler logon/periodic tasks).
 * The backends have different unit-file shapes, different control
 * verbs, and different log destinations — this module is the single place
 * where CLI code decides which one to talk to.
 *
 * Public surface:
 *
 *   defaultServiceControl()       — ServiceControl wired to the host's
 *                                    backend (used by every TUI that wants
 *                                    to restart phantombot after a config
 *                                    change).
 *   restartCommand()              — copy-pasteable command string for hint
 *                                    output ("restart with: …").
 *   statusCommand()               — same, for `status:` lines.
 *   logsCommand()                 — same, for `view logs:` lines.
 *   currentPlatform()             — narrowed enum so callers can branch
 *                                    without touching process.platform
 *                                    directly.
 *
 * The `ServiceControl` interface itself lives in systemd.ts (where it
 * was originally defined); we re-export it here so platform-aware code
 * has a single import path.
 */

import {
  defaultLaunchdServiceControl,
  launchdLogPaths,
} from "./launchd.ts";
import {
  defaultSystemdServiceControl,
  type ServiceControl,
} from "./systemd.ts";
import {
  defaultTaskSchedulerServiceControl,
  scheduleWindowsRelaunch,
  taskLogPaths,
} from "./taskScheduler.ts";

export type { ServiceControl };

export type Platform = "linux" | "darwin" | "windows" | "unsupported";

export function currentPlatform(): Platform {
  if (process.platform === "linux") return "linux";
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "win32") return "windows";
  return "unsupported";
}

/**
 * ServiceControl wired to the appropriate backend for the host.
 *
 * On unsupported platforms (anything other than linux/darwin) we return
 * a no-op control that says the service is never active and refuses to
 * restart — phantombot doesn't ship binaries for those platforms anyway,
 * so the only way to hit this branch is `bun src/index.ts` on Windows
 * or BSD, where the user is on their own.
 */
export function defaultServiceControl(): ServiceControl {
  switch (currentPlatform()) {
    case "linux":
      return defaultSystemdServiceControl();
    case "darwin":
      return defaultLaunchdServiceControl();
    case "windows":
      return defaultTaskSchedulerServiceControl();
    default:
      return noopServiceControl();
  }
}

export interface SelfRestartOpts {
  /** The host's ServiceControl (POSIX path delegates to its restart()). */
  serviceControl: ServiceControl;
  /** Defaults to process.platform. Tests override. */
  procPlatform?: string;
  /**
   * Test seam for the Windows graceful-exit trigger. Production emits
   * SIGTERM so `phantombot run`'s existing shutdown handler drains cleanly.
   */
  triggerShutdown?: () => void;
  /**
   * Test seam for the Windows deferred-relaunch scheduler. Production uses
   * `scheduleWindowsRelaunch`, which detaches a watcher that waits for this
   * process to exit and then starts the swapped binary.
   */
  scheduleRelaunch?: (opts: {
    selfPid: number;
  }) => Promise<{ ok: boolean; stderr?: string }>;
}

/**
 * Restart THE CURRENT phantombot process so it comes back running the
 * freshly-swapped binary. This is the IN-PROCESS restart used by the
 * `/update` and `/restart` slash-commands, where the caller is the running
 * service itself — distinct from `defaultServiceControl().restart()`, which
 * an EXTERNAL `phantombot update --restart` uses to bounce the service from a
 * separate terminal.
 *
 * POSIX (linux/darwin): delegate to the supervisor's restart verb
 * (`systemctl --user restart` / `launchctl kickstart`). Those SIGTERM us and
 * the supervisor relaunches — safe to call from within the unit.
 *
 * Windows: schedule a detached deferred relaunch of the swapped binary FIRST,
 * then exit cleanly (emit SIGTERM → the run loop's handler drains and returns).
 * The watcher waits for us to release the run-lock, then starts the new binary
 * — mirroring the Linux systemd-run deferred restart. We no longer rely on the
 * always-on task's keep-alive trigger as the primary relaunch path: its
 * IgnoreNew run-accounting can wedge and never relaunch (the Megan v1.1.212
 * self-update that sat dead for hours). Keep-alive remains a backstop if the
 * watcher fails to spawn.
 */
export async function selfRestart(
  opts: SelfRestartOpts,
): Promise<{ ok: boolean; stderr?: string }> {
  const platform = opts.procPlatform ?? process.platform;
  if (platform === "win32") {
    // Schedule the relaunch BEFORE tripping shutdown: the watcher captures our
    // pid, blocks on our exit, then launches the swapped binary. A spawn
    // failure here is non-fatal — we still exit and fall back to the keep-alive
    // trigger — but we surface it so the caller can log it.
    const scheduleRelaunch = opts.scheduleRelaunch ?? scheduleWindowsRelaunch;
    const relaunch = await scheduleRelaunch({ selfPid: process.pid });
    const trigger =
      opts.triggerShutdown ??
      (() => {
        // Emit through the normal shutdown path so memory (SQLite/WAL) and the
        // run-lock are released cleanly, exactly like a POSIX SIGTERM restart.
        process.emit("SIGTERM" as NodeJS.Signals);
      });
    trigger();
    return relaunch.ok
      ? { ok: true }
      : {
          ok: false,
          stderr:
            `deferred relaunch scheduling failed (${relaunch.stderr ?? "unknown"}); ` +
            `falling back to the keep-alive trigger`,
        };
  }
  return opts.serviceControl.restart();
}

function noopServiceControl(): ServiceControl {
  const unsupported = () => ({
    ok: false,
    stderr: `phantombot has no service-manager backend on ${process.platform}`,
  });
  return {
    async isActive() {
      return false;
    },
    async start() {
      return unsupported();
    },
    async stop() {
      return unsupported();
    },
    async restart() {
      return unsupported();
    },
    async rerenderUnitIfStale() {
      return { rerendered: false };
    },
  };
}

/** Copy-pasteable command string the user can run to restart phantombot. */
export function restartCommand(): string {
  switch (currentPlatform()) {
    case "darwin":
      return `launchctl kickstart -k gui/$(id -u)/dev.phantombot.phantombot`;
    case "windows":
      return `schtasks /End /TN "\\Phantombot\\phantombot" & schtasks /Run /TN "\\Phantombot\\phantombot"`;
    case "linux":
    default:
      return "systemctl --user restart phantombot";
  }
}

/** Copy-pasteable command string the user can run to start phantombot. */
export function startCommand(): string {
  switch (currentPlatform()) {
    case "darwin":
      return `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.phantombot.phantombot.plist`;
    case "windows":
      return `schtasks /Change /TN "\\Phantombot\\phantombot" /ENABLE & schtasks /Run /TN "\\Phantombot\\phantombot"`;
    case "linux":
    default:
      return "systemctl --user start phantombot";
  }
}

/** Copy-pasteable command string the user can run to stop phantombot. */
export function stopCommand(): string {
  switch (currentPlatform()) {
    case "darwin":
      return `launchctl bootout gui/$(id -u)/dev.phantombot.phantombot`;
    case "windows":
      return `schtasks /Change /TN "\\Phantombot\\phantombot" /DISABLE & schtasks /End /TN "\\Phantombot\\phantombot"`;
    case "linux":
    default:
      return "systemctl --user stop phantombot";
  }
}

/** Copy-pasteable command string for "show me the service status". */
export function statusCommand(): string {
  switch (currentPlatform()) {
    case "darwin":
      return `launchctl print gui/$(id -u)/dev.phantombot.phantombot`;
    case "windows":
      return `schtasks /Query /TN "\\Phantombot\\phantombot" /V /FO LIST`;
    case "linux":
    default:
      return "systemctl --user status phantombot";
  }
}

/** Copy-pasteable command string for "tail the logs". */
export function logsCommand(): string {
  switch (currentPlatform()) {
    case "darwin":
      return `tail -f ~/Library/Logs/phantombot/dev.phantombot.phantombot.{out,err}.log`;
    case "windows": {
      // Derive the log path from the same resolver the scheduler writes to
      // (taskLogPaths -> xdgDataHome), so an XDG_DATA_HOME override points the
      // hint at the real file instead of the default .local\share location.
      const { out } = taskLogPaths("phantombot");
      return `powershell -Command "Get-Content -Wait -Tail 50 \\"${out}\\""`;
    }
    case "linux":
    default:
      return "journalctl --user -u phantombot -f";
  }
}

/** Options for {@link logsSpec}. */
export interface LogsSpecOpts {
  /** Stream new lines as they arrive (tail -f / -Wait). Default true. */
  follow?: boolean;
  /** How many trailing lines to show before following. Default 50. */
  lines?: number;
}

/**
 * Argv for a child process that tails phantombot's service logs, resolved for
 * the host platform. `phantombot logs` spawns this with inherited stdio.
 *
 *   - linux:   journalctl --user -u phantombot [-n N] [-f]  (one merged stream)
 *   - darwin:  tail [-n N] [-f] <out.log> <err.log>         (two files)
 *   - windows: powershell Get-Content -Tail N [-Wait] <out.log>
 *
 * Returns null on unsupported platforms so the caller can print a hint
 * instead of spawning garbage.
 */
export function logsSpec(
  opts: LogsSpecOpts = {},
): { cmd: string; args: string[] } | null {
  const follow = opts.follow ?? true;
  const lines = opts.lines ?? 50;
  switch (currentPlatform()) {
    case "linux": {
      const args = ["--user", "-u", "phantombot", "-n", String(lines)];
      if (follow) args.push("-f");
      return { cmd: "journalctl", args };
    }
    case "darwin": {
      const { out, err } = launchdLogPaths();
      const args: string[] = [];
      if (follow) args.push("-f");
      args.push("-n", String(lines), out, err);
      return { cmd: "tail", args };
    }
    case "windows": {
      // Get-Content -Wait follows a single file; we tail stdout (the err log
      // is surfaced by the copy-pasteable logsCommand() hint if needed).
      // Guard on Test-Path first: Get-Content throws a red "Cannot find path"
      // error if the log doesn't exist yet (e.g. the daemon has never written),
      // which reads as a crash. Print a friendly line and exit 0 instead.
      // -LiteralPath so spaces/brackets in the path aren't treated as globs.
      const { out } = taskLogPaths("phantombot");
      const wait = follow ? "-Wait " : "";
      const ps =
        `$p='${out.replace(/'/g, "''")}'; ` +
        `if (-not (Test-Path -LiteralPath $p)) { ` +
        `Write-Host "no phantombot logs yet at $p"; return }; ` +
        `Get-Content -LiteralPath $p ${wait}-Tail ${lines}`;
      return {
        cmd: "powershell",
        args: ["-NoProfile", "-NonInteractive", "-Command", ps],
      };
    }
    default:
      return null;
  }
}
