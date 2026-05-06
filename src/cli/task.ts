/**
 * `phantombot task` — CRUD for scheduled tasks. Primarily for the
 * harnessed agent (called via Bash from inside a Claude session); a
 * `phantombot tasks` Clack TUI exists for human use but isn't expected
 * to be the main path.
 *
 * Tasks are persona-scoped — `add` records the task against
 * `config.defaultPersona` so the running tick (which fires under the
 * same persona) picks them up. Cross-persona task management isn't a
 * thing today; if you switch personas, you don't see the prior
 * persona's tasks.
 *
 * One-off vs recurring:
 *   - One-off (default): --in 10m or --at "2026-05-07 09:00"
 *   - Recurring: --every 1h --until <date> or --count <N> or --for <dur>
 *   - Recurring WITHOUT an expiry is an error.
 */

import { defineCommand } from "citty";
import { join } from "node:path";

import { type Config, loadConfig, personaDir } from "../config.ts";
import type { WriteSink } from "../lib/io.ts";
import { log } from "../lib/logger.ts";
import {
  formatLocal,
  parseAt,
  parseDuration,
  parseEvery,
  parseFor,
  MAX_RECURRING_DURATION_MS,
} from "../lib/scheduleParser.ts";
import { openTaskStore, type Task, type TaskStore, type TaskRunRow } from "../lib/tasks.ts";

export interface RunTaskAddInput {
  schedule?: string;
  prompt: string;
  description: string;
  /** --in 10m — relative one-off */
  relIn?: string;
  /** --at ISO — absolute one-off */
  absAt?: string;
  /** --every 1h — recurring interval */
  every?: string;
  /** --until ISO — recurring expiry (absolute) */
  until?: string;
  /** --count N — recurring expiry (count) */
  count?: number;
  /** --for 30d — recurring expiry (relative) */
  relFor?: string;
  /** --silent — suppress user notification after fire */
  silent?: boolean;
  /** --force-long-running — allow recurring > 90d */
  forceLongRunning?: boolean;
  config?: Config;
  store?: TaskStore;
  out?: WriteSink;
  err?: WriteSink;
}

