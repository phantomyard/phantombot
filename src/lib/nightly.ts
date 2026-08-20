/**
 * Nightly cognitive pass.
 *
 * Every run is a SWEEP: phantombot lists the daily files on disk, compares
 * each one against the ledger in `memory/.nightly-state.json` (mtime + content
 * hash), and processes every date that has never been processed or has grown
 * since it was. There is no catch-up mode, no resume flag and no separate
 * repair path — a box that was asleep at 02:00 simply sweeps a longer backlog
 * the next time the pass runs, and a re-run with nothing pending is free.
 *
 * Each pending date is processed by exactly TWO harness turns, run
 * CONCURRENTLY because they write to disjoint targets:
 *
 *   1. distill — file the day's captures the heartbeat missed into the
 *      structured drawers (people / decisions / lessons / commitments /
 *      norms) and maintain MEMORY.md's "## Recent" orientation layer.
 *   2. kb      — extract durable knowledge into kb/: reconcile against
 *      existing notes, create new atomic notes, sweep kb/inbox/.
 *
 * Neither stage writes back to the daily file — that is what keeps the
 * ledger's hash stable, so "hash changed" means "genuinely more content".
 *
 * The search-index refresh that used to be a line in the KB prompt is now
 * done by the driver in code after both stages join (see
 * `refreshPersonaIndex`): deterministic work does not belong behind a
 * probabilistic trigger, and doing it once after the join closes the race
 * between the KB writes and the drawer writes.
 *
 * Conversation key is `system:nightly:<YYYY-MM-DD>` so the pass can never
 * bleed into Telegram chats, and both stages for a date share context.
 */

import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./logger.ts";
import {
  isProcessAlive,
  processStartToken,
  type ProcessAliveProbe,
  type ProcessStartProbe,
} from "./processLiveness.ts";
import { OKF_AGENT_TYPES, OKF_CORE_TYPES } from "./okf.ts";
import type {
  CompactionCandidate,
  CompactionOutcome,
} from "./nightlyCompact.ts";

const NIGHTLY_PROMPT_OVERRIDE = "nightly-prompt.md";

/** Daily files are named strictly `YYYY-MM-DD.md` under `memory/`. */
const DAILY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;

/**
 * A sweep that hasn't touched its `current` block in this long is treated as
 * dead (crashed process, powered-off box) rather than running. Generous: one
 * date is two concurrent turns, each capped at the stage hard timeout.
 */
export const STALE_RUN_MS = 45 * 60_000;

/**
 * A backlog is work queued, not a fault — however deep it is, it reads as a
 * warning while it drains. It only turns into an error once it is STAGNANT:
 * dates are pending and no sweep has run in this long, which means the thing
 * that triggers sweeps is broken rather than merely behind.
 */
export const BACKLOG_STAGNANT_MS = 24 * 60 * 60_000;

// ---------------------------------------------------------------------------
// Stage model
// ---------------------------------------------------------------------------

/**
 * The two stages of a nightly pass. Split by OUTPUT target, not input: both
 * read the same daily file, `distill` writes drawers + MEMORY.md and `kb`
 * writes kb/. Kept separate (rather than merged into one cheaper turn)
 * because the KB stage's search-read-reconcile work degrades badly when it
 * shares a turn with mechanical filing.
 */
export type NightlyStage = "distill" | "kb";

export const NIGHTLY_STAGES: readonly NightlyStage[] = [
  "distill",
  "kb",
] as const;

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/** What the ledger remembers about one processed date. */
export interface NightlyDateRecord {
  /** mtime of the daily file at the moment it was processed. */
  mtime_ms: number;
  /** Byte size when processed — paired with mtime for the cheap skip path. */
  size: number;
  /** sha256 of the daily file's bytes when processed (hex). */
  hash: string;
  /** Stages that completed for this date. */
  stages_done: NightlyStage[];
  completed_at: string;
  status: "ok" | "partial" | "error";
  /** First stage error, if the date didn't fully succeed. */
  error?: string;
}

/** Progress marker for a sweep that is running right now. Feeds `/status`. */
export interface NightlyCurrent {
  /** Date being processed at this instant. */
  date: string;
  /** 1-based position of that date within this sweep. */
  index: number;
  /** Total dates this sweep intends to process. */
  total: number;
  started_at: string;
  /** Refreshed as each date starts — drives stale-run detection. */
  updated_at: string;
  pid?: number;
  /**
   * OS-supplied start time of `pid`, used to spot pid REUSE (issue #402
   * follow-up). Absent on markers written by an older build, and on
   * platforms with no cheap probe — liveness degrades to the pid check.
   */
  pid_start?: string;
}

