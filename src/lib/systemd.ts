/**
 * systemd --user unit generation and install/uninstall logic for phantombot.
 *
 * The runner indirection (SystemctlRunner) keeps the command code testable —
 * tests inject a fake runner instead of actually invoking systemctl.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { WriteSink } from "./io.ts";

export const PHANTOMBOT_UNIT_NAME = "phantombot.service";
export const HEARTBEAT_SERVICE_NAME = "phantombot-heartbeat.service";
export const HEARTBEAT_TIMER_NAME = "phantombot-heartbeat.timer";
export const NIGHTLY_SERVICE_NAME = "phantombot-nightly.service";
export const NIGHTLY_TIMER_NAME = "phantombot-nightly.timer";
export const TICK_SERVICE_NAME = "phantombot-tick.service";
export const TICK_TIMER_NAME = "phantombot-tick.timer";

/**
 * Both .env files we source into every phantombot unit:
 *   ~/.config/phantombot/.env  — phantombot's own runtime secrets
 *                                 (TTS keys; written by `phantombot voice`).
 *   ~/.env                     — the agent's general-purpose credentials
 *                                 (GITHUB_TOKEN, ssh passphrases, etc.;
 *                                 written via `phantombot env set`).
 *
 * Leading `-` makes both optional — a fresh install with neither file
 * present still starts cleanly. The merged process.env is what spawned
 * harnesses inherit, so the agent finds credentials without re-reading
 * the file.
 */
const ENVIRONMENT_FILE_LINES =
  "EnvironmentFile=-%h/.config/phantombot/.env\n" +
  "EnvironmentFile=-%h/.env";

export function defaultUnitPath(): string {
  return join(homedir(), ".config", "systemd", "user", PHANTOMBOT_UNIT_NAME);
}

export function heartbeatServicePath(): string {
  return join(homedir(), ".config", "systemd", "user", HEARTBEAT_SERVICE_NAME);
}

export function heartbeatTimerPath(): string {
  return join(homedir(), ".config", "systemd", "user", HEARTBEAT_TIMER_NAME);
}

export function nightlyServicePath(): string {
  return join(homedir(), ".config", "systemd", "user", NIGHTLY_SERVICE_NAME);
}

export function nightlyTimerPath(): string {
  return join(homedir(), ".config", "systemd", "user", NIGHTLY_TIMER_NAME);
}

export function tickServicePath(): string {
  return join(homedir(), ".config", "systemd", "user", TICK_SERVICE_NAME);
}

