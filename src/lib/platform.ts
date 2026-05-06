/**
 * Cross-platform service-manager router.
 *
 * Phantombot ships on Linux (systemd --user) and macOS (launchd, per-user
 * LaunchAgents). The two backends have different unit-file shapes,
 * different control verbs, and different log destinations — this module
 * is the single place where CLI code decides which one to talk to.
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

export type { ServiceControl };

export type Platform = "linux" | "darwin" | "unsupported";

export function currentPlatform(): Platform {
  if (process.platform === "linux") return "linux";
  if (process.platform === "darwin") return "darwin";
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
    default:
      return noopServiceControl();
  }
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
    case "linux":
    default:
      return "journalctl --user -u phantombot -f";
  }
}
