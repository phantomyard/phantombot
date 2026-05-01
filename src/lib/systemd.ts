/**
 * systemd --user unit generation and install/uninstall logic for phantombot.
 *
 * The runner indirection (SystemctlRunner) keeps the command code testable —
 * tests inject a fake runner instead of actually invoking systemctl.
 */

import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { WriteSink } from "./io.ts";

export const PHANTOMBOT_UNIT_NAME = "phantombot.service";

export function defaultUnitPath(): string {
  return join(homedir(), ".config", "systemd", "user", PHANTOMBOT_UNIT_NAME);
}

export interface SystemdUnitParams {
  /** Absolute path to the phantombot binary. */
  binPath: string;
  /** Args to pass to phantombot. e.g. ["run"]. */
  args: readonly string[];
  description?: string;
}

/**
 * Generate the [Unit]/[Service]/[Install] body for the phantombot
 * systemd --user unit. Pure function.
 */
export function generateSystemdUnit(params: SystemdUnitParams): string {
  const exec = [params.binPath, ...params.args].map(quoteArg).join(" ");
  const desc =
    params.description ?? "Phantombot — personality-first chat agent";
  return `[Unit]
Description=${desc}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${exec}
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
}

function quoteArg(s: string): string {
  if (/^[A-Za-z0-9_/.\-]+$/.test(s)) return s;
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

export interface SystemctlResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SystemctlRunner {
  run(args: readonly string[]): Promise<SystemctlResult>;
}

export class BunSystemctlRunner implements SystemctlRunner {
  /**
   * Pass an explicit env. Bun.spawn does NOT pick up later
   * `process.env.X = …` mutations when env is omitted (the OS-level env
   * is captured at process startup), so callers that auto-set
   * XDG_RUNTIME_DIR / DBUS_SESSION_BUS_ADDRESS at runtime must hand the
   * runner a fresh env snapshot containing those values. Default is a
   * spread of process.env at construction time.
   */
  constructor(private readonly env: NodeJS.ProcessEnv = { ...process.env }) {}

  async run(args: readonly string[]): Promise<SystemctlResult> {
    const proc = Bun.spawn(["systemctl", ...args], {
      env: this.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr };
  }
}

export interface InstallOptions {
  binPath: string;
  unitPath: string;
  systemctl: SystemctlRunner;
  out: WriteSink;
  err: WriteSink;
}

export async function installPhantombotUnit(
  opts: InstallOptions,
): Promise<{ installed: boolean }> {
  const unit = generateSystemdUnit({ binPath: opts.binPath, args: ["run"] });
  await mkdir(dirname(opts.unitPath), { recursive: true });
  await writeFile(opts.unitPath, unit, "utf8");
  opts.out.write(`wrote unit file: ${opts.unitPath}\n`);

  for (const args of [
    ["--user", "daemon-reload"],
    ["--user", "enable", PHANTOMBOT_UNIT_NAME],
    ["--user", "start", PHANTOMBOT_UNIT_NAME],
  ]) {
    const r = await opts.systemctl.run(args);
    if (r.exitCode !== 0) {
      opts.err.write(
        `systemctl ${args.join(" ")} failed (${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}\n`,
      );
      return { installed: false };
    }
  }
  opts.out.write("enabled and started phantombot.service\n");
  return { installed: true };
}

export interface UninstallOptions {
  unitPath: string;
  systemctl: SystemctlRunner;
  out: WriteSink;
  err: WriteSink;
}

export async function uninstallPhantombotUnit(
  opts: UninstallOptions,
): Promise<{ removed: boolean }> {
  // stop + disable are best-effort: a half-installed unit is fine to remove.
  for (const args of [
    ["--user", "stop", PHANTOMBOT_UNIT_NAME],
    ["--user", "disable", PHANTOMBOT_UNIT_NAME],
  ]) {
    const r = await opts.systemctl.run(args);
    if (r.exitCode !== 0) {
      opts.out.write(
        `systemctl ${args.join(" ")} returned ${r.exitCode} (continuing)\n`,
      );
    }
  }

  if (existsSync(opts.unitPath)) {
    await unlink(opts.unitPath);
    opts.out.write(`removed ${opts.unitPath}\n`);
  } else {
    opts.out.write(`(no unit file at ${opts.unitPath})\n`);
  }

  const r = await opts.systemctl.run(["--user", "daemon-reload"]);
  if (r.exitCode !== 0) {
    opts.err.write(
      `systemctl --user daemon-reload failed: ${r.stderr.trim()}\n`,
    );
  }
  return { removed: true };
}

export interface UserSystemdEnv {
  /** True if we have (or set) XDG_RUNTIME_DIR pointing at a valid runtime dir. */
  ready: boolean;
  /** True if phantombot set the env vars itself rather than inheriting them. */
  autoSet: boolean;
  /** Resolved value of XDG_RUNTIME_DIR (the directory). */
  runtimeDir?: string;
  /** Populated when ready=false. */
  reason?: string;
}

export interface EnsureUserSystemdEnvOptions {
  /** Override the current uid (for testing). */
  uid?: number;
  /**
   * Override the runtime dir to check. Defaults to `/run/user/<uid>`.
   * Useful in tests so we don't depend on the host's actual /run/user.
   */
  runtimeDir?: string;
  /** existsSync override (for testing). */
  exists?: (path: string) => boolean;
  /** mutable env to read/write (for testing). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Make the user-level systemd bus reachable for subprocesses we spawn.
 *
 * If XDG_RUNTIME_DIR is already set in env (e.g. real ssh / machinectl
 * shell session), do nothing.
 *
 * Otherwise — typical when reaching kai via `sudo su -`, where PAM does
 * not propagate XDG_RUNTIME_DIR to the target user — derive it from
 * `/run/user/<uid>`. If that directory exists (it will when linger is
 * enabled), set both XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS so
 * `systemctl --user` can find the bus. Subprocesses inherit the env.
 *
 * If the directory doesn't exist, linger isn't on (or the user manager
 * isn't running) — return ready=false with a helpful reason.
 */
export function ensureUserSystemdEnv(
  opts: EnsureUserSystemdEnvOptions = {},
): UserSystemdEnv {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;

  if (env.XDG_RUNTIME_DIR) {
    return { ready: true, autoSet: false, runtimeDir: env.XDG_RUNTIME_DIR };
  }

  const uid = opts.uid ?? process.getuid?.();
  if (uid === undefined) {
    return {
      ready: false,
      autoSet: false,
      reason: "cannot determine current uid (process.getuid() unavailable)",
    };
  }

  const runtimeDir = opts.runtimeDir ?? `/run/user/${uid}`;
  if (!exists(runtimeDir)) {
    return {
      ready: false,
      autoSet: false,
      reason: `${runtimeDir} does not exist — enable linger first: sudo loginctl enable-linger ${env.USER ?? "$USER"}`,
    };
  }

  env.XDG_RUNTIME_DIR = runtimeDir;
  if (!env.DBUS_SESSION_BUS_ADDRESS) {
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runtimeDir}/bus`;
  }
  return { ready: true, autoSet: true, runtimeDir };
}