export interface NightlyState {
  last_run?: string;
  last_status?: "ok" | "error" | "partial";
  items_promoted?: number;
  kb_notes_updated?: number;
  kb_notes_created?: number;
  errors?: string[];
  /** date (YYYY-MM-DD) → what was done for it. The idempotency ledger. */
  processed?: Record<string, NightlyDateRecord>;
  /** Set while a sweep is in flight; cleared when it finishes. */
  current?: NightlyCurrent | null;
  /**
   * What the last compaction pass did, per file (issue #410). Byte accounting
   * lives in the ledger rather than only in the log so `doctor` and a human
   * can both answer "is memory still growing?" without grepping journald.
   */
  compaction?: NightlyCompactionRecord;
}

/** Outcome of one whole compaction pass. */
export interface NightlyCompactionRecord {
  ran_at: string;
  /** Where the pre-compaction copies of these files live. */
  archive_dir: string;
  files: CompactionOutcome[];
  /** Total bytes before/after across every file the pass touched. */
  bytes_before: number;
  bytes_after: number;
}

/**
 * What a sweep marker actually means right now.
 *
 * - `running` — the owner is alive and beating; a new sweep must stand down.
 * - `dead`    — the owner process is GONE; the marker is a corpse, take over.
 * - `stalled` — the owner may still exist but hasn't beaten in STALE_RUN_MS;
 *               take over (the pre-existing, time-only rule).
 */
export type SweepLiveness = "running" | "dead" | "stalled";

/**
 * Pid-liveness primitives (#403) now live in `lib/processLiveness.ts` — issue
 * #391 needs the identical check for in-flight TURNS, and one copy of a
 * kernel-probe is the only supportable number. Re-exported here so existing
 * importers (and the #403 tests) keep working unchanged.
 */
export {
  isProcessAlive,
  processStartToken,
  selfStartToken,
  type ProcessAliveProbe,
  type ProcessStartProbe,
} from "./processLiveness.ts";

/**
 * Classify an in-flight marker (issue #402).
 *
 * THE BUG: liveness used to be time-only — a marker younger than
 * STALE_RUN_MS was assumed to be a running sweep. When the daemon is killed
 * mid-sweep (a crash, a restart, systemd taking down the cgroup) the child
 * dies with it and leaves a marker seconds old. The very next start spawns a
 * sweep, sees that fresh-looking marker, and stands down — DEFERRING TO A
 * CORPSE. Nothing else fires until the next UTC day rollover, so the backlog
 * sits untouched for up to a day, reported as `sweep stalled` only after the
 * 45 minutes have elapsed. Observed on three separate boxes.
 *
 * THE FIX: the marker already records `pid`. A dead owner is dead the instant
 * we look, whatever the clock says, so check the process first and fall back
 * to the clock only for markers written by an older build (no `pid`) or an
 * owner that is alive but wedged.
 */
export function sweepLiveness(
  current: NightlyCurrent,
  now: Date,
  isAlive: ProcessAliveProbe = isProcessAlive,
  startToken: ProcessStartProbe = processStartToken,
): SweepLiveness {
  if (typeof current.pid === "number") {
    if (!isAlive(current.pid)) return "dead";
    // Alive, but is it the SAME process? A pid that has wrapped around to an
    // unrelated process would otherwise hold the lock until the 45-minute
    // stall timer expires. A null token means "can't tell" — trust the pid.
    if (current.pid_start) {
      const seen = startToken(current.pid);
      if (seen !== null && seen !== current.pid_start) return "dead";
    }
  }
  const beat = Date.parse(current.updated_at ?? current.started_at);
  const fresh = !Number.isNaN(beat) && now.getTime() - beat <= STALE_RUN_MS;
  return fresh ? "running" : "stalled";
}

/** Conversation-key namespace for the sweep's own turns. */
export const NIGHTLY_CONVERSATION_PREFIX = "system:nightly:";

export function nightlyConversationKey(date: string): string {
  return `${NIGHTLY_CONVERSATION_PREFIX}${date}`;
}

