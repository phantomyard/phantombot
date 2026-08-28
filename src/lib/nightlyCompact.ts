/**
 * Nightly compaction — stage three (issue #410).
 *
 * The distill and kb stages only ever APPEND. Nothing in the system has ever
 * removed a byte, so the always-in-context files grow without bound: on this
 * box the drawers reached 663KB and MEMORY.md drifted past its useful size,
 * which costs tokens on every single turn and buries live facts under dead
 * ones. Compaction is the missing half of the loop.
 *
 * Three rules shape the whole design:
 *
 *   1. NOTHING IS EVER DELETED. Before a file is rewritten its exact bytes are
 *      copied to `memory/archive/<YYYY-MM-DD>/`. A bad pass is recovered with
 *      `cp`, not a restore from backup. The nightly is the only writer here —
 *      no other code path moves or removes a memory file.
 *   2. A PASS THAT EATS TOO MUCH IS REVERTED, not surfaced-and-kept. Each
 *      target carries a `maxShrinkPct`; a rewrite that overshoots it (or that
 *      empties or loses the file) is rolled back from the archive copy and
 *      recorded as `reverted` in the ledger.
 *   3. ONLY OVER-BUDGET FILES ARE TOUCHED. A file inside its budget costs one
 *      `stat` and is left alone, so a healthy persona pays nothing.
 *
 * DAILY FILES ARE NOT IN SCOPE (issue #461). They used to be: a day's markdown
 * was the live journal, it was injected verbatim on every turn, and it grew
 * without bound — so trimming a closed one was a real saving. Since the journal
 * became `journal_entries` rows the file is a DERIVED artefact rendered once,
 * for closed days only, and recall never reads a day older than yesterday.
 * Compacting one therefore saved nothing in the prompt while costing an LLM
 * stage, and — because the archive pre-image is kept forever — it cost disk
 * rather than reclaiming it. Worse, `renderClosedDays` prunes a day's rows once
 * the file verifies, so from then on the file is the ONLY copy of that day:
 * the pass was summarising the last surviving record to save bytes nobody was
 * paying for. Budget the journal at the row layer, not with a rewrite.
 *
 * The drawers are NOT in scope here either, and no longer even measured:
 * `commitments.md`, `decisions.md` and `lessons.md` were append-only logs
 * whose dedupe/merge lifecycle has since moved into `drawer_entries` rows
 * (see `nightlyMaintenance`). The files are retired and archived; any still
 * on disk were HELD by retirement, which the heartbeat and `doctor` already
 * report, so there is nothing left for compaction to say about them.
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "./io.ts";
import { log } from "./logger.ts";

/**
 * What kind of file a compaction target is — drives the prompt wording.
 *
 * One member today. It stays a named union rather than collapsing into the
 * literal because `CompactionOutcome` is PERSISTED in the nightly ledger, and
 * records written before #461 carry `kind: "daily"`; a reader that narrowed to
 * a bare literal would be asserting something about old state.json files that
 * is not true of them.
 */
export type CompactionKind = "memory";

export interface CompactionBudget {
  /** Persona-relative path, e.g. `memory/MEMORY.md`. */
  path: string;
  kind: CompactionKind;
  /** Compaction is considered only once the file exceeds this many bytes. */
  budgetBytes: number;
  /**
   * Largest share of the file a single pass may remove. Exceeding it reverts
   * the pass. MEMORY.md is prose in the prompt and must only be pruned, never
   * rebuilt from scratch.
   */
  maxShrinkPct: number;
}

/** 16KB of orientation text is already ~4k tokens on EVERY turn. */
export const MEMORY_BUDGET_BYTES = 16 * 1024;
/** Optional per-persona override, e.g. `{"memory/MEMORY.md": 32768}`. */
export const BUDGET_OVERRIDE_FILE = "memory/.compaction-budgets.json";

export function defaultBudgets(): CompactionBudget[] {
  return [
    {
      path: "MEMORY.md",
      kind: "memory",
      budgetBytes: MEMORY_BUDGET_BYTES,
      maxShrinkPct: 40,
    },
  ];
}

/**
 * Merge the persona's optional budget overrides over the defaults. Only the
 * byte budget is overridable — `maxShrinkPct` is a safety guard, not a knob,
 * and a persona that could raise it could talk itself into an empty drawer.
 */
export async function resolveBudgets(
  personaDir: string,
): Promise<CompactionBudget[]> {
  const base = defaultBudgets();
  const p = join(personaDir, BUDGET_OVERRIDE_FILE);
  if (!existsSync(p)) return base;
  try {
    const raw = JSON.parse(await readFile(p, "utf8")) as Record<
      string,
      unknown
    >;
    return base.map((b) => {
      const v = raw[b.path];
      return typeof v === "number" && Number.isFinite(v) && v > 0
        ? { ...b, budgetBytes: Math.floor(v) }
        : b;
    });
  } catch (e) {
    log.warn("nightly: budget override unreadable; using defaults", {
      path: p,
      error: (e as Error).message,
    });
    return base;
  }
}

/** One file this sweep intends to compact. */
export interface CompactionCandidate extends CompactionBudget {
  /** Absolute path. */
  absPath: string;
  sizeBytes: number;
}

/**
 * Which files are over budget right now.
 *
 * Daily files are deliberately never candidates — see the note at the top of
 * this module. A persona with no over-budget file pays one `stat` for the
 * whole stage.
 */