export async function runTaskAdd(input: RunTaskAddInput): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const config = input.config ?? (await loadConfig());
  const store = input.store ?? (await openTaskStore(config.memoryDbPath));
  try {
    const now = new Date();

    // Determine mode: one-off or recurring.
    const isRecurring = Boolean(input.every);
    const isOneOff = Boolean(input.relIn) || Boolean(input.absAt) || (!isRecurring && !input.schedule);

    // Validate mutual exclusivity.
    if (isRecurring && (input.relIn || input.absAt)) {
      err.write("--every cannot be combined with --in or --at.\n");
      return 2;
    }

    // Resolve schedule and nextRunAt.
    let schedule: string;
    let nextRunAt: Date | undefined;
    let expiresAt: Date | undefined;
    let maxRuns: number | undefined;

    if (isOneOff) {
      schedule = "";
      if (input.relIn) {
        const parsed = parseDuration(input.relIn);
        if (!parsed.ok) { err.write(`${parsed.error}\n`); return 2; }
        nextRunAt = new Date(now.getTime() + parsed.ms);
      } else if (input.absAt) {
        const parsed = parseAt(input.absAt, now);
        if (!parsed.ok) { err.write(`${parsed.error}\n`); return 2; }
        nextRunAt = parsed.firesAt;
        if (nextRunAt.getTime() <= now.getTime()) {
          err.write(`--at time is in the past: ${input.absAt}\n`);
          return 2;
        }
      } else {
        err.write("one-off task requires --in or --at.\n");
        return 2;
      }
    } else if (isRecurring) {
      // Parse --every into a cron expression.
      const everyParsed = parseEvery(input.every!);
      if (!everyParsed.ok) { err.write(`${everyParsed.error}\n`); return 2; }
      schedule = everyParsed.cron;

      // Require an expiry.
      if (!input.until && !input.count && !input.relFor) {
        err.write(
          "recurring tasks require --until <date>, --count <N>, or --for <duration>.\n" +
          "  No task runs forever. Add an expiry.\n",
        );
        return 2;
      }

      // Parse expiry.
      if (input.until) {
        const u = parseAt(input.until, now);
        if (!u.ok) { err.write(`--until ${u.error}\n`); return 2; }
        expiresAt = u.firesAt;
      }
      if (input.count) {
        if (input.count < 1) { err.write("--count must be >= 1\n"); return 2; }
        maxRuns = input.count;
      }
      if (input.relFor) {
        const f = parseFor(input.relFor);
        if (!f.ok) { err.write(`--for ${f.error}\n`); return 2; }
        expiresAt = new Date(now.getTime() + f.ms);
      }

      // Enforce max 90d unless --force-long-running.
      if (!input.forceLongRunning && expiresAt) {
        const maxEnd = new Date(now.getTime() + MAX_RECURRING_DURATION_MS);
        if (expiresAt.getTime() > maxEnd.getTime()) {
          err.write(
            `recurring duration exceeds 90 days (ends ${formatLocal(expiresAt)}). ` +
            `Use --force-long-running to override.\n`,
          );
          return 2;
        }
      }
    } else {
      // Legacy: bare cron schedule (kept for back-compat).
      schedule = input.schedule ?? "";
      if (!schedule) {
        err.write("must provide --in, --at, --every, or a cron schedule.\n");
        return 2;
      }
    }

    const result = store.add({
      persona: config.defaultPersona,
      schedule,
      prompt: input.prompt,
      description: input.description,
      nextRunAt,
      now,
      oneOff: isOneOff,
      expiresAt,
      maxRuns,
      silent: input.silent ?? false,
      createdBy: "cli", // agent should set explicitly; fallback for humans
    });

    if (!result.ok) {
      err.write(`task add failed: ${result.error}\n`);
      return 2;
    }

    const t = result.task;

    // Write [commitment] to today's daily file.
    await writeCommitmentToDaily(config, t);

    // Mandatory echo — agent contract requires repeating this to user.
    out.write(
      `task ${t.id} scheduled\n` +
      `  description: ${t.description}\n` +
      `  fires at:    ${formatLocal(t.nextRunAt)} (${t.nextRunAt.toISOString()})\n` +
      (t.oneOff
        ? `  type:        one-off\n`
        : `  schedule:    ${t.schedule}\n  expiry:      ${describeExpiry(t)}\n`) +
      (t.silent ? `  silent:      yes\n` : ""),
    );
    return 0;
  } finally {
    if (!input.store) store.close();
  }
}

function describeExpiry(t: Task): string {
  const parts: string[] = [];
  if (t.expiresAt) parts.push(`until ${formatLocal(t.expiresAt)}`);
  if (t.maxRuns !== undefined) parts.push(`${t.maxRuns} runs`);
  return parts.join(" or ") || "none set";
}

async function writeCommitmentToDaily(config: Config, t: Task): Promise<void> {
  try {
    const dateStr = t.nextRunAt.toISOString().slice(0, 10);
    const dailyPath = join(personaDir(config, config.defaultPersona), "memory", `${dateStr}.md`);
    const line = `[commitment] task ${t.id}: ${t.description} — fires ${t.nextRunAt.toISOString()}${t.oneOff ? " (one-off)" : ` (recurring, ${t.schedule})`}\n`;
    const { appendFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(dailyPath), { recursive: true });
    await appendFile(dailyPath, line, "utf8");
  } catch (e) {
    // Best-effort only — don't fail task creation if the commit log write fails.
    log.warn("task: failed to write commitment to daily file", {
      error: (e as Error).message,
    });
  }
}

export interface RunTaskListInput {
  includeInactive?: boolean;
  config?: Config;
  store?: TaskStore;
  out?: WriteSink;
}

export async function runTaskList(input: RunTaskListInput = {}): Promise<number> {
  const out = input.out ?? process.stdout;
  const config = input.config ?? (await loadConfig());
  const store = input.store ?? (await openTaskStore(config.memoryDbPath));
  try {
    const tasks = store.list(config.defaultPersona, {
      includeInactive: input.includeInactive,
    });
    if (tasks.length === 0) {
      out.write(`(no tasks for persona '${config.defaultPersona}')\n`);
      return 0;
    }
    for (const t of tasks) {
      out.write(formatTaskOneLine(t) + "\n");
    }
    return 0;
  } finally {
    if (!input.store) store.close();
  }
}

export interface RunTaskShowInput {
  id: number;
  config?: Config;
  store?: TaskStore;
  out?: WriteSink;
  err?: WriteSink;
}