/** Is this conversation one of the nightly sweep's own (any stage suffix)? */
export function isNightlyConversation(conversation: string): boolean {
  return conversation.startsWith(NIGHTLY_CONVERSATION_PREFIX);
}

/**
 * Does the LEDGER RECORD claim this date is fully distilled? `ok` plus every
 * stage. Says nothing about whether the file has changed since — see
 * `isDailyDistilled` for the fingerprint-aware answer.
 */
export function recordDistilled(
  rec: NightlyDateRecord | undefined,
): rec is NightlyDateRecord {
  return (
    rec !== undefined &&
    rec.status === "ok" &&
    NIGHTLY_STAGES.every((s) => rec.stages_done.includes(s))
  );
}

/**
 * Is this date's content actually represented in the drawers/KB right now?
 *
 * The record alone is not enough: a daily file APPENDED TO after its sweep
 * (`memory capture --date`, a late tick) holds content that was never
 * promoted anywhere, and the sweep itself re-queues exactly that case off the
 * mtime+size fingerprint. Every consumer of "is this day done?" must apply
 * the same test or they disagree — the prompt would drop a day the sweep
 * still considers unfinished. One predicate, three callers.
 *
 * A file that cannot be stat'ed (gone, unreadable) is NOT distilled: there is
 * nothing to inject either way, and the callers report that case themselves.
 */
export async function isDailyDistilled(
  path: string,
  rec: NightlyDateRecord | undefined,
): Promise<boolean> {
  if (!recordDistilled(rec)) return false;
  try {
    const st = await stat(path);
    return rec.mtime_ms === Math.floor(st.mtimeMs) && rec.size === st.size;
  } catch {
    return false;
  }
}

export function nightlyStatePath(personaDir: string): string {
  return join(personaDir, "memory", ".nightly-state.json");
}

/** Absolute path of one daily file. The filename IS the primary key. */
export function dailyFilePath(personaDir: string, date: string): string {
  return join(personaDir, "memory", `${date}.md`);
}

/** Read the ledger. Returns {} if no prior run (or an unreadable file). */
export async function loadNightlyState(
  personaDir: string,
): Promise<NightlyState> {
  const p = nightlyStatePath(personaDir);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(await readFile(p, "utf8")) as NightlyState;
  } catch (e) {
    log.warn("nightly: state file unreadable; treating as empty", {
      error: (e as Error).message,
    });
    return {};
  }
}

/**
 * Merge a patch into the ledger and write it back. `processed` is merged
 * key-by-key so a patch carrying one date never drops the rest of history;
 * `current: null` explicitly clears the in-flight marker.
 */
