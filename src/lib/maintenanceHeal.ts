/**
 * Host maintenance self-heal, reachable from paths that do NOT depend on the
 * scheduled maintenance job still being alive (#510).
 *
 * Background: the per-persona maintenance migration (#486/#490/#494) was
 * performed by the HEARTBEAT — the very job it re-arms — plus `install` and
 * the persona-lifecycle sync. Self-update swaps the binary only, so on a host
 * whose scheduled heartbeat died before the healing code ran there was nothing
 * left to re-arm it. Host `matt` sat 41h stale behind a launchd exit-78 job
 * while the daemon itself was healthy, and only a hand-run `phantombot
 * heartbeat` recovered it.
 *
 * The cure is to run the same idempotent heal from two independent places:
 *
 *   - `phantombot run` (daemon start) — a different process lifecycle
 *     entirely, so a dead scheduler cannot suppress it;
 *   - `phantombot tick` — a SEPARATE scheduled job (its own launchd plist /
 *     systemd timer), so heartbeat and tick have to fail together before the
 *     host goes unmaintained.
 *
 * Tick fires every minute, so the tick path is gated twice: it only heals when
 * a served persona's heartbeat marker is actually stale, and then at most once
 * per {@link TICK_HEAL_MIN_INTERVAL_MINUTES} so a host that cannot be repaired
 * doesn't spend a launchctl/systemctl round trip (and a log line) every minute.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { type Config, servedPersonasOf, xdgStateHome } from "../config.ts";
import { isPhantombotBinary } from "./binaryIdentity.ts";
import {
  BunLaunchctlRunner,
  ensureLaunchdHeartbeatInstances,
  guiDomain,
} from "./launchd.ts";
import { log } from "./logger.ts";
import { currentPlatform } from "./platform.ts";
import {
  BunSystemctlRunner,
  buildSystemctlEnv,
  ensureSystemdUnitsCurrent,
  ensureUserSystemdEnv,
} from "./systemd.ts";
import { BunSchtasksRunner, ensureTasksCurrent } from "./taskScheduler.ts";
import {
  HEARTBEAT_STALE_MINUTES,
  loadPersonaHeartbeatLastFired,
} from "./timerHealth.ts";

/** Where a heal was triggered from — carried into the log line so a repair
 *  found in the logs names the path that saved the host. */
export type MaintenanceHealSource = "heartbeat" | "start" | "tick";

/**
 * Production self-heal, dispatched to the host's service-manager backend.
 * Silent on healthy boxes; logs a notice only on repair. A no-op on any
 * platform without a backend.
 */
export async function healMaintenanceUnits(
  config: Config,
  opts: { persona?: string; source: MaintenanceHealSource },
): Promise<void> {
  switch (currentPlatform()) {
    case "linux":
      return healSystemd(config, opts.source);
    case "darwin":
      return healLaunchd(config, opts.source);
    case "windows":
      return healTaskScheduler(opts.persona, opts.source);
    default:
      return; // unsupported hosts
  }
}

/**
 * macOS analogue of {@link healSystemd} (#491): reconcile one per-persona
 * heartbeat plist per served persona, bootout plists of personas no longer
 * served, retire the legacy single-persona heartbeat once its replacement is
 * loaded, and retire the dead nightly plist (#510). Idempotent; silent when
 * nothing drifted.
 */
async function healLaunchd(
  config: Config,
  source: MaintenanceHealSource,
): Promise<void> {
  const binPath = process.execPath;
  if (!isPhantombotBinary(binPath)) return;
  let domain: string;
  try {
    domain = guiDomain();
  } catch {
    return;
  }
  const r = await ensureLaunchdHeartbeatInstances({
    binPath,
    personas: servedPersonasOf(config),
    domain,
    launchctl: new BunLaunchctlRunner(),
  });
  if (
    r.rewrote.length > 0 ||
    r.bootstrapped.length > 0 ||
    r.removed.length > 0 ||
    r.retiredLegacy ||
    r.retiredNightly ||
    r.reloadFailed.length > 0 ||
    r.removeFailed.length > 0
  ) {
    log.info("maintenance heal: healed launchd heartbeat plists", {
      source,
      rewrote: r.rewrote,
      bootstrapped: r.bootstrapped,
      removed: r.removed,
      retiredLegacy: r.retiredLegacy,
      retiredNightly: r.retiredNightly,
      reloadFailed: r.reloadFailed,
      removeFailed: r.removeFailed,
    });
  }
}

/**
 * Idempotently ensure all phantombot systemd units are present and timers are
 * armed — including one heartbeat instance per served persona (#486). Skips on
 * Linux hosts where the user-systemd bus isn't reachable (e.g. SSH without
 * lingering).
 */
async function healSystemd(
  config: Config,
  source: MaintenanceHealSource,
): Promise<void> {
  const binPath = process.execPath;
  if (!isPhantombotBinary(binPath)) return;
  const sysEnv = ensureUserSystemdEnv();
  if (!sysEnv.ready) return;
  const systemctl = new BunSystemctlRunner(buildSystemctlEnv(sysEnv));
  const r = await ensureSystemdUnitsCurrent({
    binPath,
    systemctl,
    personas: servedPersonasOf(config),
  });
  if (
    r.rewrote.length > 0 ||
    r.repairedTimers.length > 0 ||
    r.disabledInstances.length > 0
  ) {
    log.info("maintenance heal: healed systemd units", {
      source,
      rewrote: r.rewrote,
      repairedTimers: r.repairedTimers,
      disabledInstances: r.disabledInstances,
    });
  }
}

