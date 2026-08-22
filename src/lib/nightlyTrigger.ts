/**
 * When the nightly sweep gets triggered.
 *
 * There is no 02:00 timer any more. A clock is the wrong trigger for a pass
 * whose job is "distil the day that just closed": a box asleep at 02:00 misses
 * it entirely, and a box in a different timezone from its daily files runs it
 * against the wrong day. Two event-driven triggers replace it, both of which
 * are things that ALREADY happen:
 *
 *   1. startup   — `phantombot run` fires a detached sweep (covers laptops and
 *                  anything that was powered off).
 *   2. rollover  — the 30-min heartbeat notices that the calendar day has
 *                  changed since its previous fire, which means yesterday's
 *                  daily file is now closed, and fires a detached sweep.
 *
 * Rollover DETECTION rather than a file-creation watch: a daily file is written
 * lazily on the first capture of the day, so on a quiet day it may never be
 * created at all — a creation hook would silently starve, leaving yesterday
 * unprocessed forever. The day changing is unconditional.
 *
 * Both triggers are safe to fire redundantly: the sweep is ledger-driven and
 * idempotent, no-ops in milliseconds when nothing is pending, and holds an
 * in-flight marker so two sweeps can't double-file the same drawers.
 *
 * HOW the sweep is launched matters as much as when: on systemd the rollover
 * trigger runs inside a `Type=oneshot` unit whose cgroup is torn down the
 * instant the heartbeat exits, which killed the detached child seconds after
 * it started. See {@link buildNightlyLaunch}.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

import { log } from "./logger.ts";
import { PHANTOMBOT_SERVICE_PATH } from "./systemd.ts";

/** Why a sweep was fired. Logged, and useful in tests. */
export type NightlyTriggerReason = "startup" | "rollover" | "manual";

/**
 * The calendar day used for daily-file NAMING, so rollover detection and the
 * files it is detecting rollover FOR agree on where the boundary is.
 *
 * That basis is currently UTC (`memory capture` names the file from
 * `toISOString()`), which means "the day" closes at 01:00/02:00 local in
 * Europe — a known wart, tracked separately. What matters here is that this
 * helper and the daily-file writer use the SAME wrong-or-right boundary; a
 * mismatch would fire the sweep while the day it is about to process is still
 * being appended to.
 */
