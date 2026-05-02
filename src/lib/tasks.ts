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
  schedule: string;
  prompt: string;
  createdAt: Date;
  lastRunAt?: Date;
  nextRunAt: Date;
  runCount: number;
  nextReviewAt: Date;
  reviewCount: number;
  active: boolean;
}

export interface TaskAddInput {
  persona: string;
  description: string;
  /** 5-field cron expression. Validated; rejects on bad input. */
  schedule: string;
  prompt: string;
  /** Override review interval (ms from now). Default: scaled to schedule cadence. */
  reviewIntervalMs?: number;
  /** "Now" injection point — tests pass a fixed instant. Default: new Date(). */
  now?: Date;
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
  active          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_tasks_persona_active_next
  ON tasks (persona, active, next_run_at);
CREATE INDEX IF NOT EXISTS idx_tasks_active_next
  ON tasks (active, next_run_at);
`;

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
  };
}

export class TaskStore {
  constructor(
    private db: Database,
    private ownsConnection = false,
  ) {
    db.exec(SCHEMA);
  }

  /**
   * Close the connection if we own it (i.e. opened via openTaskStore).
   * Safe to call when sharing a connection — silently no-ops in that case.
   */
  close(): void {
    if (this.ownsConnection) this.db.close();
  }

  /**
   * Create a task. Validates the cron expression up front so we don't
   * persist a row the tick loop would later refuse to evaluate.
   */
  add(input: TaskAddInput): TaskAddResult {
    const v = validateCron(input.schedule);
    if (!v.ok) return { ok: false, error: `bad cron: ${v.error}` };
    const now = input.now ?? new Date();
    const next = nextFire(input.schedule, now);
    const cadence = classifyCadence(input.schedule, now);
    const reviewMs = input.reviewIntervalMs ?? defaultReviewIntervalMs(cadence);
    const review = new Date(now.getTime() + reviewMs);
    const stmt = this.db.prepare(
      `INSERT INTO tasks (
         persona, description, schedule, prompt,
         created_at, next_run_at, next_review_at, active
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    );
    const result = stmt.run(
      input.persona,
      input.description,
      input.schedule,
      input.prompt,
      now.toISOString(),
      next.toISOString(),
      review.toISOString(),
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
   */
  recordRun(id: number, now: Date = new Date()): void {
    const t = this.get(id);
    if (!t) return;
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
