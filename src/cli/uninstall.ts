/**
 * `phantombot uninstall` — stop, disable, remove the host-appropriate
 * service-manager units. Best-effort; missing units / inactive services
 * are not errors.
 *
 *   - Linux  → systemctl --user stop/disable + remove unit files
 *   - macOS  → launchctl bootout + remove plists
 */

import { defineCommand } from "citty";

import {
  BunLaunchctlRunner,
  defaultPlistPath,
  guiDomain,
  heartbeatPlistPath as launchdHeartbeatPath,
  type LaunchctlRunner,
  nightlyPlistPath as launchdNightlyPath,
  tickPlistPath as launchdTickPath,
  uninstallPhantombotPlists,
} from "../lib/launchd.ts";
import { currentPlatform } from "../lib/platform.ts";
import {
  BunSystemctlRunner,
  buildSystemctlEnv,
  defaultUnitPath,
  ensureUserSystemdEnv,
  uninstallPhantombotUnit,
  type SystemctlRunner,
  type UserSystemdEnv,
} from "../lib/systemd.ts";
import type { WriteSink } from "../lib/io.ts";

export interface RunUninstallInput {
  unitPath?: string;
  plistPath?: string;
  heartbeatPlistPath?: string;
  nightlyPlistPath?: string;
  tickPlistPath?: string;
  systemctl?: SystemctlRunner;
  launchctl?: LaunchctlRunner;
  out?: WriteSink;
  err?: WriteSink;
  ensureSystemdEnv?: () => UserSystemdEnv;
  platform?: "linux" | "darwin" | "unsupported";
  domain?: string;
}

export async function runUninstall(
  input: RunUninstallInput = {},
): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const platform = input.platform ?? currentPlatform();

  switch (platform) {
    case "linux":
      return runUninstallLinux(input, out, err);
    case "darwin":
      return runUninstallDarwin(input, out, err);
    default:
      err.write(
        `phantombot uninstall supports linux and darwin only; this host reports platform=${process.platform}\n`,
      );
      return 2;
  }
}

async function runUninstallLinux(
  input: RunUninstallInput,
  out: WriteSink,
  err: WriteSink,
): Promise<number> {
  const sysEnv = input.ensureSystemdEnv
    ? input.ensureSystemdEnv()
    : ensureUserSystemdEnv();
  if (!sysEnv.ready) {
    err.write(
      `no user-level systemd bus available: ${sysEnv.reason}\n` +
        "skipping systemctl calls and just removing the unit file (if any).\n",
    );
  } else if (sysEnv.autoSet) {
    out.write(`auto-detected XDG_RUNTIME_DIR=${sysEnv.runtimeDir}\n`);
  }

  const unitPath = input.unitPath ?? defaultUnitPath();
  const systemctl =
    input.systemctl ?? new BunSystemctlRunner(buildSystemctlEnv(sysEnv));

  await uninstallPhantombotUnit({ unitPath, systemctl, out, err });
  out.write("uninstall complete\n");
  return 0;
}

async function runUninstallDarwin(
  input: RunUninstallInput,
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

  await uninstallPhantombotPlists({
    plistPath: input.plistPath ?? defaultPlistPath(),
    heartbeatPlistPath: input.heartbeatPlistPath ?? launchdHeartbeatPath(),
    nightlyPlistPath: input.nightlyPlistPath ?? launchdNightlyPath(),
    tickPlistPath: input.tickPlistPath ?? launchdTickPath(),
    domain,
    launchctl,
    out,
    err,
  });
  out.write("uninstall complete\n");
  return 0;
}

export default defineCommand({
  meta: {
    name: "uninstall",
    description:
      "Stop, disable, and remove the phantombot service-manager units (systemd --user on Linux, launchd LaunchAgent on macOS).",
  },
  async run() {
    const code = await runUninstall();
    process.exitCode = code;
  },
});