export function dailyFileDate(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Has the calendar day rolled over between the previous heartbeat fire and
 * now? `prevIso` is the timestamp recorded by the last fire; `undefined` (no
 * marker — first heartbeat ever, or a wiped state dir) is deliberately NOT a
 * rollover: startup already fired a sweep, and guessing here would double up.
 *
 * A clock stepped backwards (NTP correction, a restored VM snapshot) yields a
 * previous date in the future, which is also not a rollover — we compare for
 * strict "the recorded day is older than today".
 */
export function dayRolledOver(
  prevIso: string | undefined,
  now: Date = new Date(),
): boolean {
  if (!prevIso) return false;
  const prev = Date.parse(prevIso);
  if (Number.isNaN(prev)) return false;
  return dailyFileDate(new Date(prev)) < dailyFileDate(now);
}

/**
 * Resolved facts about the host that decide HOW the sweep is launched.
 * Injectable so the decision is testable without a systemd box.
 */
export interface NightlyHostEnv {
  /** `process.platform`. */
  platform: string;
  /** Absolute path to `systemd-run`, or undefined when it is not installed. */
  systemdRunPath?: string;
  /** Is this host booted under systemd (`/run/systemd/system` exists)? */
  systemdBooted: boolean;
  /** Is there a systemd --user session to own a transient unit? */
  userSessionRuntimeDir?: string;
  /** Home directory, used to resolve the env files the unit sources. */
  home: string;
}

const SYSTEMD_RUN_PATHS = ["/usr/bin/systemd-run", "/bin/systemd-run"];

/** Probe the real host. */
export function detectNightlyHostEnv(): NightlyHostEnv {
  return {
    platform: process.platform,
    systemdRunPath: SYSTEMD_RUN_PATHS.find((p) => existsSync(p)),
    systemdBooted: existsSync("/run/systemd/system"),
    userSessionRuntimeDir: process.env.XDG_RUNTIME_DIR,
    home: homedir(),
  };
}

/**
 * A transient unit name for one sweep. systemd unit names accept only
 * `[A-Za-z0-9:_.\-]`, and a persona name is user-supplied, so everything else
 * is folded to `-`. The timestamp+pid suffix keeps two concurrent launches
 * from colliding on a name (`--collect` reaps each one once it finishes).
 */
export function nightlyUnitName(
  persona: string,
  at: Date = new Date(),
  pid: number = process.pid,
): string {
  const safe = persona.replace(/[^A-Za-z0-9:_.-]/g, "-").slice(0, 48);
  const stamp = at.toISOString().replace(/[-:]/g, "").slice(0, 15);
  return `phantombot-nightly-${safe}-${stamp}-${pid}`;
}

/** What to actually execute, and whether it is the transient-unit path. */
export interface NightlyLaunch {
  command: string;
  args: string[];
  /** True when this launches a transient systemd unit rather than a bare child. */
  transient: boolean;
}

/**
 * Wrap the bare `phantombot nightly` invocation in `systemd-run --user` when
 * the host is systemd, and leave it bare otherwise.
 *
 * WHY (this is the bug this module exists to avoid): the rollover trigger runs
 * inside `phantombot-heartbeat.service`, which is `Type=oneshot`. The moment
 * `phantombot heartbeat` exits, systemd considers the unit finished and tears
 * down its cgroup — SIGKILLing every process still in it. `detached: true` +
 * `unref()` only detaches from Node's event loop and the controlling terminal;
 * it does NOT leave the cgroup, so the sweep was being killed about a second
 * after it started. Evidence: on the Linux boxes the sweep ledger has never
 * once recorded a completion in the 00:xx hour, while the launchd (macOS) and
 * Windows hosts have them routinely — the Linux nightly only ever completed
 * off the daemon-STARTUP trigger, i.e. it silently depended on restarts.
 *
 * A transient unit is its own cgroup with its own lifecycle, so the parent
 * exiting is no longer fatal. It also gets the sweep its own journal entry,
 * which is how the failure would have been visible in the first place.
 *
 * `KillMode=process` on the heartbeat unit was the smaller alternative and was
 * rejected: it leaves the sweep in the heartbeat's cgroup, so the NEXT
 * heartbeat 30 minutes later would kill a long backlog sweep mid-run.
 *
 * Env fidelity: a transient `--user` unit inherits the user manager's
 * environment, not the caller's, so the unit re-sources exactly the two env
 * files every other phantombot unit sources and pins the same PATH. Secrets
 * are never passed as `--setenv`, which would expose them in `systemctl show`
 * and the journal; the sweep decrypts its own vault at startup as any other
 * `phantombot` invocation does.
 */
export function buildNightlyLaunch(
  bare: { command: string; args: string[] },
  persona: string,
  env: NightlyHostEnv,
  unitName: string = nightlyUnitName(persona),
): NightlyLaunch {
  const usable =
    env.platform === "linux" &&
    env.systemdBooted &&
    !!env.systemdRunPath &&
    !!env.userSessionRuntimeDir;
  if (!usable) return { ...bare, transient: false };
  return {
    command: env.systemdRunPath as string,
    args: [
      "--user",
      "--quiet",
      // Reap the unit as soon as it finishes (or fails) so a box that has
      // swept for a year does not accumulate a year of failed unit stubs.
      "--collect",
      `--unit=${unitName}`,
      `--description=Phantombot nightly sweep (${persona})`,
      `--property=Environment=PATH=${nightlyUnitPath(env.home)}`,
      `--property=Environment=PHANTOMBOT_PERSONA=${persona}`,
      `--property=EnvironmentFile=-${env.home}/.local/share/phantombot/personas/${persona}/.env`,
      `--property=EnvironmentFile=-${env.home}/.env`,
      "--",
      bare.command,
      ...bare.args,
    ],
    transient: true,
  };
}

/**
 * The same PATH the installed units pin, with `%h` resolved here: unit-file
 * specifiers are expanded by the unit-file parser, and transient properties
 * go over D-Bus where they are not.
 *
 * Derived from {@link PHANTOMBOT_SERVICE_PATH} rather than restated, so a
 * future entry added to the service PATH cannot silently skip the transient
 * nightly unit and leave the sweep resolving binaries against a different
 * lookup path than every other phantombot unit.
 */
function nightlyUnitPath(home: string): string {
  return PHANTOMBOT_SERVICE_PATH.replaceAll("%h", home);
}

/** The bare `phantombot nightly` argv for this build (dev script vs binary). */
export function bareNightlyCommand(persona: string): {
  command: string;
  args: string[];
} {
  const entry = process.argv[1] ?? "";
  const dev = entry.endsWith(".ts") || entry.endsWith(".js");
  return {
    command: process.execPath,
    args: dev
      ? [entry, "nightly", "--persona", persona]
      : ["nightly", "--persona", persona],
  };
}

/**
 * Fire a `phantombot nightly` for the given persona so that it OUTLIVES its
 * caller.
 *
 * On systemd hosts the sweep is launched as a transient `--user` unit (see
 * {@link buildNightlyLaunch}); everywhere else it is a detached, unref'd child
 * as before — launchd and Windows do not kill it when the parent exits.
 *
 * The systemd path is launched SYNCHRONOUSLY on purpose. `systemd-run` returns
 * as soon as the start job is enqueued (tens of ms), but the caller here is a
 * heartbeat that exits immediately afterwards — spawning `systemd-run` itself
 * asynchronously would re-open the same race one level up, with the helper
 * killed before it had registered the unit.
 *
 * A failing `systemd-run` (old systemd without transient EnvironmentFile, no
 * user bus, a name collision) falls back to the bare detached child, which is
 * strictly what this function did before. The sweep is ledger-driven and
 * idempotent, so a duplicate launch is harmless.
 */
export function spawnNightlySweep(
  persona: string,
  reason: NightlyTriggerReason,
  env: NightlyHostEnv = detectNightlyHostEnv(),
): void {
  const bare = bareNightlyCommand(persona);
  const launch = buildNightlyLaunch(bare, persona, env);

  if (launch.transient) {
    try {
      const res = spawnSync(launch.command, launch.args, { stdio: "ignore" });
      if (!res.error && res.status === 0) {
        log.info("nightly: spawned sweep", {
          persona,
          reason,
          via: "systemd-run",
        });
        return;
      }
      log.warn("nightly: systemd-run failed, falling back to detached child", {
        persona,
        reason,
        status: res.status,
        error: res.error?.message,
      });
    } catch (e) {
      log.warn("nightly: systemd-run threw, falling back to detached child", {
        persona,
        reason,
        error: (e as Error).message,
      });
    }
  }

  try {
    const child = spawn(bare.command, bare.args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    log.info("nightly: spawned sweep", { persona, reason, via: "detached" });
  } catch (e) {
    log.warn("nightly: could not spawn sweep", {
      persona,
      reason,
      error: (e as Error).message,
    });
  }
}
