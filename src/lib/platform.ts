/**
 * Cross-platform service-manager router.
 *
 * Phantombot ships on Linux (systemd --user), macOS (launchd, per-user
 * LaunchAgents) and Windows (Task Scheduler, per-user logon-triggered
 * tasks). The backends have different unit-file shapes, different control
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

import { defaultLaunchdServiceControl } from "./launchd.ts";
import {
  defaultSystemdServiceControl,
  type ServiceControl,
} from "./systemd.ts";
import { defaultTaskSchedulerServiceControl } from "./taskScheduler.ts";

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
 * Windows: we must NOT call `schtasks /End` + `/Run` from inside the task's
 * own process tree — `/End` tears down that tree (including the child
 * `schtasks.exe` we just spawned to issue `/Run`), so the relaunch can be
 * dropped. Instead we exit cleanly (emit SIGTERM → the run loop's handler
 * drains and returns), and the always-on task's 1-minute keep-alive
 * TimeTrigger relaunches from the swapped binary within ≤60s. The relaunched
 * process deletes the stale `.old` on startup. No console window, no watcher.
 */
export async function selfRestart(
  opts: SelfRestartOpts,
): Promise<{ ok: boolean; stderr?: string }> {
  const platform = opts.procPlatform ?? process.platform;
  if (platform === "win32") {
    const trigger =
      opts.triggerShutdown ??
      (() => {
        // Emit through the normal shutdown path so memory (SQLite/WAL) and the
        // run-lock are released cleanly, exactly like a POSIX SIGTERM restart.
        process.emit("SIGTERM" as NodeJS.Signals);
      });
    trigger();
    return { ok: true };
  }
  return opts.serviceControl.restart();
}

function noopServiceControl(): ServiceControl {
  return {
    async isActive() {
      return false;
    },
    async restart() {
      return {
        ok: false,
        stderr: `phantombot has no service-manager backend on ${process.platform}`,
      };
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
    case "windows":
      return `powershell -Command "Get-Content -Wait -Tail 50 \\"$env:LOCALAPPDATA\\phantombot\\logs\\phantombot.out.log\\""`;
    case "linux":
    default:
      return "journalctl --user -u phantombot -f";
  }
}
