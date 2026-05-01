/**
 * `phantombot uninstall` — stop, disable, remove the systemd --user unit.
 * Best-effort; missing unit / inactive service are not errors.
 */

import { defineCommand } from "citty";

import {
  BunSystemctlRunner,
  defaultUnitPath,
  ensureUserSystemdEnv,
  uninstallPhantombotUnit,
  type SystemctlRunner,
  type UserSystemdEnv,
} from "../lib/systemd.ts";
import type { WriteSink } from "../lib/io.ts";

export interface RunUninstallInput {
  unitPath?: string;
  systemctl?: SystemctlRunner;
  out?: WriteSink;
  err?: WriteSink;
  ensureSystemdEnv?: () => UserSystemdEnv;
}

export async function runUninstall(
  input: RunUninstallInput = {},
): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;

  const sysEnv = input.ensureSystemdEnv
    ? input.ensureSystemdEnv()
    : ensureUserSystemdEnv();
  if (!sysEnv.ready) {
    err.write(
      `no user-level systemd bus available: ${sysEnv.reason}\n` +
        "skipping systemctl calls and just removing the unit file (if any).\n",
    );
  } else if (sysEnv.autoSet) {
    out.write(
      `auto-detected XDG_RUNTIME_DIR=${sysEnv.runtimeDir}\n`,
    );
  }

  const unitPath = input.unitPath ?? defaultUnitPath();
  const systemctl = input.systemctl ?? new BunSystemctlRunner();

  await uninstallPhantombotUnit({ unitPath, systemctl, out, err });
  out.write("uninstall complete\n");
  return 0;
}

export default defineCommand({
  meta: {
    name: "uninstall",
    description: "Stop, disable, and remove the phantombot systemd --user unit.",
  },
  async run() {
    const code = await runUninstall();
    process.exitCode = code;
  },
});
