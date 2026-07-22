/**
 * `phantombot install` — write the host-appropriate service-manager
 * units for `phantombot run` and start them.
 *
 *   - Linux   → systemd --user units in ~/.config/systemd/user/
 *   - macOS   → launchd plists in ~/Library/LaunchAgents/
 *   - Windows → Task Scheduler logon tasks under \Phantombot\
 *
 * Requires the compiled binary (process.execPath ends in 'phantombot' or
 * the user passes --bin). Running from `bun src/index.ts` won't work
 * because the resulting unit would point at the bun runtime + a script
 * path that's only valid in the dev directory.
 */

import { defineCommand } from "citty";
import { basename } from "node:path";

import { installCompletions } from "../lib/completionInstall.ts";

import {
  BunLaunchctlRunner,
  defaultPlistPath,
  guiDomain,
  heartbeatPlistPath as launchdHeartbeatPath,
  installPhantombotPlists,
  type LaunchctlRunner,
  nightlyPlistPath as launchdNightlyPath,
  tickPlistPath as launchdTickPath,
} from "../lib/launchd.ts";
import { currentPlatform } from "../lib/platform.ts";
import {
  BunSystemctlRunner,
  buildSystemctlEnv,
  defaultUnitPath,
  ensureUserSystemdEnv,
  installPhantombotUnit,
  type SystemctlRunner,
  type UserSystemdEnv,
} from "../lib/systemd.ts";
import {
  BunSchtasksRunner,
  installPhantombotTasks,
  type SchtasksRunner,
} from "../lib/taskScheduler.ts";
import type { WriteSink } from "../lib/io.ts";

/**
 * Trailing "here's how to manage it" block shown after a successful install,
 * identical on every OS. Advertises the clean `phantombot <verb>` subcommands
 * rather than the raw systemctl/launchctl/schtasks incantations — the CLI wraps
 * those per-platform, so the user never has to see or type them.
 */
export function manageHints(): string {
  return (
    `\nmanage phantombot:\n` +
    `  phantombot start      start the service\n` +
    `  phantombot stop       stop the service\n` +
    `  phantombot restart    restart the service\n` +
    `  phantombot logs       tail the service logs\n` +
    `  phantombot uninstall  remove the service\n`
  );
}

export interface RunInstallInput {
  binPath?: string;
  /** systemd unit path (Linux) — defaults to ~/.config/systemd/user/phantombot.service. */
  unitPath?: string;
  /** launchd plist path (macOS) — defaults to ~/Library/LaunchAgents/dev.phantombot.phantombot.plist. */
  plistPath?: string;
  /**
   * Optional path overrides for the heartbeat/nightly/tick companion
   * units — pass-through to the platform-specific install helpers.
   * Tests use these to keep all unit writes inside a tmpdir; production
   * leaves them undefined and the helper picks the per-user XDG / Library
   * locations.
   */
  heartbeatServicePath?: string;
  heartbeatTimerPath?: string;
  nightlyServicePath?: string;
  nightlyTimerPath?: string;
  tickServicePath?: string;
  tickTimerPath?: string;
  heartbeatPlistPath?: string;
  nightlyPlistPath?: string;
  tickPlistPath?: string;
  out?: WriteSink;
  err?: WriteSink;
  /** Override systemctl runner for testing. */
  systemctl?: SystemctlRunner;
  /** Override launchctl runner for testing. */
  launchctl?: LaunchctlRunner;
  /** Override schtasks runner for testing (Windows). */
  schtasks?: SchtasksRunner;
  /** Override the current-user SID for testing (Windows). */
  sid?: string;
  /** Directory for transient Task Scheduler XML import files (Windows tests). */
  xmlDir?: string;
  /** Override systemd-env detection for testing. */
  ensureSystemdEnv?: () => UserSystemdEnv;
  /**
   * Override the platform check for testing. Defaults to currentPlatform()
   * which reads process.platform.
   */
  platform?: "linux" | "darwin" | "windows" | "unsupported";
  /** Override gui domain (e.g. "gui/501") on darwin. Defaults to gui/<current uid>. */
  domain?: string;
}