export async function runTaskShow(input: RunTaskShowInput): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const config = input.config ?? (await loadConfig());
  const store = input.store ?? (await openTaskStore(config.memoryDbPath));
  try {
    const t = store.get(input.id);
    if (!t) {
      err.write(`task ${input.id} not found\n`);
      return 1;
    }
    out.write(formatTaskFull(t));
    return 0;
  } finally {
    if (!input.store) store.close();
  }
}

export interface RunTaskCancelInput {
  id: number;
  config?: Config;
  store?: TaskStore;
  out?: WriteSink;
  err?: WriteSink;
}

export async function runTaskCancel(
  input: RunTaskCancelInput,
): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const config = input.config ?? (await loadConfig());
  const store = input.store ?? (await openTaskStore(config.memoryDbPath));
  try {
    const ok = store.cancel(input.id);
    if (!ok) {
      err.write(`task ${input.id} not found (or already inactive)\n`);
      return 1;
    }
    out.write(`task ${input.id} cancelled\n`);
    return 0;
  } finally {
    if (!input.store) store.close();
  }
}

export interface RunTaskLogInput {
  id: number;
  config?: Config;
  store?: TaskStore;
  out?: WriteSink;
  err?: WriteSink;
}

export async function runTaskLog(input: RunTaskLogInput): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const config = input.config ?? (await loadConfig());
  const store = input.store ?? (await openTaskStore(config.memoryDbPath));
  try {
    const t = store.get(input.id);
    if (!t) {
      err.write(`task ${input.id} not found\n`);
      return 1;
    }
    const runs: TaskRunRow[] = store.taskRuns(input.id);
    out.write(formatTaskFull(t) + "\n");
    if (runs.length === 0) {
      out.write("(no runs yet)\n");
    } else {
      out.write(`--- ${runs.length} most recent runs ---\n`);
      for (const r of runs) {
        out.write(formatTaskRun(r) + "\n");
      }
    }
    return 0;
  } finally {
    if (!input.store) store.close();
  }
}

export interface RunTaskSelftestInput {
  config?: Config;
  store?: TaskStore;
  out?: WriteSink;
  err?: WriteSink;
}

export async function runTaskSelftest(
  input: RunTaskSelftestInput = {},
): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const config = input.config ?? (await loadConfig());
  const store = input.store ?? (await openTaskStore(config.memoryDbPath));
  try {
    const { id, firesAt } = store.selftest(config.defaultPersona);
    out.write(
      `selftest task ${id} scheduled\n` +
      `  fires at: ${formatLocal(firesAt)} (${firesAt.toISOString()})\n` +
      `  verify with: phantombot task log ${id}\n` +
      `  or wait 60s and check phantombot task list\n`,
    );
    return 0;
  } finally {
    if (!input.store) store.close();
  }
}

function formatTaskOneLine(t: Task): string {
  const flag = t.active ? "" : " [inactive]";
  const type = t.oneOff ? "once" : "recur";
  return (
    `[${t.id}] ${t.description}${flag}` +
    `  type=${type}  next=${formatLocal(t.nextRunAt)}  runs=${t.runCount}` +
    (t.schedule ? `  schedule=${t.schedule}` : "")
  );
}

function formatTaskFull(t: Task): string {
  return (
    `id:           ${t.id}\n` +
    `description:  ${t.description}\n` +
    `persona:      ${t.persona}\n` +
    `type:         ${t.oneOff ? "one-off" : "recurring"}\n` +
    `schedule:     ${t.schedule || "(none — one-off)"}\n` +
    `active:       ${t.active}\n` +
    `silent:       ${t.silent}\n` +
    `created:      ${t.createdAt.toISOString()}\n` +
    `last run:     ${t.lastRunAt ? formatLocal(t.lastRunAt) : "(never)"}\n` +
    `next run:     ${formatLocal(t.nextRunAt)}\n` +
    `runs:         ${t.runCount}` +
    (t.maxRuns !== undefined ? ` / ${t.maxRuns} max` : "") + `\n` +
    `next review:  ${formatLocal(t.nextReviewAt)}\n` +
    (t.expiresAt ? `expires:      ${formatLocal(t.expiresAt)}\n` : "") +
    `reviews:      ${t.reviewCount}\n` +
    `--- prompt ---\n${t.prompt}\n`
  );
}

