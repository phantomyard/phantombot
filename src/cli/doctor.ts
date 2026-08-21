/**
 * `phantombot doctor` — memory-subsystem health check + auto-repair.
 *
 * Reads signals that already exist on disk and in `memory.sqlite`:
 *   - `.nightly-state.json` — the sweep ledger: which dates are distilled,
 *     which are pending, and whether a sweep is in flight right now
 *   - `capture_log`         — was anything captured in the last 24h?
 *
 * The nightly section is READ-ONLY. Doctor used to spawn its own
 * `nightly --resume` when the last run looked stale, which meant two owners
 * for the same job. The nightly is now idempotent — every run sweeps whatever
 * is unprocessed — so the sweep owns itself, triggered by day rollover from
 * the heartbeat and by `run` at startup, and doctor just reports the ledger.
 *
 * Invoked manually, at startup from `run`, and safe to wire into any
 * mechanical scheduler — it never runs an LLM.
 */

import { defineCommand } from "citty";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

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
  loadNightlyState,
  type NightlyHealth,
  nightlyHealth,
} from "../lib/nightly.ts";
import {
  ensureRoutingExtension,
  removeRoutingExtension,
  routingExtensionStatus,
} from "../lib/piExtensionProvision.ts";
import { isPhantombotBinary } from "../lib/binaryIdentity.ts";
import { currentPlatform } from "../lib/platform.ts";
import {
  editorConnectorBroken,
  reconcileEditorConnectors,
  type EditorConnectorResult,
} from "../connectors/acp/autoInstall.ts";
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
import { checkIntegrity, listRestorePoints } from "../memory/dbBackup.ts";
import { DRAWER_KINDS } from "../memory/drawers.ts";
import { drawerPath } from "../memory/drawerIngest.ts";

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
     * Error messages from the last sweep, if any. Persisted in
     * `.nightly-state.json` but historically dropped here, so a failing
     * stage was invisible to `doctor` (it only showed `last_status`).
     */
    errors?: string[];
    /** Hours since the last sweep, or null if it never ran. */
    age_hours: number | null;
    /**
     * Ledger-derived health: ok / running / warning / error. Backlog is the
     * only truth here — a missed 02:00 with nothing pending is still `ok`.
     */
    health: NightlyHealth["status"];
    detail: string;
    /** Daily files still awaiting a pass. */
    backlog: number;
    oldest_pending?: string;
  };
  /**
   * The memory DATABASE itself (#417). Since the drawers stopped being
   * markdown files, `memory.sqlite` holds memory that exists nowhere else on
   * disk, so "is it readable, and what could I restore from" became a health
   * question rather than an implementation detail.
   */
  memory_db: {
    path: string;
    /** `PRAGMA integrity_check` verdict on the live database. */
    healthy: boolean;
    detail: string;
    bytes: number;
    /** Verified snapshots available, newest first. */
    restore_points: Array<{ taken_at: string; bytes: number; path: string }>;
    /** Newest restore point that passes its own integrity check. */
    newest_good?: string;
    /** Drawer files still on disk because retirement held them back. */
    unretired_drawers: string[];
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
   * feeds the exit code. Embeddings are optional: with no
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
  /**
   * Managed Pi capability-routing extension. `shouldExist` = a routable
   * capability (image and/or coding model) is configured, so the owned dir is
   * supposed to be on disk; when false the desired state is absence.
   * `present` = the owned dir + marker exist; `drifted` = on-disk state no
   * longer matches desired (needs a re-stamp when shouldExist, or removal when
   * not). `repaired` = we stamped or removed it this run.
   */
  piExtension?: {
    shouldExist: boolean;
    present: boolean;
    drifted: boolean;
    dir: string;
    repaired?: boolean;
  };
  /**
   * ACP editor registrations (Zed via a settings.json merge; VS Code via its
   * bundled first-party extension installed through the `code` CLI). One entry
   * per supported editor: `not-detected` (editor not installed), `current`
   * (already registered/current), `registered`/`updated` (reconciled this run),
   * `stale` (needs work but --no-repair so nothing written), `error` (e.g.
   * unparseable settings, or `code --install-extension` failed). Gated to
   * the real `phantombot` binary so dev/test never writes the dev box's editor
   * settings.
   */
  editorConnectors?: EditorConnectorResult[];
}

