/**
 * `phantombot doctor` — memory-subsystem health check + auto-repair.
 *
 * Reads signals that already exist on disk and in `memory.sqlite`:
 *   - `.nightly-state.json`    — last run timestamp + status
 *   - `.nightly-progress.json` — an in-flight / partial checkpoint
 *   - `capture_log`            — was anything captured in the last 24h?
 *
 * It answers the three questions the issue author could only guess at:
 * did the last nightly run, did it succeed, and is capture actually
 * firing. When the nightly is stale, failed, or left a partial
 * checkpoint, doctor spawns `phantombot nightly --resume` as a detached
 * background process — which, thanks to the checkpointed nightly, picks
 * up exactly where the last run stopped.
 *
 * Invoked manually, from the startup catch-up in `run`, and safe to
 * wire into any mechanical scheduler (it never runs an LLM in-process —
 * repair is a detached child).
 */

import { spawn } from "node:child_process";
import { defineCommand } from "citty";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

import { type Config, loadConfig, personaDir } from "../config.ts";
import {
  checkConfiguredHarnesses,
  expandSystemdPath,
  missingHarnesses,
  resolvedHarnessBins,
  type HarnessAvailability,
} from "../lib/harnessAvailability.ts";
import type { WriteSink } from "../lib/io.ts";
import { log } from "../lib/logger.ts";
import {
  CATCHUP_WINDOW_MS,
  loadNightlyProgress,
  loadNightlyState,
  type NightlyProgress,
  type NightlyState,
} from "../lib/nightly.ts";
import { currentPlatform } from "../lib/platform.ts";
import { saveHarnessBins } from "../state.ts";
import {
  BunSystemctlRunner,
  buildSystemctlEnv,
  defaultUnitPath,
  driftedUnitNames,
  ensureSystemdUnitsCurrent,
  ensureUserSystemdEnv,
  HEARTBEAT_TIMER_NAME,
  heartbeatServicePath,
  heartbeatTimerPath,
  NIGHTLY_TIMER_NAME,
  nightlyServicePath,
  nightlyTimerPath,
  phantombotUnitTargets,
  PHANTOMBOT_SERVICE_PATH,
  type SystemctlRunner,
  TICK_TIMER_NAME,
  tickServicePath,
  tickTimerPath,
} from "../lib/systemd.ts";
import {
  HEARTBEAT_STALE_MINUTES,
  loadHeartbeatLastFired,
  loadTickLastFired,
  TICK_STALE_MINUTES,
  type TimerLastFired,
} from "../lib/timerHealth.ts";
import { openMemoryStore } from "../memory/store.ts";

/** Window for the capture-health check: a "dry day" is judged over 24h. */
const CAPTURE_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * Below this many real user turns in the window we don't flag a dry
 * day — a genuinely quiet day legitimately has nothing to capture.
 */
const DRY_DAY_TURN_THRESHOLD = 20;

