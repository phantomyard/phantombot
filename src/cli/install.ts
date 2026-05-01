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
  installPhantombotUnit,
  userSystemdAvailable,
} from "../lib/systemd.ts";
import type { WriteSink } from "../lib/io.ts";

export interface RunInstallInput {
  binPath?: string;
  unitPath?: string;
  out?: WriteSink;
  err?: WriteSink;
  /** Override systemctl runner for testing. */
  systemctl?: ConstructorParameters<typeof BunSystemctlRunner> extends []
    ? import("../lib/systemd.ts").SystemctlRunner
    : never;
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

  if (!userSystemdAvailable()) {
    err.write(
      "no user-level systemd bus available (XDG_RUNTIME_DIR not set).\n" +
        "If this is a headless service account (no login session), enable linger first:\n" +
        `  sudo loginctl enable-linger ${process.env.USER ?? "$USER"}\n` +
        "then re-run `phantombot install`.\n",
    );
    return 2;
  }

  const unitPath = input.unitPath ?? defaultUnitPath();
  const systemctl = input.systemctl ?? new BunSystemctlRunner();

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
