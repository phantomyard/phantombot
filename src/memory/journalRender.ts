/**
 * Rows → markdown, verified, then pruned — the DERIVE half of #461.
 *
 * The journal has one writer (rows) and one derived artefact (the daily
 * markdown file). This module is the only thing that produces the artefact,
 * and the only thing that drops rows. Its whole design is a refusal to trust
 * the clock:
 *
 *   RENDER  a CLOSED day — never today. Today is still being appended to, so
 *           any fingerprint taken of it is stale by the next capture.
 *   VERIFY  by reading the file back and hashing what is actually on disk. A
 *           short write, a full disk, a read-only mount or a permissions
 *           change leaves the day UNVERIFIED and its rows untouched.
 *   PRUNE   only days verified on an EARLIER run. That one-run overlap is
 *           what a nightly which renders and then dies costs us: disk space,
 *           not content.
 *
 * A nightly that has not fired for three days therefore finds three dates,
 * renders three correct daily files, and prunes none of them until the run
 * after that. Rows are keyed by their own date, so nothing merges into one
 * blob and nothing lands on today.
 *
 * The failure mode this cannot self-heal is a nightly that never runs at all:
 * rows accumulate silently, because recall only ever reads TODAY and would
 * show no symptom. Hence `backlogDays` and the alarm on it — a memory system
 * that degrades invisibly is the one bug class worth spending an alert on.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { log } from "../lib/logger.js";
import { MemoryIndex } from "../lib/memoryIndex.ts";
import { memoryIndexPath } from "../config.ts";
import { absorbDay } from "./journalIngest.ts";
import { dayFingerprint, renderDay, type JournalStore } from "./journal.ts";

/**
 * Unrendered closed days past which we stop treating a lagging nightly as
 * noise. Two: one is a nightly that missed a single fire (a reboot, a laptop
 * closed overnight), which is routine and self-heals on the next run.
 */
export const JOURNAL_BACKLOG_ALARM_DAYS = 2;

export interface JournalRenderResult {
  /** Days written and verified on this run. */
  rendered: string[];
  /** Days whose artefact did not verify — rows deliberately kept. */
  failed: string[];
  /** Days whose rows were dropped after a second, independent confirmation. */
  pruned: string[];
  /** Unrendered closed days still outstanding after this run. */
  backlogDays: number;
}

/**
 * Render every closed day that has never been verified, then prune the days
 * an earlier run verified.
 *
 * Never throws: the nightly has other stages, and a journal that failed to
 * render is a retry next time, not a reason to abandon the sweep.
 */
export async function renderClosedDays(
  store: JournalStore,
  personaDir: string,
  persona: string,
  today: string,
  now = new Date(),
): Promise<JournalRenderResult> {
  const out: JournalRenderResult = {
    rendered: [],
    failed: [],
    pruned: [],
    backlogDays: 0,
  };

  for (const date of store.unrenderedDates(persona, today)) {
    try {
      // Adopt anything already in the file so a hand-written line survives
      // the render instead of being overwritten by it.
      await absorbDay(store, personaDir, persona, date);
      const entries = store.listDay(persona, date);
      if (entries.length === 0) continue;
      const text = renderDay(date, entries);
      const path = join(personaDir, "memory", `${date}.md`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, "utf8");
      // Read back, not "assume written": the whole point of the fingerprint
      // is that it is evidence about the disk, not about our intent.
      const onDisk = await readFile(path, "utf8");
      if (dayFingerprint(onDisk) !== dayFingerprint(text)) {
        out.failed.push(date);
        log.warn("journal: rendered day did not verify; keeping rows", {
          persona,
          date,
        });
        continue;
      }
      store.markRendered(persona, date, dayFingerprint(text), entries.length, now);
      out.rendered.push(date);
      // The file now carries the day, and refreshStale will index it as a
      // real note. Drop the virtual stand-in so the day is never indexed
      // twice under the same path.
      await dropOpenDayIndex(persona, date);
    } catch (e) {
      out.failed.push(date);
      log.warn("journal: render failed", {
        persona,
        date,
        error: (e as Error).message,
      });
    }
  }

  for (const date of store.prunableDates(persona, today)) {
    const rec = store.dayRecord(persona, date);
    const path = join(personaDir, "memory", `${date}.md`);
    let onDisk: string | undefined;
    try {
      onDisk = existsSync(path) ? await readFile(path, "utf8") : undefined;
    } catch {
      onDisk = undefined;
    }
    // Re-confirm against the disk NOW, not against the record written last
    // night: the file may have been deleted, truncated or restored from an
    // older backup in between. If it no longer matches, forget the render and
    // let the next run rebuild it from the rows we still hold.
    if (!rec || onDisk === undefined || dayFingerprint(onDisk) !== rec.fingerprint) {
      store.clearDayRecord(persona, date);
      log.warn("journal: artefact no longer matches; re-rendering next run", {
        persona,
        date,
      });
      continue;
    }
    const dropped = store.pruneDay(persona, date, now);
    out.pruned.push(date);
    log.info("journal: pruned rows for a verified day", {
      persona,
      date,
      rows: dropped,
    });
  }

  out.backlogDays = store.unrenderedDates(persona, today).length;
  if (out.backlogDays > JOURNAL_BACKLOG_ALARM_DAYS) {
    log.warn("journal: unrendered days piling up", {
      persona,
      backlogDays: out.backlogDays,
      alarmAbove: JOURNAL_BACKLOG_ALARM_DAYS,
    });
  }
  return out;
}

/** Index path for one day's markdown, real or virtual. */
export function journalDayPath(date: string): string {
  return `memory/${date}.md`;
}

/**
 * Publish the open day's rows to the search index under the path its file
 * will eventually have.
 *
 * This is the durability half of "rows are the write path". Without it, a
 * capture is invisible to `memory search` — the persona's own reflex — until
 * the nightly renders the day, an up-to-24-hour hole in which the agent
 * re-derives things it wrote down that morning. Indexed on write, the entry
 * is recallable in the same minute, lexically now and semantically as soon as
 * the embed pass runs.
 *
 * Never throws: indexing is a convenience over a write that already
 * succeeded.
 */
export async function indexOpenDay(
  store: JournalStore,
  persona: string,
  date: string,
  indexPathOverride?: string,
): Promise<void> {
  let ix: MemoryIndex | undefined;
  try {
    const entries = store.listDay(persona, date);
    if (entries.length === 0) return;
    ix = await MemoryIndex.open(indexPathOverride ?? memoryIndexPath(persona));
    ix.upsertVirtualNote({
      path: journalDayPath(date),
      scope: "memory",
      title: `Journal ${date}`,
      body: renderDay(date, entries),
    });
  } catch (e) {
    log.warn("journal: index of open day failed", {
      persona,
      date,
      error: (e as Error).message,
    });
  } finally {
    ix?.close();
  }
}

/** Remove the virtual stand-in once the real file exists. Never throws. */
export async function dropOpenDayIndex(
  persona: string,
  date: string,
  indexPathOverride?: string,
): Promise<void> {
  let ix: MemoryIndex | undefined;
  try {
    ix = await MemoryIndex.open(indexPathOverride ?? memoryIndexPath(persona));
    ix.removeVirtualNote(journalDayPath(date));
  } catch {
    // A stale virtual row is harmless: it is overwritten the moment
    // refreshStale indexes the real file at the same path.
  } finally {
    ix?.close();
  }
}