function formatTaskRun(r: TaskRunRow): string {
  const flag = r.status === "error" ? " !ERR" : "";
  const delivered = r.delivered ? " [notified]" : "";
  return (
    `  ${r.firedAt.toISOString()}  ${r.status}  exit=${r.exitCode}${flag}${delivered}\n` +
    `    ${r.outputExcerpt.slice(0, 120)}`
  );
}

export default defineCommand({
  meta: {
    name: "task",
    description:
      "Manage scheduled tasks. Add a prompt to fire once or on a recurring schedule. The harnessed agent calls these via Bash to set up background work for the user.",
  },
  subCommands: {
    add: defineCommand({
      meta: {
        name: "add",
        description:
          "Add a task. One-off by default (--in 10m or --at <time>). Recurring with --every requires --until, --count, or --for.",
      },
      args: {
        prompt: {
          type: "positional",
          required: true,
          description: "Prompt to fire at the scheduled time.",
        },
        description: {
          type: "positional",
          required: true,
          description: "Human-readable label shown by `task list`.",
        },
        schedule: {
          type: "string",
          required: false,
          description: "5-field cron expression (legacy recurring). Prefer --every.",
        },
        in: {
          type: "string",
          required: false,
          description: "Fire once after this duration (e.g. 10m, 5h, 2d).",
        },
        at: {
          type: "string",
          required: false,
          description: "Fire once at this absolute time (ISO 8601).",
        },
        every: {
          type: "string",
          required: false,
          description: "Recurring interval (e.g. 1h, 30m, 2d, 1w).",
        },
        until: {
          type: "string",
          required: false,
          description: "Expiry date for recurring tasks (ISO 8601).",
        },
        count: {
          type: "string",
          required: false,
          description: "Max number of runs for recurring tasks.",
        },
        for: {
          type: "string",
          required: false,
          description: "Expiry duration for recurring tasks (e.g. 30d).",
        },
        silent: {
          type: "boolean",
          required: false,
          description: "Suppress user notification after tick fires this task.",
          default: false,
        },
        "force-long-running": {
          type: "boolean",
          required: false,
          description: "Allow recurring durations beyond the 90-day default cap.",
          default: false,
        },
      },
      async run({ args }) {
        process.exitCode = await runTaskAdd({
          prompt: args.prompt as string,
          description: args.description as string,
          schedule: args.schedule as string | undefined,
          relIn: args.in as string | undefined,
          absAt: args.at as string | undefined,
          every: args.every as string | undefined,
          until: args.until as string | undefined,
          count: args.count ? Number(args.count) : undefined,
          relFor: args.for as string | undefined,
          silent: args.silent as boolean,
          forceLongRunning: args["force-long-running"] as boolean,
        });
      },
    }),
    list: defineCommand({
      meta: { name: "list", description: "List active tasks for the current persona." },
      args: {
        all: {
          type: "boolean",
          description: "Include inactive (cancelled / stopped) tasks too.",
          default: false,
        },
      },
      async run({ args }) {
        process.exitCode = await runTaskList({
          includeInactive: args.all as boolean,
        });
      },
    }),
    show: defineCommand({
      meta: { name: "show", description: "Show full detail of one task." },
      args: {
        id: { type: "positional", required: true, description: "Task id." },
      },
      async run({ args }) {
        process.exitCode = await runTaskShow({ id: Number(args.id) });
      },
    }),
    cancel: defineCommand({
      meta: { name: "cancel", description: "Deactivate a task by id." },
      args: {
        id: { type: "positional", required: true, description: "Task id." },
      },
      async run({ args }) {
        process.exitCode = await runTaskCancel({ id: Number(args.id) });
      },
    }),
    log: defineCommand({
      meta: { name: "log", description: "Show fire history for one task." },
      args: {
        id: { type: "positional", required: true, description: "Task id." },
      },
      async run({ args }) {
        process.exitCode = await runTaskLog({ id: Number(args.id) });
      },
    }),
    selftest: defineCommand({
      meta: {
        name: "selftest",
        description:
          "Create a 60s self-test task that fires and verifies the scheduler is working.",
      },
      async run() {
        process.exitCode = await runTaskSelftest();
      },
    }),
  },
});