export function tickTimerPath(): string {
  return join(homedir(), ".config", "systemd", "user", TICK_TIMER_NAME);
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
 *
 * - Environment=PATH ensures the harness's Bash tool can find
 *   `phantombot` (installed at ~/.local/bin/phantombot) when it tries
 *   to call `phantombot memory search ...`.
 * - Two EnvironmentFile= lines: phantombot's own .env plus the user's
 *   general-purpose ~/.env. The agent finds credentials in process.env
 *   without re-reading either file. See ENVIRONMENT_FILE_LINES.
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
Environment="PATH=%h/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
${ENVIRONMENT_FILE_LINES}
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

/** Generate the heartbeat oneshot service body. */
export function generateHeartbeatService(binPath: string): string {
  const exec = [binPath, "heartbeat"].map(quoteArg).join(" ");
  return `[Unit]
Description=Phantombot heartbeat — mechanical 30-minute maintenance pass

[Service]
Type=oneshot
ExecStart=${exec}
Environment="PATH=%h/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
${ENVIRONMENT_FILE_LINES}
StandardOutput=journal
StandardError=journal
`;
}

/** Generate the heartbeat timer body — fires every 30 minutes. */
export function generateHeartbeatTimer(): string {
  return `[Unit]
Description=Phantombot heartbeat timer (every 30 min)

[Timer]
OnBootSec=2min
OnUnitActiveSec=30min
AccuracySec=1min
Persistent=true

[Install]
WantedBy=timers.target
`;
}

/** Generate the nightly oneshot service body. */
export function generateNightlyService(binPath: string): string {
  const exec = [binPath, "nightly"].map(quoteArg).join(" ");
  return `[Unit]
Description=Phantombot nightly — cognitive distillation pass
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${exec}
TimeoutStartSec=2700
Environment="PATH=%h/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
${ENVIRONMENT_FILE_LINES}
StandardOutput=journal
StandardError=journal
`;
}

/** Generate the nightly timer body — fires daily at 02:00 local. */
export function generateNightlyTimer(): string {
  return `[Unit]
Description=Phantombot nightly timer (daily 02:00)

[Timer]
OnCalendar=*-*-* 02:00:00
AccuracySec=1min
Persistent=true

[Install]
WantedBy=timers.target
`;
}

/** Generate the tick oneshot service body — runs due scheduled tasks. */
export function generateTickService(binPath: string): string {
  const exec = [binPath, "tick"].map(quoteArg).join(" ");
  return `[Unit]
Description=Phantombot tick — fire any scheduled tasks that are due
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${exec}
Environment="PATH=%h/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
${ENVIRONMENT_FILE_LINES}
StandardOutput=journal
StandardError=journal
`;
}

/**
 * Generate the tick timer body — fires every minute.
 *
 * AccuracySec=1s keeps the tick close to the schedule edge instead of
 * the default 1min slop, so an `0 * * * *` task fires near :00 instead
 * of any-time-in-the-first-minute. Cheap because the tick itself is
 * almost always a no-op (no due tasks).
 */
export function generateTickTimer(): string {
  return `[Unit]
Description=Phantombot tick timer (every minute)

[Timer]
OnBootSec=30s
OnUnitActiveSec=1min
AccuracySec=1s
Persistent=false

[Install]
WantedBy=timers.target
`;
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

/**
 * Build the env we hand to BunSystemctlRunner. Spread process.env, then
 * overlay XDG_RUNTIME_DIR / DBUS_SESSION_BUS_ADDRESS from the
 * UserSystemdEnv result. Bun.spawn doesn't pick up runtime mutations to
 * process.env, so we have to construct the env explicitly here.
 */
export function buildSystemctlEnv(
  sysEnv: UserSystemdEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (sysEnv.runtimeDir) {
    env.XDG_RUNTIME_DIR = sysEnv.runtimeDir;
    if (!env.DBUS_SESSION_BUS_ADDRESS) {
      env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${sysEnv.runtimeDir}/bus`;
    }
  }
  return env;
}

export interface ServiceControl {
  /** True iff `systemctl --user is-active phantombot.service` returns "active". */
  isActive(): Promise<boolean>;
  /** Restart the phantombot service. Returns ok=false on failure. */
  restart(): Promise<{ ok: boolean; stderr?: string }>;
  /**
   * Bring the on-disk systemd unit up-to-date with the current template if
   * it's stale (or absent under conditions where re-render is appropriate).
   * Returns whether a rewrite happened — callers can use it to print a notice.
   *
   * Why this matters: a pre-Phase-29 unit lacks `EnvironmentFile=`, so
   * secrets written to ~/.config/phantombot/.env (TTS keys, etc.) never
   * reach the running service even after restart. The voice/telegram/harness
   * TUIs call this before restart so the saved config actually takes effect.
   */
  rerenderUnitIfStale(): Promise<{ rerendered: boolean; backupPath?: string }>;
}

/**
 * Compare the on-disk unit at unitPath against the canonical template for
 * binPath. If absent or different, write the canonical template and run
 * `systemctl --user daemon-reload`. Returns whether a rerender happened
 * and, if it did, the path of any backup written.
 *
 * Pure on the inputs — caller picks the unit path, the bin path, and the
 * systemctl runner. Tests inject a fake runner; callers in production use
 * BunSystemctlRunner with an env that has XDG_RUNTIME_DIR set.
 *
 * Backup behaviour: when an existing unit differs from the template,
 * its old contents are saved to `${unitPath}.bak` *before* we overwrite,
 * so a hand-edit (which the user really shouldn't be doing — phantombot
 * owns this file) is recoverable instead of silently lost. The .bak path
 * is returned so callers can surface it. A fresh install (current === undefined)
 * has nothing to back up; in that case backupPath is undefined.
 */
export async function ensureUnitCurrent(opts: {
  unitPath: string;
  binPath: string;
  systemctl: SystemctlRunner;
}): Promise<{ rerendered: boolean; backupPath?: string }> {
  const expected = generateSystemdUnit({
    binPath: opts.binPath,
    args: ["run"],
  });
  let current: string | undefined;
  if (existsSync(opts.unitPath)) {
    current = await readFile(opts.unitPath, "utf8");
  }
  if (current === expected) return { rerendered: false };
  await mkdir(dirname(opts.unitPath), { recursive: true });
  let backupPath: string | undefined;
  if (current !== undefined) {
    backupPath = `${opts.unitPath}.bak`;
    await writeFile(backupPath, current, "utf8");
  }
  await writeFile(opts.unitPath, expected, "utf8");
  await opts.systemctl.run(["--user", "daemon-reload"]);
  return { rerendered: true, backupPath };
}

/**
 * Default rerenderUnitIfStale wiring: only fires when the running binary is
 * an installed `phantombot` (not `bun` in dev), only when a unit exists on
 * disk (don't presume an install the user never asked for), and only when
 * the user-systemd bus is reachable (no linger → nothing we can daemon-
 * reload anyway).
 */
async function defaultRerenderUnitIfStale(): Promise<{
  rerendered: boolean;
  backupPath?: string;
}> {
  const binPath = process.execPath;
  if (basename(binPath) !== "phantombot") return { rerendered: false };
  const unitPath = defaultUnitPath();
  if (!existsSync(unitPath)) return { rerendered: false };
  const sysEnv = ensureUserSystemdEnv();
  if (!sysEnv.ready) return { rerendered: false };
  const systemctl = new BunSystemctlRunner(buildSystemctlEnv(sysEnv));
  return ensureUnitCurrent({ unitPath, binPath, systemctl });
}

/**
 * Default ServiceControl backed by real systemctl + ensureUserSystemdEnv.
 * Returns `isActive: false` when systemd isn't reachable (no linger / no
 * runtime dir) so callers can treat "service unknown" the same as
 * "service not running" — they don't need to print a restart hint.
 */
export function defaultServiceControl(): ServiceControl {
  return {
    async isActive() {
      const sysEnv = ensureUserSystemdEnv();
      if (!sysEnv.ready) return false;
      const r = await new BunSystemctlRunner(buildSystemctlEnv(sysEnv)).run([
        "--user",
        "is-active",
        PHANTOMBOT_UNIT_NAME,
      ]);
      return r.exitCode === 0 && r.stdout.trim() === "active";
    },
    async restart() {
      const sysEnv = ensureUserSystemdEnv();
      if (!sysEnv.ready) return { ok: false, stderr: sysEnv.reason };
      const r = await new BunSystemctlRunner(buildSystemctlEnv(sysEnv)).run([
        "--user",
        "restart",
        PHANTOMBOT_UNIT_NAME,
      ]);
      return r.exitCode === 0
        ? { ok: true }
        : { ok: false, stderr: r.stderr.trim() || `exit ${r.exitCode}` };
    },
    rerenderUnitIfStale: defaultRerenderUnitIfStale,
  };
}

export interface InstallOptions {
  binPath: string;
  unitPath: string;
  /**
   * Optional path overrides for the heartbeat/nightly companion units.
   * Default to the per-user XDG locations (~/.config/systemd/user/...).
   * Tests override these to keep writes inside a tmpdir; without that,
   * `bun test` would create real files in the developer's actual
   * ~/.config/systemd/user/ that the test cleanup never removes.
   */
  heartbeatServicePath?: string;
  heartbeatTimerPath?: string;
  nightlyServicePath?: string;
  nightlyTimerPath?: string;
  tickServicePath?: string;
  tickTimerPath?: string;
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

  // Heartbeat service + timer
  const hbService = opts.heartbeatServicePath ?? heartbeatServicePath();
  const hbTimer = opts.heartbeatTimerPath ?? heartbeatTimerPath();
  await mkdir(dirname(hbService), { recursive: true });
  await mkdir(dirname(hbTimer), { recursive: true });
  await writeFile(hbService, generateHeartbeatService(opts.binPath), "utf8");
  await writeFile(hbTimer, generateHeartbeatTimer(), "utf8");
  opts.out.write(`wrote heartbeat units: ${hbService} + ${hbTimer}\n`);

  // Nightly service + timer
  const ngService = opts.nightlyServicePath ?? nightlyServicePath();
  const ngTimer = opts.nightlyTimerPath ?? nightlyTimerPath();
  await mkdir(dirname(ngService), { recursive: true });
  await mkdir(dirname(ngTimer), { recursive: true });
  await writeFile(ngService, generateNightlyService(opts.binPath), "utf8");
  await writeFile(ngTimer, generateNightlyTimer(), "utf8");
  opts.out.write(`wrote nightly units: ${ngService} + ${ngTimer}\n`);

  // Tick service + timer
  const tkService = opts.tickServicePath ?? tickServicePath();
  const tkTimer = opts.tickTimerPath ?? tickTimerPath();
  await mkdir(dirname(tkService), { recursive: true });
  await mkdir(dirname(tkTimer), { recursive: true });
  await writeFile(tkService, generateTickService(opts.binPath), "utf8");
  await writeFile(tkTimer, generateTickTimer(), "utf8");
  opts.out.write(`wrote tick units: ${tkService} + ${tkTimer}\n`);

  for (const args of [
    ["--user", "daemon-reload"],
    ["--user", "enable", PHANTOMBOT_UNIT_NAME],
    ["--user", "start", PHANTOMBOT_UNIT_NAME],
    ["--user", "enable", HEARTBEAT_TIMER_NAME],
    ["--user", "start", HEARTBEAT_TIMER_NAME],
    ["--user", "enable", NIGHTLY_TIMER_NAME],
    ["--user", "start", NIGHTLY_TIMER_NAME],
    ["--user", "enable", TICK_TIMER_NAME],
    ["--user", "start", TICK_TIMER_NAME],
  ]) {
    const r = await opts.systemctl.run(args);
    if (r.exitCode !== 0) {
      opts.err.write(
        `systemctl ${args.join(" ")} failed (${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}\n`,
      );
      return { installed: false };
    }
  }
  opts.out.write(
    "enabled and started phantombot.service + heartbeat.timer + nightly.timer + tick.timer\n",
  );
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
    ["--user", "stop", TICK_TIMER_NAME],
    ["--user", "disable", TICK_TIMER_NAME],
    ["--user", "stop", NIGHTLY_TIMER_NAME],
    ["--user", "disable", NIGHTLY_TIMER_NAME],
    ["--user", "stop", HEARTBEAT_TIMER_NAME],
    ["--user", "disable", HEARTBEAT_TIMER_NAME],
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

  // Main unit gets a "(no unit file at …)" log if absent so the user can
  // tell whether they ever installed. Heartbeat units are silent if absent
  // (don't add noise for users on pre-phase-26 installs).
  if (existsSync(opts.unitPath)) {
    await unlink(opts.unitPath);
    opts.out.write(`removed ${opts.unitPath}\n`);
  } else {
    opts.out.write(`(no unit file at ${opts.unitPath})\n`);
  }
  for (const path of [
    heartbeatServicePath(),
    heartbeatTimerPath(),
    nightlyServicePath(),
    nightlyTimerPath(),
    tickServicePath(),
    tickTimerPath(),
  ]) {
    if (existsSync(path)) {
      await unlink(path);
      opts.out.write(`removed ${path}\n`);
    }
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
 * Otherwise — typical when reaching a service user via `sudo su -`, where PAM does
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