export interface DoctorReport {
  persona: string;
  nightly: {
    last_run?: string;
    last_status?: string;
    /**
     * Error messages from the last run, if any. Persisted in
     * `.nightly-state.json` but historically dropped here, so a failing
     * stage was invisible to `doctor` (it only showed `last_status`).
     */
    errors?: string[];
    /** Hours since the last run, or null if it never ran. */
    age_hours: number | null;
    stale: boolean;
    /** A partial/in-progress checkpoint, if one is parked on disk. */
    checkpoint?: {
      date: string;
      status: NightlyProgress["status"];
      completed_stages: string[];
      last_error?: string;
    };
  };
  capture: {
    window_hours: number;
    user_turns: number;
    captures: number;
    /** Many user turns, zero captures — capture is likely not firing. */
    dry_day: boolean;
  };
  /**
   * Embeddings / semantic-search status. Purely INFORMATIONAL — this never
   * feeds `repair_needed` or the exit code. Embeddings are optional: with no
   * provider, memory search still works on keyword (FTS5/BM25) matching. We
   * surface the easy-to-miss "running keyword-only" state so an operator can
   * SEE that vector search is off (and how to turn it on) without it ever
   * looking like a fault.
   */
  embeddings: {
    provider: "gemini" | "none";
    /** gemini provider AND a key present = vector/semantic search is live. */
    semantic_search: boolean;
  };
  /**
   * Linux-only — undefined on macOS and dev hosts without a user-systemd
   * bus. When present, lists which unit files are missing from disk, which
   * present-but-stale unit files have drifted from the running binary's
   * templates, and which timers are not active right now. A healthy box
   * reports empty arrays for all three.
   */
  systemd?: {
    missing_unit_files: string[];
    /**
     * Unit files present on disk but whose content no longer matches the
     * running binary's templates — e.g. a pre-`OnCalendar` heartbeat timer
     * that an in-place `update` left behind because the post-swap heal
     * couldn't reach the systemd bus. Healed by the same re-render path as
     * missing files (and, for timers, restarted so the new schedule arms).
     */
    drifted_unit_files: string[];
    inactive_timers: string[];
    /** True when we re-rendered or re-armed at least one thing. */
    repaired: boolean;
  };
  /**
   * Heartbeat + tick "last fired" markers. Catches the long-uptime
   * failure mode where systemd reports timers as active but they're
   * not actually firing (bus drop, host suspend, runaway lockfile).
   * `stale` = age exceeds the per-timer threshold, OR no marker
   * exists at all. Undefined entries (e.g. `tick.last_fired` missing)
   * still flag stale=true so a freshly-installed-but-never-fired
   * timer is visible.
   */
  timers?: {
    heartbeat: {
      last_fired?: string;
      age_minutes?: number;
      stale: boolean;
      threshold_minutes: number;
    };
    tick: {
      last_fired?: string;
      age_minutes?: number;
      stale: boolean;
      threshold_minutes: number;
    };
  };
  /**
   * Configured harness binaries resolved from the service/runtime PATH.
   * Catches installs that work in an interactive shell but fail under the
   * daemon environment.
   */
  harnesses?: {
    path: string;
    checks: HarnessAvailability[];
  };
  repair_needed: boolean;
  repair_reason?: string;
  repair_triggered: boolean;
}

export interface RunDoctorInput {
  config?: Config;
  persona?: string;
  /** Spawn `nightly --resume` when repair is warranted. Default true. */
  repair?: boolean;
  /** Emit machine-readable JSON instead of the human summary. */
  json?: boolean;
  out?: WriteSink;
  err?: WriteSink;
  /** Test seam — override the repair spawn. */
  spawnRepair?: (persona: string) => void;
  /**
   * Test seam for the systemd check. Pass `false` to skip the check
   * (the default outside Linux). Pass a function to substitute a fake —
   * it receives the list of timer units whose last-fired markers are
   * stale (so the heal step can force-re-arm a zombie timer that systemd
   * still reports as active) and returns the systemd report. In
   * production this is undefined and doctor uses the real systemctl.
   */
  checkSystemd?:
    | false
    | ((staleTimers: string[]) => Promise<DoctorReport["systemd"] | undefined>);
  /**
   * Test seam for the timer-fired marker check. Pass `false` to skip
   * (used by tests that don't care about staleness). Pass a function
   * to substitute fake marker reads. In production this is undefined
   * and doctor reads the real marker files from XDG_STATE_HOME.
   */
  checkTimers?:
    | false
    | (() => Promise<DoctorReport["timers"] | undefined>);
  /**
   * Test seam for harness binary availability. Pass false to skip. In
   * production, doctor checks the installed service PATH when running as the
   * real phantombot binary.
   */
  checkHarnesses?:
    | false
    | (() => Promise<DoctorReport["harnesses"] | undefined>);
}

function decideRepair(
  state: NightlyState,
  progress: NightlyProgress | null,
  ageHours: number | null,
): { needed: boolean; reason?: string } {
  if (progress && progress.status !== "complete") {
    return {
      needed: true,
      reason:
        `partial nightly checkpoint for ${progress.date} ` +
        `(${progress.completed_stages.length} stage(s) done` +
        (progress.last_error ? `; last error: ${progress.last_error}` : "") +
        ")",
    };
  }
  if (!state.last_run || ageHours === null) {
    return { needed: true, reason: "no record of any nightly run" };
  }
  if (state.last_status === "error" || state.last_status === "partial") {
    return {
      needed: true,
      reason: `last nightly status was '${state.last_status}'`,
    };
  }
  if (ageHours * 3_600_000 > CATCHUP_WINDOW_MS) {
    return {
      needed: true,
      reason: `last nightly ran ${Math.round(ageHours)}h ago (>${
        CATCHUP_WINDOW_MS / 3_600_000
      }h)`,
    };
  }
  return { needed: false };
}