/**
 * Windows analogue of {@link healSystemd}: re-register any of the four
 * scheduled tasks that drifted from the current binary path (the moved- or
 * updated-binary case). Only fires when we ARE the compiled binary
 * (`phantombot.exe`), so a dev `bun src/index.ts` run never rewrites tasks.
 */
async function healTaskScheduler(
  persona: string | undefined,
  source: MaintenanceHealSource,
): Promise<void> {
  const binPath = process.execPath;
  if (!isPhantombotBinary(binPath)) return;
  const r = await ensureTasksCurrent({
    binPath,
    persona,
    schtasks: new BunSchtasksRunner(),
  });
  if (r.rewrote.length > 0) {
    log.info("maintenance heal: healed scheduled tasks", {
      source,
      rewrote: r.rewrote,
    });
  }
}

/**
 * Served personas whose heartbeat has not fired inside the staleness bar.
 * A MISSING marker counts as stale: on a host where a per-persona instance
 * never bootstrapped at all, no marker is ever written, and treating that as
 * healthy is exactly the blind spot #510 is about. The heal is idempotent and
 * rate-limited by {@link shouldAttemptTickHeal}, so the cost of being wrong
 * here is one reconcile pass every quarter hour.
 */
export function staleMaintenancePersonas(
  config: Config,
  now: Date = new Date(),
): string[] {
  const personas = servedPersonasOf(config);
  const defaultPersona = personas[0];
  const stale: string[] = [];
  for (const persona of personas) {
    const m = loadPersonaHeartbeatLastFired(persona, {
      isDefault: persona === defaultPersona,
      now,
    });
    if (m.ageMinutes === undefined || m.ageMinutes > HEARTBEAT_STALE_MINUTES) {
      stale.push(persona);
    }
  }
  return stale;
}

/**
 * Minimum gap between two tick-driven heals. Tick fires every minute; the
 * heal costs a `print` + possible `bootout`/`bootstrap` per served persona,
 * and on a host it cannot repair it would otherwise log on every fire.
 * Fifteen minutes still gets a dead scheduler back inside half an hour.
 */
export const TICK_HEAL_MIN_INTERVAL_MINUTES = 15;

function tickHealMarkerPath(): string {
  return join(xdgStateHome(), "phantombot", "maintenance-heal.last-attempt");
}

/**
 * Read the last tick-heal attempt time. Returns undefined when no attempt has
 * been recorded (or the marker is unreadable) — i.e. "go ahead".
 */
function lastTickHealAttempt(path: string): Date | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const t = Date.parse(readFileSync(path, "utf8").trim());
    if (Number.isNaN(t)) return undefined;
    return new Date(t);
  } catch {
    return undefined;
  }
}

/**
 * Whether tick should run the heal this minute: only when some served persona
 * is stale, and only once per {@link TICK_HEAL_MIN_INTERVAL_MINUTES}. Records
 * the attempt when it answers true, so callers do not have to.
 *
 * A clock that steps BACKWARD would make the recorded attempt look like it is
 * in the future; that is treated as "too soon" rather than as a licence to
 * heal every minute, and self-corrects once wall-clock passes the marker.
 */
export async function shouldAttemptTickHeal(
  config: Config,
  opts: { now?: Date; markerPath?: string } = {},
): Promise<{ heal: boolean; stale: string[] }> {
  const now = opts.now ?? new Date();
  const stale = staleMaintenancePersonas(config, now);
  if (stale.length === 0) return { heal: false, stale };
  const path = opts.markerPath ?? tickHealMarkerPath();
  const last = lastTickHealAttempt(path);
  if (last !== undefined) {
    const ageMinutes = (now.getTime() - last.getTime()) / 60_000;
    if (ageMinutes < TICK_HEAL_MIN_INTERVAL_MINUTES) return { heal: false, stale };
  }
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${now.toISOString()}\n`, "utf8");
  } catch (e) {
    // Best-effort: a marker we cannot write means we heal again next minute,
    // which is noisier than intended but never worse than not healing.
    log.warn("maintenance heal: failed to record tick-heal attempt", {
      path,
      error: (e as Error).message,
    });
  }
  return { heal: true, stale };
}

/**
 * The tick path end to end (#510): gate on being the installed binary, on a
 * served persona actually being stale, and on the throttle — then heal.
 *
 * Lives here rather than inline in `tick.ts` so the GATES are testable, not
 * just the seam: a test can inject the clock, the marker and the heal itself
 * and assert that a healthy host does nothing while a stale one repairs once.
 *
 * The stale finding is logged at warn even though the repair is routine: this
 * is the signal that a scheduled maintenance job stopped firing, which until
 * now was visible only to someone running `doctor` on that host.
 */
export async function healStaleMaintenanceFromTick(
  config: Config,
  opts: {
    now?: Date;
    markerPath?: string;
    /** Test seam: substitute the service-manager heal. */
    heal?: (personas: readonly string[]) => Promise<void>;
    /** Test seam: substitute the installed-binary gate. */
    isInstalled?: () => boolean;
  } = {},
): Promise<{ healed: boolean; stale: string[] }> {
  const installed = opts.isInstalled ?? (() => isPhantombotBinary());
  // Never re-arm a real host's units from a dev `bun src/index.ts` run.
  if (!installed()) return { healed: false, stale: [] };
  const { heal, stale } = await shouldAttemptTickHeal(config, {
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.markerPath ? { markerPath: opts.markerPath } : {}),
  });
  if (!heal) return { healed: false, stale };
  log.warn("tick: maintenance stale, running self-heal", { stale });
  if (opts.heal) await opts.heal(stale);
  else
    await healMaintenanceUnits(config, {
      persona: config.defaultPersona,
      source: "tick",
    });
  return { healed: true, stale };
}