export async function saveNightlyState(
  personaDir: string,
  patch: Partial<NightlyState>,
): Promise<void> {
  const cur = await loadNightlyState(personaDir);
  const next: NightlyState = {
    ...cur,
    ...patch,
    processed: { ...(cur.processed ?? {}), ...(patch.processed ?? {}) },
  };
  if (patch.current === null) delete next.current;
  await writeFile(
    nightlyStatePath(personaDir),
    JSON.stringify(next, null, 2) + "\n",
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

/** A daily file the sweep has decided needs (re)processing. */
export interface PendingDate {
  date: string;
  path: string;
  mtime_ms: number;
  size: number;
  hash: string;
  /** Why it's pending: never seen, content grew, or last pass didn't finish. */
  reason: "new" | "changed" | "incomplete";
}

export interface SweepResult {
  /** Dates needing harness turns, oldest first. */
  pending: PendingDate[];
  /**
   * Dates whose file was touched (mtime moved) but whose CONTENT is
   * unchanged — the ledger's mtime is refreshed for free, no turn spent.
   */
  touched: Array<{ date: string; mtime_ms: number; size: number }>;
  /** Every date file seen on disk, oldest first. */
  seen: string[];
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

/**
 * Reconcile the daily files on disk against the ledger.
 *
 * `before` is exclusive: the day still being written to (today) is never
 * swept, because the drawers would be filed from a half-finished file and
 * the hash would change minutes later anyway.
 *
 * Cost control: a date whose ledger mtime still matches `stat` is skipped
 * without reading the file at all, so a ten-year archive costs one `readdir`
 * plus N `stat`s. Only files whose mtime moved get hashed — and a hash that
 * matches means the file was merely touched, not changed.
 */
export async function sweepDailyFiles(
  personaDir: string,
  state: NightlyState,
  before: string,
): Promise<SweepResult> {
  const memDir = join(personaDir, "memory");
  const pending: PendingDate[] = [];
  const touched: Array<{ date: string; mtime_ms: number; size: number }> = [];
  const seen: string[] = [];
  if (!existsSync(memDir)) return { pending, touched, seen };

  const entries = (await readdir(memDir))
    .map((f) => ({ file: f, m: DAILY_FILE_RE.exec(f) }))
    .filter((e): e is { file: string; m: RegExpExecArray } => e.m !== null)
    .map((e) => e.m[1]!)
    .filter((d) => d < before)
    .sort();

  const ledger = state.processed ?? {};
  for (const date of entries) {
    seen.push(date);
    const path = join(memDir, `${date}.md`);
    let mtimeMs: number;
    let size: number;
    try {
      const st = await stat(path);
      mtimeMs = Math.floor(st.mtimeMs);
      size = st.size;
    } catch {
      continue; // vanished between readdir and stat — nothing to process
    }
    const rec = ledger[date];
    const done = recordDistilled(rec);

    // Fast path: mtime AND size both unchanged. Size is the belt to mtime's
    // braces — an append landing inside the same millisecond as the last
    // stat still moves the size, so a late capture can't hide from the sweep.
    if (done && rec.mtime_ms === mtimeMs && rec.size === size) continue;

    let hash: string;
    try {
      hash = await sha256File(path);
    } catch (e) {
      log.warn("nightly: daily file unreadable during sweep", {
        date,
        error: (e as Error).message,
      });
      continue;
    }
    if (done && rec.hash === hash) {
      touched.push({ date, mtime_ms: mtimeMs, size });
      continue;
    }
    pending.push({
      date,
      path,
      mtime_ms: mtimeMs,
      size,
      hash,
      reason: rec === undefined ? "new" : done ? "changed" : "incomplete",
    });
  }
  return { pending, touched, seen };
}

/**
 * Build a {@link PendingDate} for ONE explicit date, ignoring the ledger.
 * Backs `nightly --date` (backfill / debugging), which must reprocess a day
 * on demand without walking the whole archive. Returns null if there's no
 * daily file for that date.
 */
export async function pendingForDate(
  personaDir: string,
  date: string,
): Promise<PendingDate | null> {
  const path = dailyFilePath(personaDir, date);
  if (!existsSync(path)) return null;
  try {
    const st = await stat(path);
    return {
      date,
      path,
      mtime_ms: Math.floor(st.mtimeMs),
      size: st.size,
      hash: await sha256File(path),
      reason: "new",
    };
  } catch (e) {
    log.warn("nightly: daily file unreadable", {
      date,
      error: (e as Error).message,
    });
    return null;
  }
}

/** Build the ledger entry for a date the driver has just finished. */
export function dateRecord(
  p: PendingDate,
  stagesDone: NightlyStage[],
  error?: string,
): NightlyDateRecord {
  return {
    mtime_ms: p.mtime_ms,
    size: p.size,
    hash: p.hash,
    stages_done: stagesDone,
    completed_at: new Date().toISOString(),
    status: error ? (stagesDone.length > 0 ? "partial" : "error") : "ok",
    ...(error ? { error } : {}),
  };
}

// ---------------------------------------------------------------------------
// Health — the `/status` "dreaming:" line and `doctor`'s nightly section
// ---------------------------------------------------------------------------

export type NightlyHealthStatus = "ok" | "running" | "warning" | "error";

export interface NightlyHealth {
  status: NightlyHealthStatus;
  /** One short line, e.g. "2/5 dates, on 2026-06-02". */
  detail: string;
  /** Dates still needing a pass. */
  backlog: number;
  /** Oldest pending date, when there is one. */
  oldest_pending?: string;
  last_run?: string;
}

/**
 * Judge nightly health from the ledger + what's on disk.
 *
 * Deliberately schedule-agnostic: an always-on box that sweeps at 02:00 and a
 * laptop that sweeps at 09:15 on boot both read `ok` as long as nothing is
 * pending. Backlog is the only truth — "the timer didn't fire in its window"
 * is not a fault if there was nothing to do.
 */
export async function nightlyHealth(
  personaDir: string,
  opts: {
    now?: Date;
    state?: NightlyState;
    /** Test seam — override the process-liveness probe. */
    isAlive?: ProcessAliveProbe;
  } = {},
): Promise<NightlyHealth> {
  const now = opts.now ?? new Date();
  const state = opts.state ?? (await loadNightlyState(personaDir));
  const sweep = await sweepDailyFiles(
    personaDir,
    state,
    now.toISOString().slice(0, 10),
  );
  const backlog = sweep.pending.length;
  const oldest = sweep.pending[0]?.date;
  const base = {
    backlog,
    ...(oldest ? { oldest_pending: oldest } : {}),
    ...(state.last_run ? { last_run: state.last_run } : {}),
  };

  const cur = state.current;
  if (cur) {
    const liveness = sweepLiveness(cur, now, opts.isAlive);
    if (liveness === "running") {
      return {
        ...base,
        status: "running",
        detail: `${cur.index}/${cur.total} dates, on ${cur.date}`,
      };
    }
    const since = cur.updated_at ?? cur.started_at;
    return {
      ...base,
      status: "error",
      detail:
        liveness === "dead"
          ? `sweep died on ${cur.date} — owner pid ${cur.pid} is gone (last beat ${since})`
          : `sweep stalled on ${cur.date} since ${since}`,
    };
  }

  const failed = Object.entries(state.processed ?? {})
    .filter(([, r]) => r.status === "error" || r.status === "partial")
    .map(([d]) => d)
    .sort();

  if (state.last_status === "error") {
    return {
      ...base,
      status: "error",
      detail: `last sweep errored${state.errors?.[0] ? ` — ${state.errors[0]}` : ""}`,
    };
  }
  if (backlog > 0) {
    // Deep backlog is not itself a fault — a sweep drains it whole, so it is
    // simply work in the queue. The fault case is a backlog nobody is picking
    // up: pending dates and no sweep within BACKLOG_STAGNANT_MS.
    // A ledger with no `last_run` is a fresh install, not a stuck one — the
    // startup trigger stamps it within a minute of the process coming up, so
    // "never swept" is a warning and only an OLD sweep is an error.
    const last = state.last_run ? Date.parse(state.last_run) : NaN;
    if (!Number.isNaN(last) && now.getTime() - last > BACKLOG_STAGNANT_MS) {
      return {
        ...base,
        status: "error",
        detail: `${backlog} date${backlog === 1 ? "" : "s"} pending, no sweep since ${state.last_run}`,
      };
    }
    return {
      ...base,
      status: "warning",
      detail: `${backlog} date${backlog === 1 ? "" : "s"} pending (oldest ${oldest})`,
    };
  }
  if (failed.length > 0) {
    return {
      ...base,
      status: "warning",
      detail: `${failed.length} date(s) processed with errors (${failed.slice(-1)[0]})`,
    };
  }
  return {
    ...base,
    status: "ok",
    detail: state.last_run
      ? `nothing pending (last sweep ${state.last_run})`
      : "nothing pending",
  };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/**
 * If a persona dir contains a `nightly-prompt.md` file, use it as the
 * template (with `{{persona}}` and `{{today}}` substitutions); otherwise
 * fall back to the built-in {@link buildNightlyPrompt}. The override owns the
 * whole contract, so the driver runs it as ONE monolithic turn per date
 * instead of the two-stage split.
 */
export async function buildNightlyPromptForPersona(
  personaDir: string,
  personaName: string,
  today: string,
): Promise<string> {
  const overridePath = join(personaDir, NIGHTLY_PROMPT_OVERRIDE);
  if (existsSync(overridePath)) {
    try {
      const tpl = await readFile(overridePath, "utf8");
      return tpl
        .replace(/\{\{persona\}\}/g, personaName)
        .replace(/\{\{today\}\}/g, today);
    } catch (e) {
      log.warn("nightly: override unreadable, falling back to default", {
        path: overridePath,
        error: (e as Error).message,
      });
    }
  }
  return buildNightlyPrompt(personaName, today);
}

/** Shared preamble: what is being processed, isolation note, tools. */
function nightlyPreamble(personaName: string, today: string): string {
  return `You are running your nightly cognitive maintenance pass for persona '${personaName}'. Processing date: ${today} (a day that has closed).

This conversation is ISOLATED (conversation key system:nightly:${today}); nothing you say here will appear in Telegram or any user-facing chat. Speak in summaries, not replies.

You have access to phantombot's memory tools via Bash:

  phantombot memory get memory/${today}.md      # the daily file being processed (do NOT use 'memory today' — that resolves to the real current day, not ${today})
  phantombot memory search "<query>"            # FTS5 + (if configured) semantic search
  phantombot memory get <persona-relative-path> # cat a file
  phantombot memory list <persona-relative-dir> # ls a dir

You also have your normal Read / Write / Edit tools — use them on files inside this persona's working directory. The structured drawers are under memory/ and the KB vault under kb/.

Two rules that apply to every stage:
  - NEVER write to memory/${today}.md. Daily files are append-only inputs; phantombot tracks them by content hash and an edit here makes the day look unprocessed forever.
  - Do NOT run \`phantombot memory index\`. Phantombot refreshes the index itself in code once your stage and its sibling have both finished.`;
}

/** Per-stage instruction body. */
const NIGHTLY_STAGE_BODY: Record<NightlyStage, (today: string) => string> = {
  distill: (today) => `STAGE: DISTILL (drawers + MEMORY.md)

You are running ONE of two concurrent stages. Yours writes to the structured
drawers and MEMORY.md — nothing else. A sibling turn is handling kb/ right
now, so do not touch kb/ files.

1. Read the daily file (memory/${today}.md). If it is missing or empty, say so
   and make no edits.
2. FILE the promote-able items the heartbeat has not already picked up:
     - People / relationships   → memory/people.md
     - Decisions with rationale → memory/decisions.md
     - Mistakes and learnings   → memory/lessons.md
     - Deadlines / obligations  → memory/commitments.md
     - What is ROUTINE in your owner's world → memory/norms.md
   Append under a "## ${today}" header. Do not duplicate what is already filed —
   read the drawer first.
3. MAINTAIN MEMORY.md — the always-in-context orientation layer. Fill AND trim:
     - FILL: add a few SHORT one-line bullets under "## Recent" for durable,
       still-relevant facts worth having in context every turn. Summarise and
       point at the drawer or KB note holding the detail; never paste entries.
     - TRIM: remove "## Recent" bullets that are stale or now have a permanent
       home. If a section has bloated into prose, move the detail into a KB
       note and leave a one-line pointer.
Finish with a one-line summary of what you filed.`,

  kb: (today) => `STAGE: KB (durable knowledge)

You are running ONE of two concurrent stages. Yours writes to kb/ — nothing
else. A sibling turn is filing drawers and MEMORY.md right now, so do not
touch memory/ files.

Read the daily file (memory/${today}.md) for durable knowledge (procedures,
configs, runbooks, concepts, decisions worth keeping). For each candidate:
  a) Search for existing coverage — and search it from MORE THAN ONE ANGLE.
     Run \`phantombot memory search\` two or three times per candidate, varying
     the vocabulary: the symptom as you'd describe it today, the component or
     service name, and the literal error string or command. Today's wording and
     the existing note's wording are often disjoint ("CI agents refusing jobs"
     vs "runner version deprecated"), and a single-phrase search will miss the
     note you are about to duplicate. A duplicate is worse than a long search:
     it splits one truth across two notes and dilutes every future query.
  b) If a note already covers the area, open it and RECONCILE — don't just append:
     - ADDS (new case, edge case, link): update in place.
     - CONTRADICTS / INVALIDATES it (a fact changed, something was decommissioned,
       an old assumption proved wrong): rewrite the body so it states the CURRENT
       truth, bump \`updated:\`, and append a dated line under a "## Changelog"
       section — "${today}: was X → now Y, because Z". Don't leave the stale claim
       standing beside the new one; the old belief survives only as history.
     - Whole subject DECOMMISSIONED: set frontmatter \`status: obsolete\` with a
       dated one-line reason (+ [[wikilink]] to any replacement) instead of deleting.
  c) Otherwise create a new atomic note in the right kb/<category>/ subdir from a
     kb/templates/ scaffold. OKF frontmatter, all of it required:
       type         — one of: ${OKF_CORE_TYPES.join(" | ")}
                              ${OKF_AGENT_TYPES.join(" | ")}
                      Pick the closest. Never invent a new type.
       title        — what the note is
       description  — one sentence: the question this note answers
       tags         — [lowercase-hyphenated]
       aliases      — [other names for this thing, including the wrong-but-
                      plausible ones someone might search for later]
       created / updated — YYYY-MM-DD
     Then LINK IT: every new note gets [[wikilinks]] to its nearest existing
     neighbours, and where a neighbour should point back, add the return link
     too. Recall expands outward along this graph from a lexical match, so an
     unlinked note is reachable only by exact wording — you are not decorating
     the note, you are wiring it into the index. A note with no links is a note
     you will fail to find.
Then sweep kb/inbox/: file each stub into the right category, or delete it if it
is no longer relevant.
Finish with a one-line summary of notes created / updated.`,
};

/** Build the user-message for ONE nightly stage. */
export function buildNightlyStagePrompt(
  personaName: string,
  today: string,
  stage: NightlyStage,
): string {
  return `${nightlyPreamble(personaName, today)}

${NIGHTLY_STAGE_BODY[stage](today)}`;
}

/**
 * Monolithic prompt — used only for the persona-override path, where a custom
 * `nightly-prompt.md` is absent but the override machinery still asks for a
 * single-turn prompt. Same two jobs, one turn.
 */
export function buildNightlyPrompt(personaName: string, today: string): string {
  return `${nightlyPreamble(personaName, today)}

Run BOTH stages below, in order, in this single turn.

${NIGHTLY_STAGE_BODY.distill(today)}

${NIGHTLY_STAGE_BODY.kb(today)}`;
}

// ---------------------------------------------------------------------------
// Compaction prompt (issue #410)
// ---------------------------------------------------------------------------

/**
 * Per-kind instructions for the compaction pass. Written as REMOVAL rules
 * with an explicit "when in doubt, keep it" default, because the failure mode
 * that matters is losing a fact, not leaving a file 5% too big.
 *
 * The `drawer` entry is defensive only — drawers are not selected as
 * candidates (see measureDrawers), because their dedupe/merge lifecycle moves
 * to the database in the follow-up work and an LLM pass over them now would be
 * built twice. It survives so a hand-built candidate can never reach the
 * prompt without an instruction.
 */
const COMPACTION_KIND_BODY: Record<CompactionCandidate["kind"], string> = {
  memory: `MEMORY.md is loaded into context on EVERY turn, so every byte is
    rent. Prune it: drop "## Recent" bullets that are stale, superseded, or now
    have a permanent home in a drawer or KB note; collapse anything that has
    bloated into prose down to one line plus a [[pointer]]. Do NOT remove
    standing facts about your owner, trust rules, or infrastructure state that
    has no home elsewhere — move those, don't delete them.`,
  drawer: `Do NOT rewrite this file, and do not read it. Its dedupe and
    lifecycle work is moving to the database, so any edit here would be undone.
    Leave it exactly as it is.`,
  daily: `This day is CLOSED and fully distilled — every stage completed and its
    contents are already filed in the drawers and the KB. Reduce it to: the
    date heading, the items that were promoted (one line each), and any
    capture lines. Drop transcript-shaped narration, tool output and
    working-notes. If you cannot tell whether something was promoted, keep it.`,
};

/**
 * Build the compaction stage prompt. Runs ONCE per sweep (not once per date)
 * because its inputs are whole-file sizes, not a day's events.
 */
export function buildCompactionPrompt(
  personaName: string,
  today: string,
  candidates: CompactionCandidate[],
  archiveDir: string,
): string {
  const list = candidates
    .map(
      (c) =>
        `  - ${c.path} — ${c.sizeBytes} bytes (budget ${c.budgetBytes})\n` +
        `    ${COMPACTION_KIND_BODY[c.kind].replace(/\s+/g, " ").trim()}`,
    )
    .join("\n");
  return `${nightlyPreamble(personaName, today)}

STAGE: COMPACT (shrink what has grown past its budget)

The distill and kb stages only append. This stage is the other half: it removes
what is dead, duplicated, or has a permanent home elsewhere. It runs alone —
no sibling stage is writing right now.

Every file below has ALREADY been copied verbatim to ${archiveDir}, so a
mistake is recoverable. Do not read, write or clean up that directory.

Files over budget:
${list}

Rules that apply to all of them:
  - Rewrite a file IN PLACE. Never delete a file, never move one, never create
    a new file to replace one.
  - Keep the file's existing shape: same headings, same ordering, same style.
    A reader should see the same document with less in it.
  - A pass that removes more than its allowance is automatically reverted by
    phantombot, so aim to prune, not to rebuild from scratch.
  - When you are unsure whether something is still live, KEEP IT. Another
    night will get it.

Finish with one line per file: path, roughly what you removed, and what you
deliberately kept.`;
}