export interface RunDoctorInput {
  config?: Config;
  persona?: string;
  /**
   * Perform the repairs doctor still owns (systemd units/timers, the managed
   * Pi extension, editor connectors). Default true. The nightly is NOT among
   * them any more — it repairs itself by sweeping.
   */
  repair?: boolean;
  /** Emit machine-readable JSON instead of the human summary. */
  json?: boolean;
  out?: WriteSink;
  err?: WriteSink;
  /** Test seam — override the nightly health read. */
  nightlyHealth?: typeof nightlyHealth;
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
  /**
   * Test seam for the managed Pi capability-routing extension check. Pass
   * `false` to skip. Pass a function to substitute a fake report (bypassing
   * the binary gate and the filesystem stamp/remove). In production this is
   * undefined and doctor inspects the real `~/.pi/agent/extensions` dir.
   */
  checkPiExtension?:
    | false
    | (() => Promise<DoctorReport["piExtension"] | undefined>);
  /**
   * Test seam for the ACP editor-connector reconcile. Pass `false` to skip.
   * Pass a function (it receives whether repair is enabled) to substitute a
   * fake report, bypassing the binary gate and any real settings writes. In
   * production this is undefined and doctor reconciles the real editor settings
   * (writing when repair is on, reporting only when --no-repair).
   */
  checkEditorConnectors?:
    | false
    | ((repair: boolean) => DoctorReport["editorConnectors"]);
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
  const health = await (input.nightlyHealth ?? nightlyHealth)(dir, { state });

  const lastRunMs = state.last_run ? Date.parse(state.last_run) : NaN;
  const ageHours = Number.isNaN(lastRunMs)
    ? null
    : (Date.now() - lastRunMs) / 3_600_000;

  // Memory database integrity FIRST, before anything opens it. `doctor` used
  // to open the store unguarded here and die with a raw SQLiteError on a
  // corrupt file — the one condition it most needs to report, and the only
  // check that can tell the operator which restore point to use.
  // A database that does not exist yet is NOT a fault: phantombot creates it
  // on first use, so a box installed this afternoon has none, and reporting
  // that as broken would teach an operator to ignore this line.
  const dbPresent = existsSync(config.memoryDbPath);
  const dbHealth = dbPresent
    ? checkIntegrity(config.memoryDbPath)
    : { ok: true, detail: "not created yet" };

  // Capture health — compare real user turns vs captures over 24h. Skipped
  // when the database is unhealthy: the counts would be meaningless and the
  // open would throw over the top of the fault we are here to print.
  const since = new Date(Date.now() - CAPTURE_WINDOW_MS).toISOString();
  let userTurns = 0;
  let captures = 0;
  if (dbHealth.ok) {
    // Opens (and, on a fresh box, creates) the database — the pre-#417
    // behaviour, kept for every case except the corrupt one.
    const memory = await openMemoryStore(config.memoryDbPath);
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
  }
  const dryDay = userTurns >= DRY_DAY_TURN_THRESHOLD && captures === 0;

  // Embeddings status — informational only. Vector search is live only when
  // the provider is gemini AND a key is actually present; everything else
  // (provider "none", or "gemini" with an empty key) means keyword-only.
  const embProvider = config.embeddings.provider;
  const semanticSearch =
    embProvider === "gemini" && !!config.embeddings.gemini?.apiKey;

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

  // Managed Pi extension. When a routable capability (image and/or coding) is
  // configured the owned dir is stamped/re-stamped on drift; when none is
  // configured the desired state is absence, so a leftover dir is removed.
  // Either way it self-heals when repair is enabled (the same pattern as the
  // systemd units). Gated to the real `phantombot` binary, mirroring the
  // harness/systemd/timer checks, so `bun test`/dev never touch the dev box's
  // real ~/.pi. Not gated on routing being set, so dropping routing also
  // triggers cleanup of a previously-stamped dir.
  let piExtensionReport: DoctorReport["piExtension"] | undefined;
  if (input.checkPiExtension === false) {
    // explicitly skipped by a test
  } else if (input.checkPiExtension) {
    piExtensionReport = await input.checkPiExtension();
  } else if (isPhantombotBinary()) {
    const piRouting = config.harnesses?.pi?.routing;
    const status = await routingExtensionStatus(piRouting);
    let repaired = false;
    if (repair && status.drifted) {
      try {
        if (status.shouldExist) {
          await ensureRoutingExtension(piRouting);
        } else {
          await removeRoutingExtension();
        }
        repaired = true;
      } catch (e) {
        log.warn("doctor: pi extension repair failed", {
          error: (e as Error).message,
        });
      }
    }
    piExtensionReport = {
      shouldExist: status.shouldExist,
      present: status.present,
      drifted: status.drifted,
      dir: status.dir,
      ...(repaired ? { repaired } : {}),
    };
  }