/** Spawn a detached `phantombot nightly --resume` that outlives this process. */
function defaultSpawnRepair(persona: string): void {
  const entry = process.argv[1] ?? "";
  const dev = entry.endsWith(".ts") || entry.endsWith(".js");
  const args = dev
    ? [entry, "nightly", "--resume", "--persona", persona]
    : ["nightly", "--resume", "--persona", persona];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  log.info("doctor: spawned background nightly --resume", { persona });
}

export async function runDoctor(input: RunDoctorInput = {}): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const repair = input.repair ?? true;

  const config = input.config ?? (await loadConfig());
  const persona = input.persona ?? config.defaultPersona;
  const dir = personaDir(config, persona);
  if (!existsSync(dir)) {
    err.write(`persona '${persona}' not found at ${dir}\n`);
    return 2;
  }

  const state = await loadNightlyState(dir);
  const progress = await loadNightlyProgress(dir);

  const lastRunMs = state.last_run ? Date.parse(state.last_run) : NaN;
  const ageHours = Number.isNaN(lastRunMs)
    ? null
    : (Date.now() - lastRunMs) / 3_600_000;

  // Capture health — compare real user turns vs captures over 24h.
  const since = new Date(Date.now() - CAPTURE_WINDOW_MS).toISOString();
  const memory = await openMemoryStore(config.memoryDbPath);
  let userTurns = 0;
  let captures = 0;
  try {
    userTurns = await memory.countUserTurnsForPersonaSince(
      persona,
      "telegram:",
      since,
    );
    captures = await memory.countCapturesSince(persona, since);
  } finally {
    await memory.close();
  }
  const dryDay = userTurns >= DRY_DAY_TURN_THRESHOLD && captures === 0;

  // Embeddings status — informational only. Vector search is live only when
  // the provider is gemini AND a key is actually present; everything else
  // (provider "none", or "gemini" with an empty key) means keyword-only.
  const embProvider = config.embeddings.provider;
  const semanticSearch =
    embProvider === "gemini" && !!config.embeddings.gemini?.apiKey;

  const { needed, reason } = decideRepair(state, progress, ageHours);

  let repairTriggered = false;
  if (needed && repair) {
    (input.spawnRepair ?? defaultSpawnRepair)(persona);
    repairTriggered = true;
  }

  // Timer "last fired" check — catches the long-uptime failure mode
  // where systemd thinks a timer is active but it hasn't fired in
  // hours. is-active says "active", LastTriggerUSec says "n/a", and
  // the only ground-truth signal is what tick + heartbeat actually
  // wrote to disk the last time they ran. Computed BEFORE the systemd
  // check so a stale marker can drive a forced re-arm of the zombie
  // timer below.
  let timersReport: DoctorReport["timers"] | undefined;
  if (input.checkTimers !== false) {
    if (input.checkTimers) {
      timersReport = await input.checkTimers();
    } else {
      timersReport = computeTimersReport();
    }
  }

  // Map any "fired before, then went stale" marker to its timer unit.
  // These are the `active (elapsed)` zombies that is-active can't see —
  // the heal step restarts them to force a reschedule. We deliberately
  // require last_fired to be present: a missing marker (never fired) is
  // a fresh install whose first fire is imminent, and is already covered
  // by the missing-file / inactive-timer checks. Nightly has no marker,
  // so only heartbeat + tick can be re-armed this way.
  const staleTimerUnits: string[] = [];
  if (timersReport) {
    if (
      timersReport.heartbeat.stale &&
      timersReport.heartbeat.last_fired !== undefined
    ) {
      staleTimerUnits.push(HEARTBEAT_TIMER_NAME);
    }
    if (
      timersReport.tick.stale &&
      timersReport.tick.last_fired !== undefined
    ) {
      staleTimerUnits.push(TICK_TIMER_NAME);
    }
  }

  // systemd health (Linux only) — catches the broken-symlink class of
  // bug where timers look enabled but never fire, plus the zombie timers
  // surfaced by staleTimerUnits above. Skipped on macOS, skipped in
  // tests via checkSystemd: false.
  let systemdReport: DoctorReport["systemd"] | undefined;
  if (input.checkSystemd !== false) {
    if (input.checkSystemd) {
      systemdReport = await input.checkSystemd(staleTimerUnits);
    } else if (currentPlatform() === "linux") {
      systemdReport = await defaultCheckSystemd(repair, staleTimerUnits);
    }
  }

  let harnessReport: DoctorReport["harnesses"] | undefined;
  if (input.checkHarnesses !== false) {
    if (input.checkHarnesses) {
      harnessReport = await input.checkHarnesses();
    } else {
      harnessReport = await computeHarnessReport(config);
    }
    if (repair && harnessReport) {
      await saveHarnessBins(resolvedHarnessBins(harnessReport.checks));
    }
  }

  const report: DoctorReport = {
    persona,
    nightly: {
      last_run: state.last_run,
      last_status: state.last_status,
      ...(state.errors && state.errors.length > 0
        ? { errors: state.errors }
        : {}),
      age_hours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
      stale: needed,
      ...(progress
        ? {
            checkpoint: {
              date: progress.date,
              status: progress.status,
              completed_stages: progress.completed_stages,
              ...(progress.last_error
                ? { last_error: progress.last_error }
                : {}),
            },
          }
        : {}),
    },
    capture: {
      window_hours: CAPTURE_WINDOW_MS / 3_600_000,
      user_turns: userTurns,
      captures,
      dry_day: dryDay,
    },
    embeddings: {
      provider: embProvider,
      semantic_search: semanticSearch,
    },
    ...(systemdReport ? { systemd: systemdReport } : {}),
    ...(timersReport ? { timers: timersReport } : {}),
    ...(harnessReport ? { harnesses: harnessReport } : {}),
    repair_needed: needed,
    repair_reason: reason,
    repair_triggered: repairTriggered,
  };

  const systemdBroken =
    !!systemdReport &&
    !systemdReport.repaired &&
    (systemdReport.missing_unit_files.length > 0 ||
      systemdReport.drifted_unit_files.length > 0 ||
      systemdReport.inactive_timers.length > 0);
  const timersBroken =
    !!timersReport &&
    (timersReport.heartbeat.stale || timersReport.tick.stale);
  const harnessesBroken =
    !!harnessReport && missingHarnesses(harnessReport.checks).length > 0;
  const exitCode =
    needed && !repairTriggered
      ? 1
      : systemdBroken
        ? 1
        : timersBroken
          ? 1
          : harnessesBroken
            ? 1
            : 0;

  if (input.json) {
    out.write(JSON.stringify(report, null, 2) + "\n");
    return exitCode;
  }

  // Human summary.
  const tick = (ok: boolean) => (ok ? "ok" : "WARN");
  out.write(`phantombot doctor — persona '${persona}'\n`);
  // A non-ok status is a warning even when the run isn't stale: a stage
  // can fail today yet still be "recent", which previously slipped past
  // the staleness-only marker.
  const statusBad =
    state.last_status === "error" || state.last_status === "partial";
  out.write(
    `  nightly: ${tick(!needed && !statusBad)} — ` +
      (state.last_run
        ? `last run ${state.last_run} (${report.nightly.age_hours}h ago), status '${
            state.last_status ?? "unknown"
          }'`
        : "never run") +
      "\n",
  );
  if (state.errors && state.errors.length > 0) {
    for (const e of state.errors) {
      out.write(`    error: ${e}\n`);
    }
  }
  if (progress) {
    out.write(
      `  checkpoint: ${progress.status} for ${progress.date} — ` +
        `done [${progress.completed_stages.join(", ") || "none"}]` +
        (progress.last_error ? ` — ${progress.last_error}` : "") +
        "\n",
    );
  }
  out.write(
    `  capture: ${tick(!dryDay)} — ${captures} capture(s), ${userTurns} ` +
      `user turn(s) in the last ${report.capture.window_hours}h` +
      (dryDay ? " — DRY DAY: turns but no captures" : "") +
      "\n",
  );
  // Embeddings line is deliberately neutral — no ok/WARN marker, never an
  // exit-code input. Vector search is an optional enhancement, not a
  // requirement; absence is a valid, fully-working configuration.
  out.write(
    semanticSearch
      ? `  embeddings: semantic (vector) search ON — provider '${embProvider}'\n`
      : "  embeddings: semantic (vector) search off — keyword (BM25) search " +
        "active. Optional: enable with `phantombot embedding`\n",
  );
  if (needed) {
    out.write(`  repair: ${reason}\n`);
    out.write(
      repairTriggered
        ? "  → spawned background `nightly --resume`\n"
        : "  → run `phantombot nightly --resume` to repair\n",
    );
  } else {
    out.write("  repair: not needed\n");
  }

  if (systemdReport) {
    const sdOk =
      systemdReport.missing_unit_files.length === 0 &&
      systemdReport.drifted_unit_files.length === 0 &&
      systemdReport.inactive_timers.length === 0;
    out.write(`  systemd: ${tick(sdOk)} — `);
    if (sdOk) {
      out.write("all unit files present and current, all timers active");
      // A pure zombie re-arm (timer was active but had stopped firing)
      // leaves missing/drifted/inactive empty yet repaired=true — call it
      // out so the operator knows a stalled timer was restarted.
      out.write(systemdReport.repaired ? " (re-armed a stalled timer)\n" : "\n");
    } else {
      const bits: string[] = [];
      if (systemdReport.missing_unit_files.length > 0) {
        bits.push(`missing: ${systemdReport.missing_unit_files.join(", ")}`);
      }
      if (systemdReport.drifted_unit_files.length > 0) {
        bits.push(`drifted: ${systemdReport.drifted_unit_files.join(", ")}`);
      }
      if (systemdReport.inactive_timers.length > 0) {
        bits.push(`inactive: ${systemdReport.inactive_timers.join(", ")}`);
      }
      out.write(bits.join("; ") + "\n");
      out.write(
        systemdReport.repaired
          ? "  → re-rendered units and re-armed timers (no restart needed)\n"
          : "  → run `phantombot install` to repair\n",
      );
    }
  }

  if (timersReport) {
    const renderTimer = (
      label: string,
      t: NonNullable<DoctorReport["timers"]>["heartbeat"],
    ): void => {
      out.write(`  ${label}: ${tick(!t.stale)} — `);
      if (t.last_fired === undefined) {
        out.write(
          `never recorded (threshold ${t.threshold_minutes}m) — ` +
            "timer may not be installed or has not fired since the marker was added\n",
        );
      } else {
        out.write(
          `last fired ${t.last_fired} (${t.age_minutes}m ago, ` +
            `threshold ${t.threshold_minutes}m)` +
            (t.stale ? " — STALE\n" : "\n"),
        );
      }
    };
    renderTimer("heartbeat", timersReport.heartbeat);
    renderTimer("tick", timersReport.tick);
  }

  if (harnessReport) {
    const missing = missingHarnesses(harnessReport.checks);
    out.write(`  harnesses: ${tick(missing.length === 0)} — `);
    if (missing.length === 0) {
      out.write(
        harnessReport.checks
          .map((h) => `${h.id}: ${h.resolved}`)
          .join("; ") + "\n",
      );
    } else {
      out.write(
        missing.map((h) => `${h.id}: '${h.bin}' not found`).join("; ") +
          "\n" +
          "  → fix the harness install, set PHANTOMBOT_<HARNESS>_BIN to an absolute path, or put a stable shim on the service PATH\n",
      );
    }
  }

  return exitCode;
}

