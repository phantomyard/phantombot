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
import { isPhantombotBinary } from "./binaryIdentity.ts";
import type { WriteSink } from "./io.ts";

export const PHANTOMBOT_UNIT_NAME = "phantombot.service";
/**
 * Heartbeat units are systemd TEMPLATES (#486): one
 * `phantombot-heartbeat@<persona>.timer` instance per served persona
 * (default_persona ∪ autostart_personas), so every persona on a
 * multi-persona rig gets its own 30-minute maintenance pass — drawer
 * promotion, index refresh, turn-flush, day-rollover nightly trigger —
 * instead of only the default persona being swept.
 */
export const HEARTBEAT_SERVICE_NAME = "phantombot-heartbeat@.service";
export const HEARTBEAT_TIMER_NAME = "phantombot-heartbeat@.timer";
/** Pre-#486 single-persona heartbeat units — retired by the heal path once
 * the default persona's instance is verified active. */
export const LEGACY_HEARTBEAT_SERVICE_NAME = "phantombot-heartbeat.service";
export const LEGACY_HEARTBEAT_TIMER_NAME = "phantombot-heartbeat.timer";
/** Name of the heartbeat timer instance serving one persona. */
export function heartbeatInstanceTimer(persona: string): string {
  return `phantombot-heartbeat@${persona}.timer`;
}
/** Name of the heartbeat service instance serving one persona. */
export function heartbeatInstanceService(persona: string): string {
  return `phantombot-heartbeat@${persona}.service`;
}
/**
 * RETIRED units. The nightly no longer runs on a clock — it is triggered by
 * startup and by the heartbeat noticing the calendar day rolled over (see
 * src/lib/nightlyTrigger.ts), so a 02:00 timer would only ever duplicate work
 * on a box that happened to be awake. These names survive solely so upgrades
 * can stop, disable and delete what a previous install left behind.
 */
export const NIGHTLY_SERVICE_NAME = "phantombot-nightly.service";
export const NIGHTLY_TIMER_NAME = "phantombot-nightly.timer";
export const RETIRED_TIMER_NAMES = [NIGHTLY_TIMER_NAME] as const;
export const RETIRED_UNIT_NAMES = [
  NIGHTLY_TIMER_NAME,
  NIGHTLY_SERVICE_NAME,
] as const;
export const TICK_SERVICE_NAME = "phantombot-tick.service";
export const TICK_TIMER_NAME = "phantombot-tick.timer";

/*
 * NOTE (#452): the units deliberately carry NO `EnvironmentFile=` lines.
 * Phantombot's units used to source `~/.config/phantombot/.env` and `~/.env`,
 * which made the plaintext files authoritative in practice while the docs
 * called the vault canonical. Secrets now reach the process exactly one way —
 * `loadVaultIntoEnv()` decrypting the active persona's vault at startup — and
 * the plaintext files are a one-way legacy import kept only for rollback.
 *
 * Rollback: an operator who needs the old behaviour can add the two
 * `EnvironmentFile=-%h/...` lines back to the generated unit by hand (or
 * install an older phantombot); the plaintext files are never deleted.
 */

export const PHANTOMBOT_SERVICE_PATH =
  "%h/.local/share/pi-node/bin:" +
  "%h/.local/share/pi-node/current/bin:" +
  "%h/.pi/agent/bin:" +
  "%h/.local/bin:" +
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export function defaultUnitPath(): string {
  return join(homedir(), ".config", "systemd", "user", PHANTOMBOT_UNIT_NAME);
}

export function heartbeatServicePath(): string {
  return join(homedir(), ".config", "systemd", "user", HEARTBEAT_SERVICE_NAME);
}

export function heartbeatTimerPath(): string {
  return join(homedir(), ".config", "systemd", "user", HEARTBEAT_TIMER_NAME);
}

/** Path of the retired pre-#486 heartbeat service (kept for cleanup only). */
export function legacyHeartbeatServicePath(): string {
  return join(
    homedir(),
    ".config",
    "systemd",
    "user",
    LEGACY_HEARTBEAT_SERVICE_NAME,
  );
}

/** Path of the retired pre-#486 heartbeat timer (kept for cleanup only). */
export function legacyHeartbeatTimerPath(): string {
  return join(
    homedir(),
    ".config",
    "systemd",
    "user",
    LEGACY_HEARTBEAT_TIMER_NAME,
  );
}

/** Path of the retired nightly service (kept for cleanup only). */
export function nightlyServicePath(): string {
  return join(homedir(), ".config", "systemd", "user", NIGHTLY_SERVICE_NAME);
}

