/**
 * Scheduled-task store. Lives in the same memory.sqlite as `turns` so a
 * persona's scheduled work and its conversation history can be queried
 * together (and so backups capture both atomically).
 *
 * Why not a separate database: tasks are persona-scoped, exactly like
 * memory. Sharing the connection means the SqliteMemoryStore.close()
 * already covers task-store cleanup at process exit, and we don't have
 * to manage two WAL files.
 *
 * Why a separate file from store.ts: the task surface is bigger
 * (CRUD + scheduling math) than the conversational turns surface, and
 * keeping them apart preserves the small + readable shape of store.ts.
 */

import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import {
  classifyCadence,
  defaultReviewIntervalMs,
  nextFire,
  validateCron,
} from "./cronSchedule.ts";

export interface Task {
  id: number;
  persona: string;
  description: string;
  /** 5-field cron for recurring; empty string for one-off. */
  schedule: string;
  prompt: string;
  createdAt: Date;
  lastRunAt?: Date;
  nextRunAt: Date;
  runCount: number;
  nextReviewAt: Date;
  reviewCount: number;
  active: boolean;
  /** True for one-shot tasks (created with --in or --at). */
  oneOff: boolean;
  /** When this recurring task expires (ISO). Null = no expiry. */
  expiresAt?: Date;
  /** Max number of runs for this recurring task. Null = no limit. */
  maxRuns?: number;
  /** If true, tick will NOT notify the user after firing. */
  silent: boolean;
  /** Conversation/channel that created this task (for daily-file audit). */
  createdBy: string;
}

export interface TaskRunRow {
  id: number;
  taskId: number;
  firedAt: Date;
  status: "ok" | "error";
  exitCode: number;
  outputExcerpt: string; // first 500 chars
  delivered: boolean; // whether notify was sent to user
}

export interface TaskAddInput {
  persona: string;
  description: string;
  /** 5-field cron expression (recurring) or empty string (one-off). */
  schedule: string;
  prompt: string;
  /** For one-off tasks: exact next-run time. Overrides schedule. */
  nextRunAt?: Date;
  /** Override review interval (ms from now). Default: scaled to schedule cadence. */
  reviewIntervalMs?: number;
  /** "Now" injection point — tests pass a fixed instant. Default: new Date(). */
  now?: Date;
  /** True for one-shot tasks. */
  oneOff?: boolean;
  /** Expiry for recurring tasks. */
  expiresAt?: Date;
  /** Max runs for recurring tasks. */
  maxRuns?: number;
  /** Suppress user notification after tick fire. */
  silent?: boolean;
  /** Channel/conversation that created this task. */
  createdBy?: string;
}

export type TaskAddResult =
  | { ok: true; id: number; task: Task }
  | { ok: false; error: string };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  persona         TEXT NOT NULL,
  description     TEXT NOT NULL,
  schedule        TEXT NOT NULL,
  prompt          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  last_run_at     TEXT,
  next_run_at     TEXT NOT NULL,
  run_count       INTEGER NOT NULL DEFAULT 0,
  next_review_at  TEXT NOT NULL,
  review_count    INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1,
  one_off         INTEGER NOT NULL DEFAULT 0,
  expires_at      TEXT,
  max_runs        INTEGER,
  silent          INTEGER NOT NULL DEFAULT 0,
  created_by      TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS task_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         INTEGER NOT NULL REFERENCES tasks(id),
  fired_at        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'ok',
  exit_code       INTEGER NOT NULL DEFAULT 0,
  output_excerpt  TEXT NOT NULL DEFAULT '',
  delivered       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tasks_persona_active_next
  ON tasks (persona, active, next_run_at);
CREATE INDEX IF NOT EXISTS idx_tasks_active_next
  ON tasks (active, next_run_at);
CREATE INDEX IF NOT EXISTS idx_task_runs_task_id
  ON task_runs (task_id);