async function computeHarnessReport(
  config: Config,
): Promise<DoctorReport["harnesses"] | undefined> {
  if (basename(process.execPath) !== "phantombot") return undefined;
  const path =
    currentPlatform() === "linux"
      ? expandSystemdPath(PHANTOMBOT_SERVICE_PATH)
      : (process.env.PATH ?? "");
  return {
    path,
    checks: await checkConfiguredHarnesses(config, path),
  };
}

/**
 * Production wiring for the systemd-health check. Returns undefined on
 * hosts where the user-systemd bus isn't reachable (no linger, or
 * running from a SSH session without DBUS) — doctor just stays silent
 * about systemd in that case rather than printing a misleading WARN.
 *
 * When `repair` is true, missing unit files or inactive timers are
 * fixed in-place via ensureSystemdUnitsCurrent. The report's `repaired`
 * flag tells callers whether the issues were healed or still need
 * attention. Read-only mode (`--no-repair`) just inspects and reports.
 */
async function defaultCheckSystemd(
  repair: boolean,
  staleTimers: string[] = [],
): Promise<DoctorReport["systemd"] | undefined> {
  const sysEnv = ensureUserSystemdEnv();
  if (!sysEnv.ready) return undefined;
  const binPath = process.execPath;
  if (basename(binPath) !== "phantombot") return undefined;
  const systemctl = new BunSystemctlRunner(buildSystemctlEnv(sysEnv));
  const expectedFiles: Array<{ path: string; name: string }> = [
    { path: defaultUnitPath(), name: basename(defaultUnitPath()) },
    {
      path: heartbeatServicePath(),
      name: basename(heartbeatServicePath()),
    },
    { path: heartbeatTimerPath(), name: basename(heartbeatTimerPath()) },
    { path: nightlyServicePath(), name: basename(nightlyServicePath()) },
    { path: nightlyTimerPath(), name: basename(nightlyTimerPath()) },
    { path: tickServicePath(), name: basename(tickServicePath()) },
    { path: tickTimerPath(), name: basename(tickTimerPath()) },
  ];
  const missing = expectedFiles
    .filter((f) => !existsSync(f.path))
    .map((f) => f.name);
  // Detect content drift: a unit file that exists but no longer matches the
  // running binary's template. This is the gap that let the wedge-prone
  // pre-OnCalendar heartbeat timer hide in plain sight — it was present and
  // "active", so missing/inactive both stayed empty and doctor reported
  // "ok". Comparing on-disk bytes against `phantombotUnitTargets` is the
  // only way to see it.
  const drifted = driftedUnitNames(phantombotUnitTargets(binPath), (p) =>
    existsSync(p) ? readFileSync(p, "utf8") : undefined,
  );
  const inactive = await listInactiveTimers(systemctl);
  let repaired = false;
  if (
    repair &&
    (missing.length > 0 ||
      drifted.length > 0 ||
      inactive.length > 0 ||
      staleTimers.length > 0)
  ) {
    try {
      const heal = await ensureSystemdUnitsCurrent({
        binPath,
        systemctl,
        forceRearmTimers: staleTimers,
      });
      repaired =
        heal.rewrote.length > 0 || heal.repairedTimers.length > 0;
    } catch (e) {
      log.warn("doctor: systemd heal failed", {
        error: (e as Error).message,
      });
    }
  }
  return {
    missing_unit_files: missing,
    drifted_unit_files: drifted,
    inactive_timers: inactive,
    repaired,
  };
}