/** Path of the retired nightly timer (kept for cleanup only). */
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
 * - Environment=PATH gives the service a deterministic non-login PATH.
 *   It includes ~/.local/bin for phantombot plus stable per-user harness
 *   shim locations. Versioned npm/node install paths must still leave a
 *   stable executable on one of these PATH entries or doctor/startup will
 *   report the missing harness.
 * - No EnvironmentFile= lines: credentials come from the encrypted persona
 *   vault at startup, never from a plaintext file (#452).
 */
export function generateSystemdUnit(params: SystemdUnitParams): string {
  const exec = [params.binPath, ...params.args].map(quoteArg).join(" ");
  const desc =
    params.description ?? "Phantombot — Giving the harness a Soul";
  return `[Unit]
Description=${desc}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${exec}
Restart=on-failure
RestartSec=5
# /restart and /update terminate the running process via systemctl restart,
# which sends SIGTERM. If the process exits with 143 (128+SIGTERM) before
# the in-process handler can swap that for a clean 0 — for example because
# the SIGTERM lands while we're still inside an async cleanup chain —
# systemd would otherwise log it as a failure and try Restart=on-failure.
# Declaring 143 a success exit status keeps self-restart journals quiet
# and stops a spurious Restart= cycle on top of the real one.
SuccessExitStatus=143
# Backstop to the in-process force-exit watchdog (see src/cli/run.ts): if the
# watchdog itself can't fire, cap systemd's stop wait at 15s instead of the
# 90s default so a hung relay socket can't stall a restart for a minute and a
# half. The code-level watchdog (~5s) is the primary fix; this is the floor.
TimeoutStopSec=15s
Environment="PATH=${PHANTOMBOT_SERVICE_PATH}"
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

/**
 * Generate the heartbeat oneshot service TEMPLATE body (#486). The `%i`
 * instance specifier becomes the persona name, so one template serves
 * every `phantombot-heartbeat@<persona>.timer` instance on the host.
 */
export function generateHeartbeatService(binPath: string): string {
  const exec = [binPath, "heartbeat", "--persona", "%i"]
    .map(quoteArg)
    .join(" ");
  return `[Unit]
Description=Phantombot heartbeat — mechanical 30-minute maintenance pass (%i)

[Service]
Type=oneshot
ExecStart=${exec}
Environment="PATH=${PHANTOMBOT_SERVICE_PATH}"
StandardOutput=journal
StandardError=journal
`;
}

/**
 * Generate the heartbeat timer body — fires every 30 minutes.
 *
 * Uses OnCalendar (wall-clock anchored) rather than OnUnitActiveSec
 * (relative to the last service activation). OnUnitActiveSec can wedge
 * into the `active (elapsed) / Trigger: n/a` zombie state after long
 * user-manager uptime and silently stop rescheduling — the heartbeat
 * stalled 8 days this way (2026-05-14 → 2026-05-22). A calendar schedule
 * cannot enter that state. Matches nightly.timer's anchoring.
 */
export function generateHeartbeatTimer(): string {
  return `[Unit]
Description=Phantombot heartbeat timer (every 30 min, %i)

[Timer]
OnCalendar=*:0/30
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
TimeoutStartSec=infinity
Environment="PATH=${PHANTOMBOT_SERVICE_PATH}"
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
  /**
   * Process exit status as Bun reports it from `proc.exited` — for a
   * signal-terminated child that is 128+signum (SIGTERM => 143), never
   * null. `signal` carries the signal name separately so callers can
   * distinguish "systemctl chose to exit 143" from "systemctl was killed",
   * without having to reverse the arithmetic.
   */
  exitCode: number;
  stdout: string;
  stderr: string;
  /**
   * Signal name if the child was terminated by one, else null. Optional so
   * the many existing test doubles for SystemctlRunner stay valid; the real
   * BunSystemctlRunner always populates it, and isSelfRestartTeardown()
   * falls back to the 143 exit code when it is absent.
   */
  signal?: string | null;
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
    // proc.exitCode is null for a signal-terminated child; proc.exited
    // still resolves to 128+signum. Surface the signal name too so
    // isSelfRestartTeardown() doesn't have to infer it from 143 alone.
    return { exitCode, stdout, stderr, signal: proc.signalCode ?? null };
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

/**
 * systemctl args used by `defaultSystemdServiceControl().restart()`.
 *
 * --no-block: enqueue the restart job and return immediately rather than
 * waiting for the unit to come back up. The /restart and /update flows
 * call restart() from INSIDE the running service, so systemd kills our
 * whole cgroup the moment the stop begins — including the systemctl
 * child.
 *
 * --no-block SHRINKS that window; it does not close it. Nothing orders
 * "systemctl exits 0" before "systemd SIGTERMs the cgroup", so on a fast
 * host systemctl loses the race and comes back as 143 (128+SIGTERM) even
 * though the restart was already accepted. That was phantombot #408:
 * every successful /update logged `restart failed after binary swap`.
 * The classification fix lives in isSelfRestartTeardown() below — this
 * flag is a latency optimisation, not the correctness guarantee.
 *
 * Exported so the unit-test layer can pin this without spawning a real
 * subprocess.
 */
export const SELF_RESTART_ARGS: readonly string[] = [
  "--user",
  "--no-block",
  "restart",
  PHANTOMBOT_UNIT_NAME,
];

/**
 * True iff a self-restart `systemctl` result is our own cgroup teardown
 * rather than a failure.
 *
 * `restart()` is called from INSIDE the running service, so the systemctl
 * child we spawned lives in the cgroup systemd is about to tear down. Being
 * SIGTERM'd mid-`systemctl restart` IS the restart working: systemd only
 * sends that signal once it has accepted the job and begun the stop. Exit
 * 143 is the same event seen through Bun's `proc.exited` (128+SIGTERM),
 * which is what we get when the signal arrives before systemctl can exit 0.
 *
 * Deliberately narrow:
 * - SIGKILL / 137 is NOT included — that's the OOM killer or a hard kill,
 *   a real fault worth surfacing (same rule as the harness classifier).
 * - Any other non-zero exit (bad unit name, no session bus, systemctl not
 *   found) still classifies as a genuine failure.
 *
 * The unit template already declares `SuccessExitStatus=143` for exactly
 * this reason (see generateSystemdUnit); this is the same judgement applied
 * to the code path. See phantombot #408.
 */
export function isSelfRestartTeardown(r: SystemctlResult): boolean {
  return r.signal === "SIGTERM" || r.exitCode === 128 + 15;
}

/**
 * The whole body of `defaultSystemdServiceControl().restart()`, minus the
 * env plumbing, so the classification above can be tested against a fake
 * runner instead of a live user-systemd bus (which CI does not have).
 */
export async function runSelfRestart(
  systemctl: SystemctlRunner,
): Promise<{ ok: boolean; stderr?: string }> {
  const r = await systemctl.run(SELF_RESTART_ARGS);
  return r.exitCode === 0 || isSelfRestartTeardown(r)
    ? { ok: true }
    : { ok: false, stderr: r.stderr.trim() || `exit ${r.exitCode}` };
}

export interface ServiceControl {
  /** True iff `systemctl --user is-active phantombot.service` returns "active". */
  isActive(): Promise<boolean>;
  /**
   * Start the phantombot service (idempotent — starting an already-running
   * service is a no-op success). On backends with a keep-alive relaunch
   * (launchd KeepAlive, Windows TimeTrigger), this also re-arms the
   * keep-alive that `stop()` disabled. Returns ok=false on failure.
   */
  start(): Promise<{ ok: boolean; stderr?: string }>;
  /**
   * Stop the phantombot service and keep it down. On backends whose
   * supervisor would otherwise relaunch the process (launchd KeepAlive,
   * Windows 1-minute TimeTrigger), this disables that relaunch so the
   * service stays stopped until the next `start()`. Idempotent — stopping
   * an already-stopped service is a no-op success. Returns ok=false on
   * failure.
   */
  stop(): Promise<{ ok: boolean; stderr?: string }>;
  /** Restart the phantombot service. Returns ok=false on failure. */
  restart(): Promise<{ ok: boolean; stderr?: string }>;
  /**
   * Bring the on-disk systemd unit up-to-date with the current template if
   * it's stale (or absent under conditions where re-render is appropriate).
   * Returns whether a rewrite happened — callers can use it to print a notice.
   *
   * Why this matters: a stale unit can carry retired directives (e.g. the
   * pre-#452 `EnvironmentFile=` lines that sourced plaintext .env files) or
   * miss current ones, so a restart alone doesn't give the service the
   * environment the current build expects. The voice/telegram/harness TUIs
   * call this before restart so the saved config actually takes effect.
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
  if (!isPhantombotBinary(binPath)) return { rerendered: false };
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
 *
 * Most callers want the platform-router `defaultServiceControl` in
 * `./platform.ts`, which dispatches to this on Linux and to launchd on
 * macOS. This export stays for direct Linux-only usage and tests.
 */
export function defaultSystemdServiceControl(): ServiceControl {
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
    async start() {
      const sysEnv = ensureUserSystemdEnv();
      if (!sysEnv.ready) return { ok: false, stderr: sysEnv.reason };
      // `systemctl --user start` is idempotent — it's a no-op success when the
      // unit is already active. Our main unit is Restart=on-failure (not
      // always), so nothing else re-arms; start is the only way back up.
      const r = await new BunSystemctlRunner(buildSystemctlEnv(sysEnv)).run([
        "--user",
        "start",
        PHANTOMBOT_UNIT_NAME,
      ]);
      return r.exitCode === 0
        ? { ok: true }
        : { ok: false, stderr: r.stderr.trim() || `exit ${r.exitCode}` };
    },
    async stop() {
      const sysEnv = ensureUserSystemdEnv();
      if (!sysEnv.ready) return { ok: false, stderr: sysEnv.reason };
      // Because the main unit is Restart=on-failure, a clean `stop` (SIGTERM →
      // exit 0) leaves it stopped — no keep-alive to disable, unlike launchd
      // and Windows. `stop` on an already-stopped unit exits 0.
      const r = await new BunSystemctlRunner(buildSystemctlEnv(sysEnv)).run([
        "--user",
        "stop",
        PHANTOMBOT_UNIT_NAME,
      ]);
      return r.exitCode === 0
        ? { ok: true }
        : { ok: false, stderr: r.stderr.trim() || `exit ${r.exitCode}` };
    },
    async restart() {
      const sysEnv = ensureUserSystemdEnv();
      if (!sysEnv.ready) return { ok: false, stderr: sysEnv.reason };
      // Scoped to restart() vs stop() because restart() is the ONLY verb
      // that can be issued from inside the unit it acts on: a self-stop
      // would not come back, so nothing calls it that way. stop() is
      // therefore always issued from outside the doomed cgroup and a
      // SIGTERM'd systemctl there is a real interruption, not teardown.
      // restart() is NOT internal-only — `phantombot update --restart`
      // (src/cli/update.ts) and `phantombot harness` (src/cli/harness.ts)
      // reach it from a terminal. 143 is still the right call for them:
      // that CLI is usually itself spawned from inside the running service
      // (an agent shelling out to `phantombot update`), so it shares the
      // cgroup. The residual case — a genuinely detached CLI whose
      // systemctl child is SIGTERM'd for an unrelated reason — reports a
      // success it cannot distinguish from teardown. Accepted: it is rare,
      // and the alternative was crying failure on EVERY successful update,
      // which trains everyone to ignore the one line that should page.
      return runSelfRestart(new BunSystemctlRunner(buildSystemctlEnv(sysEnv)));
    },
    rerenderUnitIfStale: defaultRerenderUnitIfStale,
  };
}

/**
 * One canonical entry for each of the 7 phantombot systemd unit
 * files (1 main service + 3 oneshot service/timer pairs).
 *
 * Centralised so `installPhantombotUnit` and `ensureSystemdUnitsCurrent`
 * can't drift: changing a template here updates both. Was inlined twice
 * before, which review flagged as a maintenance hazard.
 */
export interface PhantombotUnitTarget {
  /** Absolute on-disk path of the unit file. */
  path: string;
  /** Rendered unit body. */
  content: string;
  /** systemd unit name (e.g. "phantombot-tick.timer"). */
  unit: string;
  /** True for `.timer` units; false for `.service` units. */
  isTimer: boolean;
}

/**
 * Optional per-unit path overrides. Production callers leave these
 * empty and pick up the XDG defaults; tests override to keep writes
 * inside a tmpdir.
 */
export interface PhantombotUnitPathOverrides {
  unitPath?: string;
  heartbeatServicePath?: string;
  heartbeatTimerPath?: string;
  tickServicePath?: string;
  tickTimerPath?: string;
  /**
   * Where the RETIRED nightly units would live. Not generated any more — only
   * consulted so cleanup can delete them out of a tmpdir under test.
   */
  nightlyServicePath?: string;
  nightlyTimerPath?: string;
}

/**
 * Render the canonical (path, content, unit, isTimer) tuples for every
 * phantombot unit file. Single source of truth shared by
 * `installPhantombotUnit` (writes them fresh) and
 * `ensureSystemdUnitsCurrent` (re-writes any that drifted).
 */
export function phantombotUnitTargets(
  binPath: string,
  overrides: PhantombotUnitPathOverrides = {},
): PhantombotUnitTarget[] {
  return [
    {
      path: overrides.unitPath ?? defaultUnitPath(),
      content: generateSystemdUnit({ binPath, args: ["run"] }),
      unit: PHANTOMBOT_UNIT_NAME,
      isTimer: false,
    },
    {
      path: overrides.heartbeatServicePath ?? heartbeatServicePath(),
      content: generateHeartbeatService(binPath),
      unit: HEARTBEAT_SERVICE_NAME,
      isTimer: false,
    },
    {
      path: overrides.heartbeatTimerPath ?? heartbeatTimerPath(),
      content: generateHeartbeatTimer(),
      unit: HEARTBEAT_TIMER_NAME,
      isTimer: true,
    },
    {
      path: overrides.tickServicePath ?? tickServicePath(),
      content: generateTickService(binPath),
      unit: TICK_SERVICE_NAME,
      isTimer: false,
    },
    {
      path: overrides.tickTimerPath ?? tickTimerPath(),
      content: generateTickTimer(),
      unit: TICK_TIMER_NAME,
      isTimer: true,
    },
  ];
}

/**
 * Names of phantombot unit files that exist on disk but whose content no
 * longer matches the running binary's templates. This is the *detection*
 * half of the reconcile loop — `ensureSystemdUnitsCurrent` does the
 * rewriting; this just names what would be rewritten, so `doctor` can SEE
 * and report drift instead of cheerfully printing "systemd: ok" while a
 * stale unit (e.g. a pre-`OnCalendar` heartbeat timer that an in-place
 * `update` swapped the binary but never rewrote) sits latent on disk.
 *
 * Only existing files count: a missing file isn't "drift" (you can't drift
 * from a file that isn't there) and is reported separately as
 * `missing_unit_files`. Pure on its inputs — the caller supplies the
 * targets (from `phantombotUnitTargets`) and a reader that returns the
 * on-disk content or `undefined` when the file is absent — so it unit-tests
 * without touching the filesystem.
 */
export function driftedUnitNames(
  targets: PhantombotUnitTarget[],
  readUnit: (path: string) => string | undefined,
): string[] {
  const drifted: string[] = [];
  for (const t of targets) {
    const current = readUnit(t.path);
    if (current === undefined) continue; // missing, not drift
    if (current !== t.content) drifted.push(basename(t.path));
  }
  return drifted;
}

/**
 * Surgical re-render of all six phantombot systemd unit files, plus a
 * re-enable / re-start of any timer that isn't currently active.
 *
 * This is the post-update healer: a `phantombot update` swaps the
 * binary, then calls this to make sure the on-disk unit files still
 * match the new version's templates AND that the timers are actually
 * armed. Without it, a release that renames or moves a unit (or that
 * lands on a host whose `~/.config/systemd/user/timers.target.wants/`
 * symlinks have rotted from a previous bad update) leaves the user
 * with timers that look enabled but never fire — exactly the bug that
 * stranded ~2 days of scheduled tasks on hz-phantombot in 2026-05.
 *
 * Pure on the inputs: caller picks the paths and the systemctl
 * runner. Tests inject a FakeSystemctl and a tmpdir; production calls
 * this with real ones via `runHealSystemdUnits` below.
 *
 * Idempotent: writing the same content is a no-op; an already-enabled
 * + active timer is left alone. Only changes get logged.
 */
export interface EnsureUnitsCurrentOptions extends PhantombotUnitPathOverrides {
  binPath: string;
  systemctl: SystemctlRunner;
  /**
   * Personas this host serves — `{default_persona} ∪ autostart_personas`,
   * DEFAULT PERSONA FIRST (the legacy heartbeat unit is only retired once
   * the default's instance is verified active, so a failed migration never
   * leaves a host with no heartbeat at all). Each persona gets an enabled
   * `phantombot-heartbeat@<persona>.timer` instance; enabled instances
   * naming a persona NOT in this list are disabled (a persona removed from
   * autostart loses its maintenance with it). When omitted, instance
   * management is skipped entirely — the template files are still
   * reconciled, but no instances are armed or retired (callers without a
   * config in scope use this; the next heartbeat/doctor heal completes the
   * migration).
   */
  personas?: readonly string[];
  /**
   * Where the RETIRED pre-#486 heartbeat units live. Only consulted so the
   * migration can delete them out of a tmpdir under test.
   */
  legacyHeartbeatServicePath?: string;
  legacyHeartbeatTimerPath?: string;
  /**
   * Timer unit names (e.g. "phantombot-heartbeat.timer") that must be
   * re-armed even when systemd reports them enabled AND active.
   *
   * Why this exists: a timer can sit in `active (elapsed)` with
   * `NextElapse: n/a` — systemd's `is-active` says "active", but the
   * timer has stopped scheduling future fires and is silently dead.
   * `is-enabled`/`is-active` can't see this; the only ground truth is
   * whether the timer's work actually ran recently (the last-fired
   * markers in timerHealth.ts). Callers that detect a stale marker pass
   * the corresponding timer here so we `restart` it — which forces
   * systemd to recompute the next elapse and re-arm. `enable --now` is
   * a no-op on an already-active timer, so it can't fix this case; only
   * a restart can. Empty/omitted = no forced re-arm (the default).
   */
  forceRearmTimers?: readonly string[];
}

export interface EnsureUnitsCurrentResult {
  /** Basenames of unit files that were (re)written. Empty = nothing changed. */
  rewrote: string[];
  /** Backups created for any unit file whose previous content differed. */
  backups: string[];
  /** Timer unit names that were re-enabled and/or restarted to repair them. */
  repairedTimers: string[];
  /** Retired unit files removed from disk (upgrade cleanup). Usually empty. */
  removedRetired: string[];
  /** Heartbeat timer instances disabled because their persona is no longer
   * served (empty when `personas` was not passed). */
  disabledInstances: string[];
}

/**
 * Stop, disable and delete the units phantombot no longer installs.
 *
 * Upgrade path only: an install from before the nightly timer was retired
 * still has `phantombot-nightly.timer` armed at 02:00. Leaving it would fire a
 * redundant (harmless but confusing) sweep forever, and `doctor` would keep
 * reporting a timer that no template claims. Best-effort throughout — a
 * systemctl that fails on an already-absent unit is expected, not an error.
 * Returns the basenames actually deleted, so callers only log on real cleanup.
 */
export async function removeRetiredUnits(
  systemctl: SystemctlRunner,
  paths: readonly string[] = [nightlyTimerPath(), nightlyServicePath()],
  timersToStop: readonly string[] = RETIRED_TIMER_NAMES,
): Promise<string[]> {
  const present = paths.filter((p) => existsSync(p));
  // Nothing on disk → nothing systemd can run, so skip the IPC entirely. This
  // is the case on every install from this version onward, which matters
  // because the heal path runs on every heartbeat.
  if (present.length === 0) return [];

  for (const unit of timersToStop) {
    await systemctl.run(["--user", "stop", unit]);
    await systemctl.run(["--user", "disable", unit]);
  }
  const removed: string[] = [];
  for (const path of present) {
    try {
      await unlink(path);
      removed.push(basename(path));
    } catch {
      // Read-only dir or a racing uninstall — nothing we can do, and the
      // stale unit is inert once disabled above.
    }
  }
  return removed;
}

export async function ensureSystemdUnitsCurrent(
  opts: EnsureUnitsCurrentOptions,
): Promise<EnsureUnitsCurrentResult> {
  const targets = phantombotUnitTargets(opts.binPath, opts);

  // Sweep away units we no longer install (currently the 02:00 nightly timer)
  // before reconciling the ones we do. Cheap, and it means a box heals itself
  // on the next heartbeat instead of needing a reinstall.
  const removedRetired = await removeRetiredUnits(opts.systemctl, [
    opts.nightlyTimerPath ?? nightlyTimerPath(),
    opts.nightlyServicePath ?? nightlyServicePath(),
  ]);

  const rewrote: string[] = [];
  const backups: string[] = [];
  // Timer units whose *content* we just rewrote. A daemon-reload alone is
  // not enough to recover a timer whose definition changed while it sat in
  // the `active (elapsed)` zombie state (the pre-OnCalendar bug): the unit
  // stays wedged until restarted. We restart these below so the new
  // schedule actually arms.
  const rewroteTimerUnits = new Set<string>();
  for (const t of targets) {
    let current: string | undefined;
    if (existsSync(t.path)) {
      current = await readFile(t.path, "utf8");
    }
    if (current === t.content) continue;
    await mkdir(dirname(t.path), { recursive: true });
    if (current !== undefined) {
      const bak = `${t.path}.bak`;
      await writeFile(bak, current, "utf8");
      backups.push(bak);
    }
    await writeFile(t.path, t.content, "utf8");
    rewrote.push(basename(t.path));
    if (t.isTimer) rewroteTimerUnits.add(t.unit);
  }
  if (rewrote.length > 0 || removedRetired.length > 0) {
    await opts.systemctl.run(["--user", "daemon-reload"]);
  }

  // For each timer, verify it is enabled AND active. is-enabled exits 0 +
  // prints "enabled" when good; is-active exits 0 + prints "active" when
  // armed. Anything else means the timer isn't actually running and we
  // need to enable --now to repair it. Cheap to recheck — systemctl is
  // local IPC and these calls take ~ms.
  //
  // The heartbeat TEMPLATE timer (`phantombot-heartbeat@.timer`) is
  // skipped here — a template can never be enabled itself; its instances
  // are reconciled per persona below.
  const forceRearm = new Set(opts.forceRearmTimers ?? []);
  const repairedTimers: string[] = [];
  for (const t of targets) {
    if (!t.isTimer || t.unit.includes("@")) continue;
    const enabled = await opts.systemctl.run([
      "--user",
      "is-enabled",
      t.unit,
    ]);
    const active = await opts.systemctl.run(["--user", "is-active", t.unit]);
    const isEnabled = enabled.exitCode === 0 && enabled.stdout.trim() === "enabled";
    const isActive = active.exitCode === 0 && active.stdout.trim() === "active";
    if (isEnabled && isActive) {
      // Looks healthy to systemd. But re-arm with `restart` if either:
      //   (a) a ground-truth marker says this timer has stopped firing (the
      //       `active (elapsed)` zombie), or
      //   (b) we just rewrote this timer's content (its schedule changed,
      //       e.g. OnUnitActiveSec → OnCalendar) — a daemon-reload doesn't
      //       un-wedge an elapsed timer, only a restart re-evaluates and
      //       arms the new definition.
      // `enable --now` won't touch an already-active timer, so it can't
      // recover either case. restart forces systemd to recompute the next
      // elapse and re-arm the trigger; combined with Persistent=true any
      // missed run fires a catch-up almost immediately, which also
      // refreshes the last-fired marker.
      if (forceRearm.has(t.unit) || rewroteTimerUnits.has(t.unit)) {
        await opts.systemctl.run(["--user", "restart", t.unit]);
        repairedTimers.push(t.unit);
      }
      continue;
    }
    await opts.systemctl.run(["--user", "enable", "--now", t.unit]);
    repairedTimers.push(t.unit);
  }

  // Per-persona heartbeat instances (#486). One enabled
  // `phantombot-heartbeat@<persona>.timer` per served persona; instances
  // for personas no longer served are disabled; and the retired
  // single-persona heartbeat unit is removed only AFTER the default
  // persona's instance is verified armed — a migration that can't arm the
  // replacement keeps the legacy unit rather than leaving the host with
  // no heartbeat at all (it is retried on the next heal pass).
  let disabledInstances: string[] = [];
  if (opts.personas) {
    const templateRewrote = rewroteTimerUnits.has(HEARTBEAT_TIMER_NAME);
    let defaultInstanceReady = false;
    for (let i = 0; i < opts.personas.length; i++) {
      const unit = heartbeatInstanceTimer(opts.personas[i]!);
      const enabled = await opts.systemctl.run(["--user", "is-enabled", unit]);
      const active = await opts.systemctl.run(["--user", "is-active", unit]);
      const isEnabled =
        enabled.exitCode === 0 && enabled.stdout.trim() === "enabled";
      const isActive =
        active.exitCode === 0 && active.stdout.trim() === "active";
      let ready = isEnabled && isActive;
      if (ready) {
        if (forceRearm.has(unit) || templateRewrote) {
          // A failed restart can leave the instance stopped; only keep
          // `ready` when the unit is verifiably active afterwards, so the
          // legacy retirement below never fires on a dead replacement.
          const r = await opts.systemctl.run(["--user", "restart", unit]);
          if (r.exitCode === 0) {
            const re = await opts.systemctl.run(["--user", "is-active", unit]);
            ready = re.exitCode === 0 && re.stdout.trim() === "active";
          } else {
            ready = false;
          }
          if (ready) repairedTimers.push(unit);
        }
      } else {
        const r = await opts.systemctl.run(["--user", "enable", "--now", unit]);
        if (r.exitCode === 0) {
          repairedTimers.push(unit);
          ready = true;
        }
      }
      if (i === 0) defaultInstanceReady = ready;
    }

    disabledInstances = await disableUnservedHeartbeatInstances(
      opts.systemctl,
      opts.personas,
    );

    if (defaultInstanceReady) {
      const removedLegacy = await removeRetiredUnits(
        opts.systemctl,
        [
          opts.legacyHeartbeatTimerPath ?? legacyHeartbeatTimerPath(),
          opts.legacyHeartbeatServicePath ?? legacyHeartbeatServicePath(),
        ],
        [LEGACY_HEARTBEAT_TIMER_NAME],
      );
      if (removedLegacy.length > 0) {
        removedRetired.push(...removedLegacy);
        await opts.systemctl.run(["--user", "daemon-reload"]);
      }
    }
  }

  return { rewrote, backups, repairedTimers, removedRetired, disabledInstances };
}

/**
 * Persona names with an ENABLED `phantombot-heartbeat@<persona>.timer`
 * instance, parsed from `systemctl --user list-unit-files`. The template
 * itself (`@.timer`, empty instance name) is never returned. Pure IPC +
 * parse — no files touched — so it works for both the heal path and
 * persona-lifecycle callers.
 */
export async function listEnabledHeartbeatInstances(
  systemctl: SystemctlRunner,
): Promise<string[]> {
  const r = await systemctl.run([
    "--user",
    "list-unit-files",
    "--no-legend",
    "--no-pager",
    "phantombot-heartbeat@*.timer",
  ]);
  if (r.exitCode !== 0) return [];
  const personas: string[] = [];
  for (const line of r.stdout.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 2) continue;
    const [unit, state] = cols;
    if (!unit!.startsWith("phantombot-heartbeat@") || !unit!.endsWith(".timer")) {
      continue;
    }
    if (state !== "enabled" && state !== "enabled-runtime") continue;
    const persona = unit!.slice(
      "phantombot-heartbeat@".length,
      -".timer".length,
    );
    if (persona.length > 0) personas.push(persona);
  }
  return personas;
}

/**
 * Disable (and stop) every enabled heartbeat instance whose persona is NOT
 * in `served` — the "removed from autostart loses its maintenance" half of
 * instance reconciliation. Returns the disabled unit names.
 */
export async function disableUnservedHeartbeatInstances(
  systemctl: SystemctlRunner,
  served: readonly string[],
): Promise<string[]> {
  const servedSet = new Set(served);
  const enabled = await listEnabledHeartbeatInstances(systemctl);
  const disabled: string[] = [];
  for (const persona of enabled) {
    if (servedSet.has(persona)) continue;
    const unit = heartbeatInstanceTimer(persona);
    const r = await systemctl.run(["--user", "disable", "--now", unit]);
    if (r.exitCode === 0) disabled.push(unit);
  }
  return disabled;
}

export interface InstallOptions {
  binPath: string;
  unitPath: string;
  /**
   * Personas to arm heartbeat instances for (#486) — default persona
   * FIRST, same contract as `ensureSystemdUnitsCurrent`. When omitted (no
   * config on a pre-init box), no instances are armed; the startup doctor
   * / first heartbeat heal provisions them once a config exists.
   */
  personas?: readonly string[];
  /**
   * Optional path overrides for the heartbeat/nightly companion units.
   * Default to the per-user XDG locations (~/.config/systemd/user/...).
   * Tests override these to keep writes inside a tmpdir; without that,
   * `bun test` would create real files in the developer's actual
   * ~/.config/systemd/user/ that the test cleanup never removes.
   */
  heartbeatServicePath?: string;
  heartbeatTimerPath?: string;
  legacyHeartbeatServicePath?: string;
  legacyHeartbeatTimerPath?: string;
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
  // Single source of truth for path + body of every unit file. Shared
  // with `ensureSystemdUnitsCurrent` so a template change in one place
  // can't get out of sync with the other.
  const targets = phantombotUnitTargets(opts.binPath, opts);
  for (const t of targets) {
    await mkdir(dirname(t.path), { recursive: true });
    await writeFile(t.path, t.content, "utf8");
    opts.out.write(`wrote ${t.unit}: ${t.path}\n`);
  }

  // Reinstalling over an older layout: drop the retired 02:00 nightly timer.
  const removedRetired = await removeRetiredUnits(opts.systemctl, [
    opts.nightlyTimerPath ?? nightlyTimerPath(),
    opts.nightlyServicePath ?? nightlyServicePath(),
  ]);
  for (const name of removedRetired) {
    opts.out.write(`removed retired unit: ${name}\n`);
  }

  const enableSteps: string[][] = [
    ["--user", "daemon-reload"],
    ["--user", "enable", PHANTOMBOT_UNIT_NAME],
    ["--user", "start", PHANTOMBOT_UNIT_NAME],
  ];
  // One heartbeat timer instance per served persona (#486).
  for (const persona of opts.personas ?? []) {
    enableSteps.push(
      ["--user", "enable", heartbeatInstanceTimer(persona)],
      ["--user", "start", heartbeatInstanceTimer(persona)],
    );
  }
  enableSteps.push(
    ["--user", "enable", TICK_TIMER_NAME],
    ["--user", "start", TICK_TIMER_NAME],
  );
  let defaultInstanceReady = opts.personas === undefined;
  for (let i = 0; i < enableSteps.length; i++) {
    const args = enableSteps[i]!;
    const r = await opts.systemctl.run(args);
    if (r.exitCode !== 0) {
      opts.err.write(
        `systemctl ${args.join(" ")} failed (${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}\n`,
      );
      return { installed: false };
    }
    if (
      opts.personas !== undefined &&
      opts.personas.length > 0 &&
      args[1] === "start" &&
      args[2] === heartbeatInstanceTimer(opts.personas[0]!)
    ) {
      defaultInstanceReady = true;
    }
  }

  // Only retire the pre-#486 single-persona heartbeat unit once its
  // replacement (the default persona's instance) is armed — same migration
  // rule as the heal path, so a failed install never strands a host
  // heartbeat-less.
  if (defaultInstanceReady) {
    const removedLegacy = await removeRetiredUnits(
      opts.systemctl,
      [
        opts.legacyHeartbeatTimerPath ?? legacyHeartbeatTimerPath(),
        opts.legacyHeartbeatServicePath ?? legacyHeartbeatServicePath(),
      ],
      [LEGACY_HEARTBEAT_TIMER_NAME],
    );
    for (const name of removedLegacy) {
      opts.out.write(`removed retired unit: ${name}\n`);
    }
  }
  opts.out.write(
    `enabled and started phantombot.service + ${opts.personas?.length ?? 0} heartbeat instance(s) + tick.timer\n`,
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
  const stopSteps: string[][] = [
    ["--user", "stop", TICK_TIMER_NAME],
    ["--user", "disable", TICK_TIMER_NAME],
    ["--user", "stop", NIGHTLY_TIMER_NAME],
    ["--user", "disable", NIGHTLY_TIMER_NAME],
    // The retired pre-#486 single-persona heartbeat units, in case an
    // uninstall runs on a host that never got the migration heal.
    ["--user", "stop", LEGACY_HEARTBEAT_TIMER_NAME],
    ["--user", "disable", LEGACY_HEARTBEAT_TIMER_NAME],
    ["--user", "stop", LEGACY_HEARTBEAT_SERVICE_NAME],
    ["--user", "disable", LEGACY_HEARTBEAT_SERVICE_NAME],
  ];
  // Every per-persona heartbeat instance (#486).
  for (const persona of await listEnabledHeartbeatInstances(opts.systemctl)) {
    stopSteps.push(
      ["--user", "stop", heartbeatInstanceTimer(persona)],
      ["--user", "disable", heartbeatInstanceTimer(persona)],
    );
  }
  stopSteps.push(
    ["--user", "stop", PHANTOMBOT_UNIT_NAME],
    ["--user", "disable", PHANTOMBOT_UNIT_NAME],
  );
  for (const args of stopSteps) {
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
    legacyHeartbeatServicePath(),
    legacyHeartbeatTimerPath(),
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

/**
 * Provision/tear down heartbeat timer instances to match the served
 * persona set — the persona-lifecycle caller of the #486 machinery.
 * Invoked after `autostart_personas` changes (persona picker,
 * `persona new`, the TUI autostart action) so a newly-served persona's
 * first maintenance pass is at most 30 minutes away instead of waiting
 * for the next heal, and a removed persona's instance dies with it.
 *
 * Light by design: only instance enable/disable, no unit-file rendering
 * (the templates are install's/heal's job — if they're absent the enable
 * fails and the caller warns). Returns null when instance management
 * isn't possible here (no user-systemd bus), so callers can stay silent
 * on dev boxes and headless sessions.
 */
export async function defaultSyncHeartbeatInstances(
  personas: readonly string[],
): Promise<{ armed: string[]; disabled: string[] } | null> {
  // Real installed service only: unit management from a dev `bun` run or a
  // test would arm timers on the developer's actual host. The periodic
  // heal (which runs from the compiled binary's own heartbeat) reconciles
  // the same state, so skipping here never strands anyone.
  if (process.platform !== "linux") return null;
  if (!isPhantombotBinary()) return null;
  const sysEnv = ensureUserSystemdEnv();
  if (!sysEnv.ready) return null;
  const systemctl = new BunSystemctlRunner(buildSystemctlEnv(sysEnv));
  const armed: string[] = [];
  for (const persona of personas) {
    const unit = heartbeatInstanceTimer(persona);
    const enabled = await systemctl.run(["--user", "is-enabled", unit]);
    if (enabled.exitCode === 0 && enabled.stdout.trim() === "enabled") continue;
    const r = await systemctl.run(["--user", "enable", "--now", unit]);
    if (r.exitCode === 0) armed.push(unit);
    else {
      throw new Error(
        `systemctl enable --now ${unit} failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`,
      );
    }
  }
  const disabled = await disableUnservedHeartbeatInstances(systemctl, personas);
  return { armed, disabled };
}
