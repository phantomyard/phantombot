/**
 * `phantombot install` — write a systemd --user unit for `phantombot run`,
 * reload, enable, start.
 *
 * Requires the compiled binary (process.execPath ends in 'phantombot' or
 * the user passes --bin). Running from `bun src/index.ts` won't work
 * because the resulting unit would point at the bun runtime + a script
 * path that's only valid in the dev directory.
 */

import { defineCommand } from "citty";
import { basename } from "node:path";

import {
  BunSystemctlRunner,
  defaultUnitPath,
  ensureUserSystemdEnv,
  installPhantombotUnit,
  type SystemctlRunner,
  type UserSystemdEnv,
} from "../lib/systemd.ts";
import type { WriteSink } from "../lib/io.ts";

function buildSubEnv(sysEnv: UserSystemdEnv): NodeJS.ProcessEnv {
  // Spread process.env — but Bun.spawn may not see runtime mutations,
  // so explicitly re-stamp the values we know systemctl needs.
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (sysEnv.runtimeDir) {
    env.XDG_RUNTIME_DIR = sysEnv.runtimeDir;
    if (!env.DBUS_SESSION_BUS_ADDRESS) {
      env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${sysEnv.runtimeDir}/bus`;
    }
  }
  return env;
}

export interface RunInstallInput {
  binPath?: string;
  unitPath?: string;
  out?: WriteSink;
  err?: WriteSink;
  /** Override systemctl runner for testing. */
  systemctl?: SystemctlRunner;
  /** Override systemd-env detection for testing. */
  ensureSystemdEnv?: () => UserSystemdEnv;
}

export async function runInstall(input: RunInstallInput = {}): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;

  const binPath = input.binPath ?? process.execPath;
  if (basename(binPath) !== "phantombot") {
    err.write(
      `phantombot install needs the compiled binary, not '${basename(binPath)}'. ` +
        `Build it with \`bun run build\`, then run install via \`./dist/phantombot install\`.\n`,
    );
    return 2;
  }

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
  const systemctl = input.systemctl ?? new BunSystemctlRunner(buildSubEnv(sysEnv));

  const result = await installPhantombotUnit({
    binPath,
    unitPath,
    systemctl,
    out,
    err,
  });
  if (!result.installed) return 1;

  out.write(
    `\nview logs:    journalctl --user -u phantombot -f\n` +
      `restart:      systemctl --user restart phantombot\n` +
      `uninstall:    phantombot uninstall\n`,
  );
  return 0;
}

export default defineCommand({
  meta: {
    name: "install",
    description:
      "Install a systemd --user unit for phantombot run, reload, enable, and start it.",
  },
  async run() {
    const code = await runInstall();
    process.exitCode = code;
  },
});