/**
 * Build the timers report from the on-disk marker files. A missing
 * marker still flags stale=true — that's the "fresh install, hasn't
 * fired yet" case AND the "marker was deleted somehow" case, both of
 * which the operator should see.
 *
 * Returns undefined when we're not running as the real phantombot
 * binary (e.g. `bun test`, `bun run` during development). Mirrors the
 * same gate `defaultCheckSystemd` uses so the check stays inert in
 * dev contexts and tests don't need to clean up marker files.
 */
function computeTimersReport(): DoctorReport["timers"] | undefined {
  if (basename(process.execPath) !== "phantombot") return undefined;
  const now = new Date();
  const heartbeat = loadHeartbeatLastFired(now);
  const tickFired = loadTickLastFired(now);
  return {
    heartbeat: timerSection(heartbeat, HEARTBEAT_STALE_MINUTES),
    tick: timerSection(tickFired, TICK_STALE_MINUTES),
  };
}

function timerSection(
  m: TimerLastFired,
  thresholdMinutes: number,
): NonNullable<DoctorReport["timers"]>["heartbeat"] {
  const stale =
    m.ageMinutes === undefined ? true : m.ageMinutes > thresholdMinutes;
  return {
    ...(m.iso !== undefined ? { last_fired: m.iso } : {}),
    ...(m.ageMinutes !== undefined ? { age_minutes: m.ageMinutes } : {}),
    stale,
    threshold_minutes: thresholdMinutes,
  };
}