  // ACP editor connectors. With repair on (the default), doctor actively
  // (re)registers phantombot into any detected editor — the same self-heal as
  // the pi extension / systemd checks, and a second entry point besides
  // startup so Andrew never runs `acp install` by hand. With --no-repair it
  // only reports drift. Gated to the real `phantombot` binary so dev/test never
  // writes the dev box's editor settings.
  let editorConnectors: DoctorReport["editorConnectors"];
  if (input.checkEditorConnectors === false) {
    // explicitly skipped by a test
  } else if (input.checkEditorConnectors) {
    editorConnectors = input.checkEditorConnectors(repair);
  } else if (isPhantombotBinary()) {
    editorConnectors = reconcileEditorConnectors({
      binaryPath: process.execPath,
      repair,
    });
  }

  // Restore points for the database checked above (#417).
  const restorePoints = await listRestorePoints(config.memoryDbPath);
  // Only the newest point is integrity-checked in the common case: each check
  // reads the whole file, and walking five 300 MB snapshots on every doctor
  // run would turn a diagnostic into an I/O event. When the newest one is bad
  // we DO walk back, because that is precisely the moment the operator needs
  // to know which point is still good.
  let newestGood: string | undefined;
  for (const point of restorePoints) {
    if (!checkIntegrity(point.path).ok) continue;
    newestGood = point.path;
    break;
  }
  const unretiredDrawers = DRAWER_KINDS.map(drawerPath).filter((rel) =>
    existsSync(join(dir, rel)),
  );