export async function runInstall(input: RunInstallInput = {}): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;

  const binPath = input.binPath ?? process.execPath;
  // The compiled binary is `phantombot` on POSIX and `phantombot.exe` on
  // Windows — accept either. Running from `bun src/index.ts` (basename `bun`)
  // is rejected because the resulting unit would point at the bun runtime.
  // Split on both separators so the check is correct regardless of which
  // platform's path we're handed (matters for cross-platform unit tests).
  const rawName = binPath.split(/[/\\]/).pop() ?? binPath;
  const binName = rawName.replace(/\.exe$/i, "");
  if (binName !== "phantombot") {
    err.write(
      `phantombot install needs the compiled binary, not '${basename(binPath)}'. ` +
        `Build it with \`bun run build\`, then run install via \`./dist/phantombot install\`.\n`,
    );
    return 2;
  }

  const platform = input.platform ?? currentPlatform();
  switch (platform) {
    case "linux":
      return runInstallLinux(input, binPath, out, err);
    case "darwin":
      return runInstallDarwin(input, binPath, out, err);
    case "windows":
      return runInstallWindows(input, binPath, out, err);
    default:
      err.write(
        `phantombot install supports linux, darwin and windows only; this host reports platform=${process.platform}\n`,
      );
      return 2;
  }
}

async function runInstallLinux(
  input: RunInstallInput,
  binPath: string,
  out: WriteSink,
  err: WriteSink,
): Promise<number> {
  const sysEnv = input.ensureSystemdEnv
    ? input.ensureSystemdEnv()
    : ensureUserSystemdEnv();
  if (!sysEnv.ready) {
    err.write(`no user-level systemd bus available: ${sysEnv.reason}\n`);
    return 2;
  }
  if (sysEnv.autoSet) {
    out.write(
      `auto-detected XDG_RUNTIME_DIR=${sysEnv.runtimeDir} (linger is enabled)\n`,
    );
  }

  const unitPath = input.unitPath ?? defaultUnitPath();
  const systemctl =
    input.systemctl ?? new BunSystemctlRunner(buildSystemctlEnv(sysEnv));

  const result = await installPhantombotUnit({
    binPath,
    unitPath,
    heartbeatServicePath: input.heartbeatServicePath,
    heartbeatTimerPath: input.heartbeatTimerPath,
    nightlyServicePath: input.nightlyServicePath,
    nightlyTimerPath: input.nightlyTimerPath,
    tickServicePath: input.tickServicePath,
    tickTimerPath: input.tickTimerPath,
    systemctl,
    out,
    err,
  });
  if (!result.installed) return 1;

  out.write(manageHints());
  return 0;
}

async function runInstallDarwin(
  input: RunInstallInput,
  binPath: string,
  out: WriteSink,
  err: WriteSink,
): Promise<number> {
  const launchctl = input.launchctl ?? new BunLaunchctlRunner();
  let domain: string;
  try {
    domain = input.domain ?? guiDomain();
  } catch (e) {
    err.write(`cannot determine launchd gui domain: ${(e as Error).message}\n`);
    return 2;
  }

  const result = await installPhantombotPlists({
    binPath,
    plistPath: input.plistPath ?? defaultPlistPath(),
    heartbeatPlistPath:
      input.heartbeatPlistPath ?? launchdHeartbeatPath(),
    nightlyPlistPath: input.nightlyPlistPath ?? launchdNightlyPath(),
    tickPlistPath: input.tickPlistPath ?? launchdTickPath(),
    domain,
    launchctl,
    out,
    err,
  });
  if (!result.installed) return 1;

  out.write(manageHints());
  return 0;
}

async function runInstallWindows(
  input: RunInstallInput,
  binPath: string,
  out: WriteSink,
  err: WriteSink,
): Promise<number> {
  const schtasks = input.schtasks ?? new BunSchtasksRunner();
  const result = await installPhantombotTasks({
    binPath,
    sid: input.sid,
    xmlDir: input.xmlDir,
    schtasks,
    out,
    err,
  });
  if (!result.installed) return 1;

  out.write(
    `\nThese tasks run for the current Windows user while logged in.\n` +
      manageHints(),
  );
  return 0;
}

export default defineCommand({
  meta: {
    name: "install",
    description:
      "Install the host-appropriate service unit for `phantombot run` (systemd --user on Linux, launchd LaunchAgent on macOS, Task Scheduler logon task on Windows) and start it.",
  },
  async run() {
    const code = await runInstall();
    // A successful install wires up shell tab-completion so it works right
    // away, with no extra step. Best-effort: a completion failure never turns
    // a successful install into a failure.
    if (code === 0) {
      try {
        await installCompletions();
      } catch (e) {
        process.stderr.write(
          `warning: could not set up shell completion: ${(e as Error).message}\n`,
        );
      }
    }
    process.exitCode = code;
  },
});
