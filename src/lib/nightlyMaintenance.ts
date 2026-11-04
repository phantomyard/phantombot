/**
 * The nightly's housekeeping on the memory DATABASE — issue #417.
 *
 * Compaction (stage three) keeps the prompt FILES inside their budgets. This
 * is its counterpart for the rows: now that the drawers are the database
 * rather than five markdown files, the two things the files used to give us
 * for free have to be done explicitly.
 *
 *   RETIREMENT. `decisions.md` grew to 684 KB because nothing ever pruned it —
 *     every superseded decision sat in the file forever, and compaction
 *     deliberately would not rewrite a drawer. Rows retire instead of being
 *     deleted: `sweepDormant` moves beliefs whose decayed score fell under the
 *     floor to `dormant`, so they stop being injected and stay queryable. That
 *     is the same "never delete, stop ranking" rule, made mechanical.
 *
 *   DURABILITY. A markdown drawer was recoverable from any backup, any git
 *     checkout, or a text editor's undo. A row is recoverable from a snapshot
 *     or not at all — so the sweep takes one, verified, and keeps a handful of
 *     restore points (`memory/dbBackup.ts`).
 *
 * The snapshot is taken LAST, after distillation, compaction and the dormancy
 * sweep have finished. A restore point should represent a settled night, not
 * a database mid-rewrite — and if a stage corrupted something, the integrity
 * check in front of the snapshot is what refuses to rotate that corruption
 * into the restore points.
 */

import { SCHEDULER_COMMITMENT } from "./heartbeat.ts";
import type { WriteSink } from "./io.ts";
import { log } from "./logger.ts";
import {
  backupMemoryDb,
  SNAPSHOT_COALESCE_MS,
  type BackupResult,
} from "../memory/dbBackup.ts";
import { openDrawerStore } from "../memory/drawerSync.ts";
import type { DrawerEntry, DrawerStore } from "../memory/drawers.ts";
import { openJournalStore } from "../memory/journalIngest.ts";
import {
  renderClosedDays,
  JOURNAL_BACKLOG_ALARM_DAYS,
  type JournalRenderResult,
} from "../memory/journalRender.ts";

export interface MaintenanceResult {
  /** Beliefs moved to `dormant` this run. */
  dormant: number;
  /** Commitments expired by the hygiene rules (#763), per rule. */
  commitmentHygiene?: CommitmentHygieneResult;
  /** Closed journal days rendered to markdown, and rows pruned (#461). */
  journal?: JournalRenderResult;
  backup?: BackupResult;
  /** Anything that failed. Reported, never thrown — see below. */
  errors: string[];
}

export interface CommitmentHygieneResult {
  empty: number;
  scheduler: number;
  duplicate: number;
}

