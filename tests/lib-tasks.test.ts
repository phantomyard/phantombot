import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTaskStore, type TaskStore } from "../src/lib/tasks.ts";

let workdir: string;
let store: TaskStore;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-tasks-"));
  store = await openTaskStore(join(workdir, "tasks.sqlite"));
});

afterEach(async () => {
  store.close();
  await rm(workdir, { recursive: true, force: true });
});

const NOW = new Date("2026-05-02T09:30:00Z");

describe("TaskStore.add", () => {
  test("happy path: persists + computes next_run_at + next_review_at", () => {
    const r = store.add({
      persona: "phantom",
      description: "hourly email",
      schedule: "0 * * * *",
      prompt: "check email",
      now: NOW,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.task.persona).toBe("phantom");
    expect(r.task.description).toBe("hourly email");
    expect(r.task.schedule).toBe("0 * * * *");
    expect(r.task.runCount).toBe(0);
    expect(r.task.active).toBe(true);
    // Next run is the top of the next hour after NOW (10:00).
    expect(r.task.nextRunAt.toISOString()).toBe("2026-05-02T10:00:00.000Z");
    // Default review interval for hourly = 14d.
    const days = Math.round(
      (r.task.nextReviewAt.getTime() - NOW.getTime()) / (24 * 60 * 60 * 1000),
    );
    expect(days).toBe(14);
  });

  test("rejects garbage cron expressions", () => {
    const r = store.add({
      persona: "phantom",
      description: "junk",
      schedule: "not a cron",
      prompt: "x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("bad cron");
  });

  test("explicit reviewIntervalMs override", () => {
    const r = store.add({
      persona: "phantom",
      description: "x",
      schedule: "0 * * * *",
      prompt: "x",
      reviewIntervalMs: 60_000,
      now: NOW,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.task.nextReviewAt.toISOString()).toBe("2026-05-02T09:31:00.000Z");
  });
});

describe("TaskStore.list / get", () => {
  test("list returns active tasks ordered by next_run_at", () => {
    store.add({
      persona: "phantom",
      description: "later",
      schedule: "0 12 * * *",
      prompt: "x",
      now: NOW,
    });
    store.add({
      persona: "phantom",
      description: "sooner",
      schedule: "0 * * * *",
      prompt: "x",
      now: NOW,
    });
    const tasks = store.list("phantom");
    expect(tasks.map((t) => t.description)).toEqual(["sooner", "later"]);
  });

  test("list excludes inactive by default; includeInactive shows them", () => {
    const a = store.add({
      persona: "phantom",
      description: "alive",
      schedule: "0 * * * *",
      prompt: "x",
      now: NOW,
    });
    const d = store.add({
      persona: "phantom",
      description: "dead",
      schedule: "0 * * * *",
      prompt: "x",
      now: NOW,
    });
    if (!a.ok || !d.ok) throw new Error("setup");
    store.cancel(d.id);
    expect(store.list("phantom").map((t) => t.description)).toEqual(["alive"]);
    expect(
      store.list("phantom", { includeInactive: true }).map((t) => t.description),
    ).toEqual(["alive", "dead"]);
  });

  test("list scopes to one persona", () => {
    store.add({
      persona: "phantom",
      description: "phantom-task",
      schedule: "0 * * * *",
      prompt: "x",
      now: NOW,
    });
    store.add({
      persona: "robbie",
      description: "robbie-task",
      schedule: "0 * * * *",
      prompt: "x",
      now: NOW,
    });
    expect(store.list("phantom").map((t) => t.description)).toEqual([
      "phantom-task",
    ]);
    expect(store.list("robbie").map((t) => t.description)).toEqual([
      "robbie-task",
    ]);
  });
});

describe("TaskStore.due", () => {
  test("returns only active tasks whose next_run_at <= asOf", () => {
    const r = store.add({
      persona: "phantom",
      description: "hourly",
      schedule: "0 * * * *",
      prompt: "x",
      now: NOW,
    });
    if (!r.ok) throw new Error("setup");

    // Just before 10:00 — not due yet.
    expect(store.due(new Date("2026-05-02T09:59:00Z"))).toEqual([]);
    // At 10:00 — due.
    expect(store.due(new Date("2026-05-02T10:00:00Z")).map((t) => t.id)).toEqual(
      [r.id],
    );
    // After cancel — not returned.
    store.cancel(r.id);
    expect(store.due(new Date("2026-05-02T10:00:00Z"))).toEqual([]);
  });

  test("crosses persona boundaries (tick fires every persona's tasks)", () => {
    store.add({
      persona: "phantom",
      description: "p",
      schedule: "0 * * * *",
      prompt: "x",
      now: NOW,
    });
    store.add({
      persona: "robbie",
      description: "r",
      schedule: "0 * * * *",
      prompt: "x",
      now: NOW,
    });
    expect(store.due(new Date("2026-05-02T10:00:00Z")).length).toBe(2);
  });
});

describe("TaskStore.recordRun", () => {
  test("advances next_run_at to AFTER `now` (skipping missed runs)", () => {
    const r = store.add({
      persona: "phantom",
      description: "hourly",
      schedule: "0 * * * *",
      prompt: "x",
      now: NOW,
    });
    if (!r.ok) throw new Error("setup");

    // Box was off for 5 hours; run lands at 14:30.
    const lateNow = new Date("2026-05-02T14:30:00Z");
    store.recordRun(r.id, lateNow);
    const t = store.get(r.id)!;
    // Next run is the TOP OF THE NEXT HOUR after 14:30 — i.e. 15:00.
    // Crucially NOT 10:00, 11:00, 12:00, etc.; we don't pile up missed runs.
    expect(t.nextRunAt.toISOString()).toBe("2026-05-02T15:00:00.000Z");
    expect(t.lastRunAt?.toISOString()).toBe(lateNow.toISOString());
    expect(t.runCount).toBe(1);
  });
});

describe("TaskStore.recordReview", () => {
  test("KEEP doubles the interval and bumps reviewCount", () => {
    const r = store.add({
      persona: "phantom",
      description: "x",
      schedule: "0 * * * *",
      prompt: "x",
      reviewIntervalMs: 7 * 24 * 60 * 60 * 1000,
      now: NOW,
    });
    if (!r.ok) throw new Error("setup");
    const reviewAt = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000);
    store.recordReview(r.id, "keep", reviewAt);
    const t = store.get(r.id)!;
    // Doubled from 7d to 14d.
    const days = Math.round(
      (t.nextReviewAt.getTime() - reviewAt.getTime()) / (24 * 60 * 60 * 1000),
    );
    expect(days).toBe(14);
    expect(t.reviewCount).toBe(1);
    expect(t.active).toBe(true);
  });

describe("TaskStore.oneOff", () => {
  test("creates one-off task without cron", () => {
    const r = store.add({
      persona: "phantom",
      description: "one-shot",
      schedule: "",
      prompt: "do thing",
      oneOff: true,
      nextRunAt: new Date(NOW.getTime() + 600_000), // 10 min from now
      now: NOW,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.task.oneOff).toBe(true);
    expect(r.task.schedule).toBe("");
    expect(r.task.nextRunAt.toISOString()).toBe("2026-05-02T09:40:00.000Z");
  });

  test("one-off deactivates after single run", () => {
    const r = store.add({
      persona: "phantom",
      description: "one-shot",
      schedule: "",
      prompt: "x",
      oneOff: true,
      nextRunAt: new Date(NOW.getTime() + 60_000),
      now: NOW,
    });
    if (!r.ok) throw new Error("setup");
    expect(r.task.active).toBe(true);
    store.recordRun(r.id, new Date(NOW.getTime() + 120_000));
    const t = store.get(r.id)!;
    expect(t.active).toBe(false);
    expect(t.runCount).toBe(1);
  });
});

describe("TaskStore.expiry", () => {
  test("maxRuns deactivates after reaching limit", () => {
    const r = store.add({
      persona: "phantom",
      description: "counted",
      schedule: "0 * * * *",
      prompt: "x",
      maxRuns: 3,
      now: NOW,
    });
    if (!r.ok) throw new Error("setup");
    // Run 3 times.
    store.recordRun(r.id, new Date("2026-05-02T10:00:00Z"));
    store.recordRun(r.id, new Date("2026-05-02T11:00:00Z"));
    store.recordRun(r.id, new Date("2026-05-02T12:00:00Z"));
    const t = store.get(r.id)!;
    expect(t.active).toBe(false);
    expect(t.runCount).toBe(3);
  });

  test("expireStaleTasks deactivates past expiresAt", () => {
    const r = store.add({
      persona: "phantom",
      description: "expiring",
      schedule: "0 * * * *",
      prompt: "x",
      expiresAt: new Date("2026-05-03T00:00:00Z"),
      now: NOW,
    });
    if (!r.ok) throw new Error("setup");
    expect(r.task.active).toBe(true);
    // expire as of a date past the expiry.
    const expired = store.expireStaleTasks(new Date("2026-05-04T00:00:00Z"));
    expect(expired).toBe(1);
    expect(store.get(r.id)!.active).toBe(false);
  });

  test("expireStaleTasks does not deactivate future expiry", () => {
    const r = store.add({
      persona: "phantom",
      description: "future",
      schedule: "0 * * * *",
      prompt: "x",
      expiresAt: new Date("2026-06-01T00:00:00Z"),
      now: NOW,
    });
    if (!r.ok) throw new Error("setup");
    const expired = store.expireStaleTasks(new Date("2026-05-03T00:00:00Z"));
    expect(expired).toBe(0);
    expect(store.get(r.id)!.active).toBe(true);
  });
});

describe("TaskStore.logRun / taskRuns", () => {
  test("logRun persists fire events", () => {
    const r = store.add({
      persona: "phantom",
      description: "logged",
      schedule: "0 * * * *",
      prompt: "x",
      now: NOW,
    });
    if (!r.ok) throw new Error("setup");
    const firedAt = new Date("2026-05-02T10:00:00Z");
    store.logRun({
      taskId: r.id,
      firedAt,
      status: "ok",
      exitCode: 0,
      outputExcerpt: "Task finished successfully",
      delivered: true,
    });
    store.logRun({
      taskId: r.id,
      firedAt: new Date("2026-05-02T11:00:00Z"),
      status: "error",
      exitCode: 1,
      outputExcerpt: "Connection refused",
      delivered: false,
    });
    const runs = store.taskRuns(r.id);
    expect(runs.length).toBe(2);
    // Most recent first.
    expect(runs[0].status).toBe("error");
    expect(runs[0].delivered).toBe(false);
    expect(runs[1].status).toBe("ok");
    expect(runs[1].delivered).toBe(true);
    expect(runs[1].outputExcerpt).toBe("Task finished successfully");
  });

  test("taskRuns returns empty for task with no runs", () => {
    const r = store.add({
      persona: "phantom",
      description: "virgin",
      schedule: "0 * * * *",
      prompt: "x",
      now: NOW,
    });
    if (!r.ok) throw new Error("setup");
    expect(store.taskRuns(r.id)).toEqual([]);
  });

  test("outputExcerpt truncated to 500 chars", () => {
    const r = store.add({
      persona: "phantom",
      description: "verbose",
      schedule: "0 * * * *",
      prompt: "x",
      now: NOW,
    });
    if (!r.ok) throw new Error("setup");
    const long = "x".repeat(1000);
    store.logRun({
      taskId: r.id,
      firedAt: NOW,
      status: "ok",
      exitCode: 0,
      outputExcerpt: long,
      delivered: false,
    });
    const runs = store.taskRuns(r.id);
    expect(runs[0].outputExcerpt.length).toBe(500);
  });
});

describe("TaskStore.silent / createdBy", () => {
  test("silent defaults to false", () => {
    const r = store.add({
      persona: "phantom",
      description: "loud",
      schedule: "0 * * * *",
      prompt: "x",
      now: NOW,
    });
    if (!r.ok) throw new Error("setup");
    expect(r.task.silent).toBe(false);
  });

  test("silent true persists", () => {
    const r = store.add({
      persona: "phantom",
      description: "quiet",
      schedule: "0 * * * *",
      prompt: "x",
      now: NOW,
      silent: true,
    });
    if (!r.ok) throw new Error("setup");
    expect(r.task.silent).toBe(true);
  });

  test("createdBy persists", () => {
    const r = store.add({
      persona: "phantom",
      description: "tracked",
      schedule: "0 * * * *",
      prompt: "x",
      now: NOW,
      createdBy: "telegram:7995070089",
    });
    if (!r.ok) throw new Error("setup");
    expect(r.task.createdBy).toBe("telegram:7995070089");
  });
});

describe("TaskStore.selftest", () => {
  test("selftest creates a 60s one-off task", () => {
    const { id, firesAt } = store.selftest("phantom", NOW);
    expect(id).toBeGreaterThan(0);
    const expected = new Date(NOW.getTime() + 60_000);
    expect(firesAt.toISOString()).toBe(expected.toISOString());
    const t = store.get(id)!;
    expect(t.oneOff).toBe(true);
    expect(t.silent).toBe(false);
    expect(t.description).toBe("selftest");
    expect(t.active).toBe(true);
  });
});

  test("STOP deactivates the task", () => {
    const r = store.add({
      persona: "phantom",
      description: "x",
      schedule: "0 * * * *",
      prompt: "x",
      now: NOW,
    });
    if (!r.ok) throw new Error("setup");
    store.recordReview(r.id, "stop");
    expect(store.get(r.id)!.active).toBe(false);
    expect(store.get(r.id)!.reviewCount).toBe(1);
  });
});
