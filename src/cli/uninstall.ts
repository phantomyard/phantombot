/**
 * `phantombot uninstall` — stop, disable, remove the systemd --user unit.
 * Best-effort; missing unit / inactive service are not errors.
 */

import { defineCommand } from "citty";

import {
  BunSystemctlRunner,
  defaultUnitPath,
  uninstallPhantombotUnit,
  userSystemdAvailable,
} from "../lib/systemd.ts";
import type { WriteSink } from "../lib/io.ts";
import type { SystemctlRunner } from "../lib/systemd.ts";

export interface RunUninstallInput {
  unitPath?: string;
  systemctl?: SystemctlRunner;
  out?: WriteSink;
  err?: WriteSink;
}

export async function runUninstall(
  input: RunUninstallInput = {},
): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;

  if (!userSystemdAvailable()) {
    err.write(
      "no user-level systemd bus available; skipping systemctl calls.\n",
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