  const report: DoctorReport = {
    persona,
    nightly: {
      last_run: state.last_run,
      last_status: state.last_status,
      ...(state.errors && state.errors.length > 0
        ? { errors: state.errors }
        : {}),
      age_hours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
      health: health.status,
      detail: health.detail,
      backlog: health.backlog,
      ...(health.oldest_pending
        ? { oldest_pending: health.oldest_pending }
        : {}),
    },
    memory_db: {
      path: config.memoryDbPath,
      healthy: dbHealth.ok,
      detail: dbHealth.detail,
      bytes: existsSync(config.memoryDbPath)
        ? statSync(config.memoryDbPath).size
        : 0,
      restore_points: restorePoints.map((p) => ({
        taken_at: p.takenAt.toISOString(),
        bytes: p.bytes,
        path: p.path,
      })),
      ...(newestGood ? { newest_good: newestGood } : {}),
      unretired_drawers: unretiredDrawers,
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
    ...(piExtensionReport ? { piExtension: piExtensionReport } : {}),
    ...(editorConnectors ? { editorConnectors } : {}),
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
  // A drifted managed Pi extension (missing-but-wanted, stale, or
  // present-but-unwanted) that wasn't repaired this run is a health failure,
  // same as the systemd/timer/harness checks above. `repaired` is set only
  // when this run actually re-stamped/removed it, so `--no-repair` leaves the
  // drift visible and trips exit 1. NOTE: this is the `doctor` *CLI* exit code,
  // a diagnostic signal for humans/CI — it does NOT gate the long-running
  // service. `run.ts` calls doctor at startup but only logs a non-zero code
  // (and provisioning is fire-and-forget, warn-only), so the daemon never dies
  // on it. The "phantombot must never exit 1 so a revert can ship" invariant
  // lives in the service path and stays intact.
  const piExtensionBroken =
    !!piExtensionReport &&
    piExtensionReport.drifted &&
    !piExtensionReport.repaired;
  // A detected editor that's still un-registered (or whose settings couldn't be
  // parsed) after this run is a health failure — same diagnostic-only exit code
  // as the checks above (it never gates the daemon; run.ts only logs it).
  // `stale` only appears under --no-repair; `error` means the data-loss guard
  // refused to touch a malformed settings file. `registered`/`updated` are
  // successful heals, not failures.
  const editorConnectorsBroken =
    !!editorConnectors && editorConnectors.some(editorConnectorBroken);
  // An unreadable memory database is the most serious thing doctor can find:
  // every other check is about a process that can be restarted, this one is
  // about the data. No restore point at all is NOT a failure on its own — a
  // box installed this afternoon has none yet, and crying WARN there would
  // teach an operator to ignore the line that matters.
  const memoryDbBroken = dbPresent && !dbHealth.ok;
  const exitCode =
    memoryDbBroken
      ? 1
      : health.status === "error"
      ? 1
      : systemdBroken
        ? 1
        : timersBroken
          ? 1
          : harnessesBroken
            ? 1
            : piExtensionBroken
              ? 1
              : editorConnectorsBroken
                ? 1
                : 0;

  if (input.json) {
    out.write(JSON.stringify(report, null, 2) + "\n");
    return exitCode;
  }

  // Human summary.
  const tick = (ok: boolean) => (ok ? "ok" : "WARN");
  out.write(`phantombot doctor — persona '${persona}'\n`);
  // Health comes off the ledger, not the clock: a box that slept through
  // 02:00 but has nothing pending is healthy.
  const marker =
    health.status === "ok"
      ? "ok"
      : health.status === "running"
        ? "RUNNING"
        : health.status === "warning"
          ? "WARN"
          : "ERR";
  out.write(
    `  nightly: ${marker} — ${health.detail}` +
      (state.last_run
        ? ` (last sweep ${state.last_run}, ${report.nightly.age_hours}h ago)`
        : "") +
      "\n",
  );
  if (state.errors && state.errors.length > 0) {
    for (const e of state.errors) {
      out.write(`    error: ${e}\n`);
    }
  }
  out.write(
    `  capture: ${tick(!dryDay)} — ${captures} capture(s), ${userTurns} ` +
      `user turn(s) in the last ${report.capture.window_hours}h` +
      (dryDay ? " — DRY DAY: turns but no captures" : "") +
      "\n",
  );
  const points = report.memory_db.restore_points;
  out.write(
    `  memory db: ${tick(dbHealth.ok)} — ` +
      (dbHealth.ok
        ? `${Math.round(report.memory_db.bytes / 1024 / 1024)} MB, ` +
          `${points.length} restore point(s)` +
          (points[0] ? `, newest ${points[0].taken_at}` : "")
        : `integrity check FAILED: ${dbHealth.detail}`) +
      "\n",
  );
  if (!dbHealth.ok) {
    // The recovery instruction is printed WITH the fault, not left in a
    // runbook: this is read by someone whose memory database just failed, and
    // the next two commands should not require finding documentation.
    out.write(
      newestGood
        ? `  → stop phantombot, then: phantombot memory restore --from ${newestGood} --yes\n`
        : "  → no healthy restore point found; check `phantombot memory backup --list` " +
          "before overwriting anything\n",
    );
  } else if (points.length === 0) {
    out.write(
      "  → no restore points yet; the next nightly sweep takes one " +
        "(or run `phantombot memory backup`)\n",
    );
  }
  if (unretiredDrawers.length > 0) {
    out.write(
      `  → markdown drawer(s) still on disk: ${unretiredDrawers.join(", ")} — ` +
        "run `phantombot memory drawers --retire` to see what held them back\n",
    );
  }
  // Embeddings line is deliberately neutral — no ok/WARN marker, never an
  // exit-code input. Vector search is an optional enhancement, not a
  // requirement; absence is a valid, fully-working configuration.
  out.write(
    semanticSearch
      ? `  embeddings: semantic (vector) search ON — provider '${embProvider}'\n`
      : "  embeddings: semantic (vector) search off — OKF field-weighted BM25 " +
        "+ link-graph expansion active. Optional: add Gemini with `phantombot embedding`\n",
  );
  if (health.backlog > 0) {
    out.write(
      `  → ${health.backlog} date(s) pending; the next \`phantombot nightly\` ` +
        "sweep picks them up automatically\n",
    );
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

  if (piExtensionReport) {
    const r = piExtensionReport;
    if (!r.shouldExist) {
      // Desired state is absence (no routable capability configured). Healthy
      // when the dir is gone, or we removed it this run.
      const ok = !r.present || !!r.repaired;
      out.write(`  pi extension: ${tick(ok)} — `);
      if (!r.present) {
        out.write(
          `no routing capability configured; managed capability-routing extension correctly absent\n`,
        );
      } else if (r.repaired) {
        out.write(
          `removed stale capability-routing extension at ${r.dir} (no routing capability configured)\n`,
        );
      } else {
        out.write(
          `stale capability-routing extension present at ${r.dir} but no routing capability configured — run \`phantombot doctor\` to remove it\n`,
        );
      }
    } else {
      const ok = r.present && (!r.drifted || !!r.repaired);
      out.write(`  pi extension: ${tick(ok)} — `);
      if (!r.present) {
        out.write(
          r.repaired
            ? `stamped managed capability-routing extension into ${r.dir}\n`
            : `managed capability-routing extension missing at ${r.dir} — run \`phantombot doctor\` (or restart) to stamp it\n`,
        );
      } else if (r.drifted) {
        out.write(
          r.repaired
            ? `re-stamped drifted capability-routing extension at ${r.dir}\n`
            : `managed capability-routing extension drifted at ${r.dir} — run \`phantombot doctor\` to re-stamp\n`,
        );
      } else {
        out.write(
          `managed capability-routing extension present and current at ${r.dir}\n`,
        );
      }
    }
  }

  if (editorConnectors && editorConnectors.length > 0) {
    for (const e of editorConnectors) {
      const ok = !editorConnectorBroken(e);
      out.write(`  editor (${e.editor}): ${tick(ok)} — `);
      switch (e.action) {
        case "not-detected":
          out.write("not installed on this machine; nothing to register\n");
          break;
        case "current":
          out.write(`registered and current in ${e.settingsPath}\n`);
          break;
        case "registered":
          out.write(`registered phantombot in ${e.settingsPath}\n`);
          break;
        case "updated":
          out.write(
            `updated phantombot registration (binary path changed) in ${e.settingsPath}\n`,
          );
          break;
        case "stale":
          out.write(
            `registration missing or out of date in ${e.settingsPath} — run \`phantombot doctor\` (without --no-repair) or restart to fix\n`,
          );
          break;
        case "error":
          out.write(
            `could not register in ${e.settingsPath}${e.error ? ` — ${e.error}` : ""}\n`,
          );
          break;
      }
      // Second line for VS Code's proposed-api allow-list. Silent when already
      // `current` (or undefined, i.e. an editor without the concept), so a
      // healthy box shows exactly one line per editor as before.
      switch (e.proposedApi) {
        case "enabled":
          out.write(
            "    proposed-api: allow-listed in ~/.vscode/argv.json — restart VS Code to activate\n",
          );
          break;
        case "stale":
          out.write(
            "    proposed-api: NOT allow-listed in ~/.vscode/argv.json — extension falls back to the `@phantombot` participant instead of a native chat session; run `phantombot doctor` (without --no-repair) to fix\n",
          );
          break;
        case "error":
          out.write(
            `    proposed-api: could not be allow-listed${e.proposedApiError ? ` — ${e.proposedApiError}` : ""}\n`,
          );
          break;
      }
    }
  }

  return exitCode;
}

async function computeHarnessReport(
  config: Config,
): Promise<DoctorReport["harnesses"] | undefined> {
  if (!isPhantombotBinary()) return undefined;
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
  if (!isPhantombotBinary(binPath)) return undefined;
  const systemctl = new BunSystemctlRunner(buildSystemctlEnv(sysEnv));
  const expectedFiles: Array<{ path: string; name: string }> = [
    { path: defaultUnitPath(), name: basename(defaultUnitPath()) },
    {
      path: heartbeatServicePath(),
      name: basename(heartbeatServicePath()),
    },
    { path: heartbeatTimerPath(), name: basename(heartbeatTimerPath()) },
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
        heal.rewrote.length > 0 ||
        heal.repairedTimers.length > 0 ||
        heal.removedRetired.length > 0;
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
  if (!isPhantombotBinary()) return undefined;
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
  // Two timers, not three: the nightly timer is retired (the sweep runs on
  // startup and on the heartbeat's day-rollover check), so an absent one is
  // correct rather than a fault to repair.
  for (const t of [HEARTBEAT_TIMER_NAME, TICK_TIMER_NAME]) {
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
      "Memory health check — reports nightly sweep backlog, capture health, timers and connectors. The nightly repairs itself by sweeping; doctor only reports it.",
  },
  args: {
    persona: {
      type: "string",
      description: "Persona name (default: configured default).",
    },
    repair: {
      type: "boolean",
      description:
        "Repair drifted systemd units, timers, the Pi extension and editor " +
        "connectors. Pass --no-repair to only report.",
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