export async function compactionCandidates(
  personaDir: string,
  opts: {
    budgets?: CompactionBudget[];
  } = {},
): Promise<CompactionCandidate[]> {
  const budgets = opts.budgets ?? (await resolveBudgets(personaDir));
  const out: CompactionCandidate[] = [];

  for (const b of budgets) {
    const absPath = join(personaDir, b.path);
    let size: number;
    try {
      size = (await stat(absPath)).size;
    } catch {
      continue; // a drawer that has never been written is not a candidate
    }
    if (size > b.budgetBytes) out.push({ ...b, absPath, sizeBytes: size });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Archive — the only reason any of this is safe to run unattended
// ---------------------------------------------------------------------------

export function archiveDirPath(personaDir: string, stamp: string): string {
  return join(personaDir, "memory", "archive", stamp);
}

/**
 * Copy a file's exact bytes into `memory/archive/<stamp>/` and return the
 * archive path. Copies rather than moves: the live file must stay in place for
 * the stage to rewrite, and a half-applied pass must never leave a gap where
 * memory used to be.
 *
 * Every pass gets its OWN copy, even a second pass on the same day. Reusing
 * the first pass's copy would be actively wrong: rollback restores the bytes
 * in the archive, so a second pass that overshoots would be rolled back past
 * its own starting point and resurrect content the FIRST pass had correctly
 * removed. The archive holds a pre-image per pass, not per date — and since
 * nothing here is ever deleted, the earlier pre-image stays alongside it.
 */
export async function archiveForCompaction(
  personaDir: string,
  candidate: CompactionCandidate,
  stamp: string,
): Promise<string> {
  const dir = archiveDirPath(personaDir, stamp);
  await mkdir(dir, { recursive: true });
  // Flatten the persona-relative path so `memory/decisions.md` and a future
  // `kb/decisions.md` can't collide inside one archive dir.
  const base = candidate.path.replace(/[\\/]/g, "__");
  let dest = join(dir, base);
  // A same-day repeat pass lands next to its predecessor rather than over it.
  for (let n = 2; existsSync(dest) && n < 1000; n++) {
    dest = join(dir, base.replace(/(\.md)?$/, `.${n}$1`));
  }
  await copyFile(candidate.absPath, dest);
  return dest;
}

/**
 * Put the archived bytes back over the live file.
 *
 * Atomic, via tempfile + fsync + rename. A plain `copyFile` over the live path
 * truncates the target first, so a crash mid-restore leaves MEMORY.md
 * half-written — turning a recoverable bad pass into real data loss, in the
 * exact code path whose whole job is to prevent that.
 */
export async function restoreFromArchive(
  archivePath: string,
  absPath: string,
): Promise<void> {
  await writeFileAtomic(absPath, await readFile(archivePath, "utf8"));
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export type CompactionStatus = "compacted" | "unchanged" | "grew" | "reverted";

export interface CompactionOutcome {
  path: string;
  kind: CompactionKind;
  bytesBefore: number;
  bytesAfter: number;
  status: CompactionStatus;
  /** Why a pass was reverted, for the ledger and the operator. */
  note?: string;
}

/**
 * Judge one rewritten file.
 *
 * `grew` is not an error — a stage that decides a file was already minimal
 * and adds a clarifying line has done nothing harmful — but it IS recorded,
 * because a compaction pass that consistently grows its target is a prompt
 * bug worth seeing in the ledger.
 */
export function compactionVerdict(
  candidate: CompactionCandidate,
  bytesAfter: number,
): { status: CompactionStatus; note?: string } {
  if (bytesAfter === 0) {
    return { status: "reverted", note: "pass emptied the file" };
  }
  if (bytesAfter > candidate.sizeBytes) return { status: "grew" };
  if (bytesAfter === candidate.sizeBytes) return { status: "unchanged" };
  const removedPct =
    ((candidate.sizeBytes - bytesAfter) / candidate.sizeBytes) * 100;
  if (removedPct > candidate.maxShrinkPct) {
    return {
      status: "reverted",
      note: `pass removed ${removedPct.toFixed(1)}% (limit ${candidate.maxShrinkPct}%)`,
    };
  }
  return { status: "compacted" };
}

/**
 * Stat the rewritten file, judge it, and roll it back if the verdict says so.
 * A file that has vanished entirely is treated exactly like an emptied one.
 */
export async function settleCompaction(
  candidate: CompactionCandidate,
  archivePath: string,
): Promise<CompactionOutcome> {
  let bytesAfter = 0;
  try {
    bytesAfter = (await stat(candidate.absPath)).size;
  } catch {
    bytesAfter = 0;
  }
  const { status, note } = compactionVerdict(candidate, bytesAfter);
  if (status === "reverted") {
    await restoreFromArchive(archivePath, candidate.absPath);
    log.warn("nightly: compaction reverted", {
      path: candidate.path,
      before: candidate.sizeBytes,
      after: bytesAfter,
      note,
    });
    return {
      path: candidate.path,
      kind: candidate.kind,
      bytesBefore: candidate.sizeBytes,
      bytesAfter: candidate.sizeBytes,
      status,
      ...(note ? { note } : {}),
    };
  }
  return {
    path: candidate.path,
    kind: candidate.kind,
    bytesBefore: candidate.sizeBytes,
    bytesAfter,
    status,
    ...(note ? { note } : {}),
  };
}

/** One line per file, for the sweep's stdout. */
export function formatCompactionSummary(outcomes: CompactionOutcome[]): string {
  if (outcomes.length === 0)
    return "nightly: compaction — nothing over budget\n";
  const before = outcomes.reduce((n, o) => n + o.bytesBefore, 0);
  const after = outcomes.reduce((n, o) => n + o.bytesAfter, 0);
  const lines = outcomes.map(
    (o) =>
      `  ${o.path}: ${o.bytesBefore} → ${o.bytesAfter} bytes (${o.status}` +
      `${o.note ? ` — ${o.note}` : ""})`,
  );
  return (
    `nightly: compaction — ${outcomes.length} file(s), ${before} → ${after} bytes\n` +
    lines.join("\n") +
    "\n"
  );
}