/** Tag, stamp, case and spacing stripped: what two copies of one commitment share. */
export function normaliseCommitment(content: string): string {
  return content
    .replace(/^\s*\[commitment\]\s*/i, "")
    .replace(/\s*·\s*\d{1,2}:\d{2}Z\s*$/, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Expire junk ACTIVE commitments (#763): empty or blank rows, the scheduler
 * format, and exact duplicates after normalising (the newest survives).
 * Expire only, never delete; other kinds and anything else are left alone,
 * however old. Idempotent: a second run expires nothing.
 */
export function expireJunkCommitments(store: DrawerStore, persona: string): CommitmentHygieneResult {
  const r: CommitmentHygieneResult = { empty: 0, scheduler: 0, duplicate: 0 };
  const groups = new Map<string, DrawerEntry[]>();
  for (const e of store.list(persona, "commitments")) {
    if (e.status !== "active") continue;
    const norm = normaliseCommitment(e.content);
    if ((norm.match(/[\p{L}\p{N}]/gu)?.length ?? 0) < 3) {
      store.setStatus(e.id, "expired");
      r.empty++;
    } else if (SCHEDULER_COMMITMENT.test(e.content)) {
      store.setStatus(e.id, "expired");
      r.scheduler++;
    } else {
      const g = groups.get(norm);
      if (g) g.push(e);
      else groups.set(norm, [e]);
    }
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort(
      (a, b) =>
        b.assertedAt.getTime() - a.assertedAt.getTime() ||
        b.lastReaffirmedAt.getTime() - a.lastReaffirmedAt.getTime(),
    );
    for (const e of g.slice(1)) {
      store.setStatus(e.id, "expired");
      r.duplicate++;
    }
  }
  return r;
}

/**
 * Run the database housekeeping for one persona.
 *
 * Never throws — it runs at the tail of a sweep that has already done the
 * expensive cognitive work, and a failed snapshot must not abort the sweep
 * that produced the data worth snapshotting. Failures are RETURNED, and the
 * caller decides what they mean; the nightly driver folds them into the
 * sweep's errors, because a memory database that cannot be verified or backed
 * up is exactly the condition `doctor` and the ledger exist to make visible.
 */
export async function runMemoryMaintenance(input: {
  dbPath: string;
  persona: string;
  /** Persona working directory. Required for the journal render stage. */
  personaDir?: string;
  keep?: number;
  now?: Date;
  /** Snapshot coalescing window (#495). Defaults to `SNAPSHOT_COALESCE_MS`. */
  coalesceMs?: number;
  out?: WriteSink;
  /**
   * Skip the journal RENDER stage (#633). The nightly runs this function
   * twice: at the head of the sweep, where the render must precede the date
   * queue build so the just-closed day is swept the same night, and at the
   * tail, where only the dormancy sweep + restore point belong (the snapshot
   * must capture the settled end state, and a mid-sweep re-render could race
   * the compaction stage). Never set by other callers.
   */
  skipRender?: boolean;
  /**
   * Skip the SNAPSHOT (restore point) stage (#633). Set by the nightly's
   * HEAD call, whose job is the render only — the night's restore point is
   * taken once, at the tail, after every other stage has settled. Like
   * skipRender, never set by callers other than the nightly driver.
   */
  skipSnapshot?: boolean;
}): Promise<MaintenanceResult> {
  const now = input.now ?? new Date();
  const write = (t: string) => input.out?.write(t);
  const result: MaintenanceResult = { dormant: 0, errors: [] };

  try {
    const { store, close } = await openDrawerStore(input.dbPath);
    try {
      const moved = store.sweepDormant(input.persona, now);
      result.dormant = moved.length;
      if (moved.length > 0) {
        write(
          `nightly: ${moved.length} drawer entr${moved.length === 1 ? "y" : "ies"} ` +
            `went dormant (queryable, no longer injected)\n`,
        );
      }
    } finally {
      close();
    }
  } catch (e) {
    const msg = `dormancy sweep: ${(e as Error).message}`;
    result.errors.push(msg);
    log.warn("nightly: dormancy sweep failed", { error: (e as Error).message });
  }

  try {
    const { store, close } = await openDrawerStore(input.dbPath);
    try {
      const h = expireJunkCommitments(store, input.persona);
      result.commitmentHygiene = h;
      const n = h.empty + h.scheduler + h.duplicate;
      if (n > 0) {
        write(
          `nightly: ${n} commitment(s) expired by hygiene ` +
            `(empty ${h.empty}, scheduler ${h.scheduler}, duplicate ${h.duplicate})\n`,
        );
      }
    } finally {
      close();
    }
  } catch (e) {
    const msg = `commitment hygiene: ${(e as Error).message}`;
    result.errors.push(msg);
    log.warn("nightly: commitment hygiene failed", { error: (e as Error).message });
  }

  // The journal render — rows to markdown, verified, then the rows of days an
  // EARLIER run already verified (#461). Deliberately before the snapshot: a
  // restore point taken after the prune captures the state we intend to keep,
  // where one taken before would preserve rows we are about to drop.
  //
  // Rendering is the only thing that turns a day into a durable file, so a
  // backlog here is memory quietly not being written down. Recall reads only
  // TODAY, so nothing about a stalled render is visible in the prompt — which
  // is exactly why it gets an error line rather than a debug log.
  if (input.personaDir && !input.skipRender) {
    try {
      const { store, close } = await openJournalStore(input.dbPath);
      try {
        const today = now.toISOString().slice(0, 10);
        const journal = await renderClosedDays(
          store,
          input.personaDir,
          input.persona,
          today,
          now,
        );
        result.journal = journal;
        if (journal.rendered.length > 0 || journal.pruned.length > 0) {
          write(
            `nightly: journal rendered ${journal.rendered.length} day(s)` +
              (journal.pruned.length > 0
                ? `, pruned rows for ${journal.pruned.length}`
                : "") +
              `\n`,
          );
        }
        for (const date of journal.failed) {
          result.errors.push(
            `journal render ${date}: artefact did not verify (rows kept)`,
          );
        }
        if (journal.backlogDays > JOURNAL_BACKLOG_ALARM_DAYS) {
          result.errors.push(
            `journal: ${journal.backlogDays} closed day(s) still unrendered — ` +
              `run 'phantombot memory journal --render'`,
          );
        }
      } finally {
        close();
      }
    } catch (e) {
      const msg = `journal render: ${(e as Error).message}`;
      result.errors.push(msg);
      log.warn("nightly: journal render failed", { error: (e as Error).message });
    }
  }

  if (!input.skipSnapshot) {
    try {
      const backup = await backupMemoryDb({
        dbPath: input.dbPath,
        keep: input.keep,
        now,
        // The database is shared by every persona on the host, and since the
        // per-persona nightly instances (#490) the siblings roll over together.
        // One restore point per rollover is the whole point of a restore point,
        // so a sweep that finds a fresh one — or finds a sibling mid-snapshot —
        // stands down instead of racing it (#495).
        coalesceMs: input.coalesceMs ?? SNAPSHOT_COALESCE_MS,
      });
      result.backup = backup;
      if (backup.status === "taken") {
        write(
          `nightly: memory snapshot ${backup.path} ` +
            `(${Math.round((backup.bytes ?? 0) / 1024)} KB)` +
            (backup.pruned.length > 0
              ? `, ${backup.pruned.length} older point(s) rotated out`
              : "") +
            `\n`,
        );
      } else if (backup.status === "fresh") {
        // Not an error and deliberately not in `errors`: a sibling sweep took
        // the snapshot seconds ago, so this host IS backed up. Writing it to the
        // ledger would leave `doctor` permanently red on a healthy box, which is
        // how operators learn to stop reading doctor at all.
        // Two different shapes share `fresh`: a sibling's restore point already
        // covers this rollover (we have a path), or the lock stayed held and
        // nothing was taken at all. Say which — an operator reading the ledger
        // should not have to guess whether a snapshot exists.
        write(
          backup.path
            ? `nightly: memory snapshot skipped — a restore point from this ` +
                `rollover already exists (${backup.path})\n`
            : `nightly: memory snapshot skipped — another snapshot is in ` +
                `flight, nothing taken this run\n`,
        );
      } else if (backup.status === "refused") {
        // Loud on purpose: an unhealthy memory database is the one condition
        // where doing nothing is right AND the operator has to know tonight.
        const msg = `memory database failed its integrity check: ${backup.integrity.detail}`;
        result.errors.push(msg);
        write(
          `nightly: ${msg}\n` +
            `nightly: no snapshot taken — existing restore points are intact.\n` +
            `nightly: recover with 'phantombot memory restore --list' then ` +
            `'phantombot memory restore --from <point>'\n`,
        );
      }
    } catch (e) {
      const msg = `snapshot: ${(e as Error).message}`;
      result.errors.push(msg);
      log.warn("nightly: snapshot failed", { error: (e as Error).message });
    }
  }

  return result;
}