`;

// Migration: add new columns if they don't exist.
const MIGRATIONS: string[] = [
  // v1 → v2: one-off + expiry + audit columns
  `ALTER TABLE tasks ADD COLUMN one_off INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE tasks ADD COLUMN expires_at TEXT`,
  `ALTER TABLE tasks ADD COLUMN max_runs INTEGER`,
  `ALTER TABLE tasks ADD COLUMN silent INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE tasks ADD COLUMN created_by TEXT NOT NULL DEFAULT ''`,
];

interface RawTaskRow {
  id: number;
  persona: string;
  description: string;
  schedule: string;
  prompt: string;
  created_at: string;
  last_run_at: string | null;
  next_run_at: string;
  run_count: number;
  next_review_at: string;
  review_count: number;
  active: number;
  one_off: number;
  expires_at: string | null;
  max_runs: number | null;
  silent: number;
  created_by: string;
}

function rowToTask(r: RawTaskRow): Task {
  return {
    id: r.id,
    persona: r.persona,
    description: r.description,
    schedule: r.schedule,
    prompt: r.prompt,
    createdAt: new Date(r.created_at),
    lastRunAt: r.last_run_at ? new Date(r.last_run_at) : undefined,
    nextRunAt: new Date(r.next_run_at),
    runCount: r.run_count,
    nextReviewAt: new Date(r.next_review_at),
    reviewCount: r.review_count,
    active: r.active === 1,
    oneOff: r.one_off === 1,
    expiresAt: r.expires_at ? new Date(r.expires_at) : undefined,
    maxRuns: r.max_runs ?? undefined,
    silent: r.silent === 1,
    createdBy: r.created_by,
  };
}

export class TaskStore {
  constructor(
    private db: Database,
    private ownsConnection = false,
  ) {
    db.exec(SCHEMA);
    this.applyMigrations();
  }

  private applyMigrations(): void {
    // Check which columns exist by querying a limited row.
    try {
      const row = this.db
        .prepare("SELECT one_off, expires_at, max_runs, silent, created_by FROM tasks LIMIT 1")
        .get() as Record<string, unknown> | null;
      // If we got here without error, columns exist.
      void row;
    } catch {
      // Columns missing — run migrations.
      for (const sql of MIGRATIONS) {
        try {
          this.db.exec(sql);
        } catch {
          // Column already exists (idempotent).
        }
      }
    }
  }

  /**
   * Close the connection if we own it (i.e. opened via openTaskStore).
   * Safe to call when sharing a connection — silently no-ops in that case.
   */
  close(): void {
    if (this.ownsConnection) this.db.close();
  }

  /**
   * Create a task. For recurring tasks, validates the cron expression.
   * For one-off tasks, schedule is optional and nextRunAt is required.
   */
  add(input: TaskAddInput): TaskAddResult {
    const now = input.now ?? new Date();
    const oneOff = input.oneOff ?? false;

    let next: Date;
    if (oneOff) {
      next = input.nextRunAt ?? now;
    } else {
      const v = validateCron(input.schedule);
      if (!v.ok) return { ok: false, error: `bad cron: ${v.error}` };
      next = nextFire(input.schedule, now);
    }

    const cadence = oneOff
      ? "daily"
      : classifyCadence(input.schedule, now);
    const reviewMs = input.reviewIntervalMs ?? defaultReviewIntervalMs(cadence);
    const review = new Date(now.getTime() + reviewMs);

    const silent = input.silent ?? false;
    const createdBy = input.createdBy ?? "";

    const stmt = this.db.prepare(
      `INSERT INTO tasks (
         persona, description, schedule, prompt,
         created_at, next_run_at, next_review_at, active,
         one_off, expires_at, max_runs, silent, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    );
    const result = stmt.run(
      input.persona,
      input.description,
      input.schedule,
      input.prompt,
      now.toISOString(),
      next.toISOString(),
      review.toISOString(),
      oneOff ? 1 : 0,
      input.expiresAt?.toISOString() ?? null,
      input.maxRuns ?? null,
      silent ? 1 : 0,
      createdBy,
    );
    const id = Number(result.lastInsertRowid);
    const task = this.get(id);
    if (!task) {
      return { ok: false, error: `task ${id} not found after insert` };
    }
    return { ok: true, id, task };
  }

  get(id: number): Task | undefined {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(id) as RawTaskRow | null;
    return row ? rowToTask(row) : undefined;
  }

  list(persona: string, opts: { includeInactive?: boolean } = {}): Task[] {
    const rows = opts.includeInactive
      ? (this.db
          .prepare(
            "SELECT * FROM tasks WHERE persona = ? ORDER BY active DESC, next_run_at ASC",
          )
          .all(persona) as RawTaskRow[])
      : (this.db
          .prepare(
            "SELECT * FROM tasks WHERE persona = ? AND active = 1 ORDER BY next_run_at ASC",
          )
          .all(persona) as RawTaskRow[]);
    return rows.map(rowToTask);
  }

  /** All tasks across all personas that are active and due to fire by `as_of`. */
  due(asOf: Date): Task[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM tasks WHERE active = 1 AND next_run_at <= ? ORDER BY next_run_at ASC",
      )
      .all(asOf.toISOString()) as RawTaskRow[];
    return rows.map(rowToTask);
  }

  cancel(id: number): boolean {
    const r = this.db
      .prepare("UPDATE tasks SET active = 0 WHERE id = ?")
      .run(id);
    return r.changes > 0;
  }

  /**
   * Mark a task as having run. Updates last_run_at to `now`, increments
   * run_count, and recomputes next_run_at strictly AFTER `now` per the
   * schedule. We use AFTER `now` (not after the previous `next_run_at`)
   * because of the "skip missed runs" rule the user picked: if the box
   * was off for 5 hours, we don't want to fire a backlog.
   *
   * For one-off tasks: deactivates the task after this run.
   * For recurring with maxRuns: deactivates if runCount >= maxRuns.
   */
  recordRun(id: number, now: Date = new Date()): void {
    const t = this.get(id);
    if (!t) return;

    const nextRunCount = t.runCount + 1;

    // Check maxRuns — deactivate if hit.
    if (t.maxRuns !== undefined && nextRunCount >= t.maxRuns) {
      this.db
        .prepare(
          `UPDATE tasks
           SET last_run_at = ?, run_count = ?, active = 0
           WHERE id = ?`,
        )
        .run(now.toISOString(), nextRunCount, id);
      return;
    }

    // One-off: deactivate after single run.
    if (t.oneOff) {
      this.db
        .prepare(
          `UPDATE tasks
           SET last_run_at = ?, run_count = ?, active = 0
           WHERE id = ?`,
        )
        .run(now.toISOString(), nextRunCount, id);
      return;
    }

    // Recurring: advance next_run_at.
    const next = nextFire(t.schedule, now);
    this.db
      .prepare(
        `UPDATE tasks
         SET last_run_at = ?, next_run_at = ?, run_count = run_count + 1
         WHERE id = ?`,
      )
      .run(now.toISOString(), next.toISOString(), id);
  }

  /**
   * Record a self-review outcome. KEEP doubles the next review interval
   * (so quietly-useful tasks stop nagging); STOP deactivates the task.
   * MODIFY isn't represented here — the agent issues a normal `cancel`
   * + `add` pair when modifying.
   */
  recordReview(
    id: number,
    decision: "keep" | "stop",
    now: Date = new Date(),
  ): void {
    const t = this.get(id);
    if (!t) return;
    if (decision === "stop") {
      this.db
        .prepare(
          "UPDATE tasks SET active = 0, review_count = review_count + 1 WHERE id = ?",
        )
        .run(id);
      return;
    }
    // keep: double the previous interval, capped at 365d so reviews don't
    // disappear off the calendar entirely.
    const prevIntervalMs = Math.max(
      t.nextReviewAt.getTime() - t.createdAt.getTime(),
      24 * 60 * 60 * 1000,
    );
    const nextIntervalMs = Math.min(
      prevIntervalMs * 2,
      365 * 24 * 60 * 60 * 1000,
    );
    const nextReview = new Date(now.getTime() + nextIntervalMs);
    this.db
      .prepare(
        "UPDATE tasks SET next_review_at = ?, review_count = review_count + 1 WHERE id = ?",
      )
      .run(nextReview.toISOString(), id);
  }

  /**
   * Log a fire event in the task_runs table. Called by the tick after
   * each task execution for full auditability.
   */
  logRun(input: {
    taskId: number;
    firedAt: Date;
    status: "ok" | "error";
    exitCode: number;
    outputExcerpt: string;
    delivered: boolean;
  }): void {
    this.db
      .prepare(
        `INSERT INTO task_runs (task_id, fired_at, status, exit_code, output_excerpt, delivered)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.taskId,
        input.firedAt.toISOString(),
        input.status,
        input.exitCode,
        input.outputExcerpt.slice(0, 500),
        input.delivered ? 1 : 0,
      );
  }

  /**
   * Return all runs for a task, most recent first.
   */
  taskRuns(taskId: number): TaskRunRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM task_runs WHERE task_id = ? ORDER BY fired_at DESC LIMIT 50",
      )
      .all(taskId) as (Omit<TaskRunRow, "firedAt"> & { fired_at: string })[];
    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      firedAt: new Date(r.fired_at),
      status: r.status,
      exitCode: r.exit_code,
      outputExcerpt: r.output_excerpt,
      delivered: r.delivered,
    }));
  }

  /**
   * Deactivate any active tasks whose expires_at has passed.
   * Called by the tick before checking due tasks.
   */
  expireStaleTasks(now: Date = new Date()): number {
    const result = this.db
      .prepare(
        "UPDATE tasks SET active = 0 WHERE active = 1 AND expires_at IS NOT NULL AND expires_at <= ?",
      )
      .run(now.toISOString());
    return result.changes;
  }

  /**
   * Create a selftest task: fires in 60s and calls phantombot notify.
   * Returns the task id for verification.
   */
  selftest(persona: string, now: Date = new Date()): { id: number; firesAt: Date } {
    const firesAt = new Date(now.getTime() + 60_000);
    const stmt = this.db.prepare(
      `INSERT INTO tasks (
         persona, description, schedule, prompt,
         created_at, next_run_at, next_review_at, active,
         one_off, expires_at, max_runs, silent, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, NULL, NULL, 0, ?)`,
    );
    const result = stmt.run(
      persona,
      "selftest",
      "",
      "This is a phantombot scheduler selftest. Reply with only: 'SELFTEST OK — ' followed by the current time. Then exit.",
      now.toISOString(),
      firesAt.toISOString(),
      new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      "selftest",
    );
    return { id: Number(result.lastInsertRowid), firesAt };
  }
}

/**
 * Open a TaskStore by path. Creates parent dirs if needed and runs the
 * schema. Sharing the file with memory.sqlite is safe (WAL mode), so
 * the conventional caller passes `config.memoryDbPath`.
 *
 * Caller must call `.close()` on the returned TaskStore when done.
 */
export async function openTaskStore(path: string): Promise<TaskStore> {
  if (path !== ":memory:") {
    await mkdir(dirname(path), { recursive: true });
  }
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  return new TaskStore(db, /* ownsConnection */ true);
}