async function listInactiveTimers(
  systemctl: SystemctlRunner,
): Promise<string[]> {
  const out: string[] = [];
  for (const t of [
    HEARTBEAT_TIMER_NAME,
    NIGHTLY_TIMER_NAME,
    TICK_TIMER_NAME,
  ]) {
    const r = await systemctl.run(["--user", "is-active", t]);
    if (r.exitCode !== 0 || r.stdout.trim() !== "active") {
      out.push(t);
    }
  }
  return out;
}

export default defineCommand({
  meta: {
    name: "doctor",
    description:
      "Memory health check — reports nightly/capture status and auto-repairs a stale or partial nightly by resuming it in the background.",
  },
  args: {
    persona: {
      type: "string",
      description: "Persona name (default: configured default).",
    },
    repair: {
      type: "boolean",
      description:
        "Spawn a background `nightly --resume` when repair is warranted. " +
        "Pass --no-repair to only report.",
      default: true,
    },
    json: {
      type: "boolean",
      description: "Emit the report as JSON (for schedulers / scripts).",
      default: false,
    },
  },
  async run({ args }) {
    process.exitCode = await runDoctor({
      persona: args.persona ? String(args.persona) : undefined,
      repair: args.repair !== false,
      json: Boolean(args.json),
    });
  },
});
