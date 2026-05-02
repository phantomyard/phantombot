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
 */

import { defineCommand } from "citty";

import { type Config, loadConfig } from "../config.ts";
import type { WriteSink } from "../lib/io.ts";
import { openTaskStore, type Task, type TaskStore } from "../lib/tasks.ts";

export interface RunTaskAddInput {
  schedule: string;
  prompt: string;
  description: string;
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
    const r = store.add({
      persona: config.defaultPersona,
      schedule: input.schedule,
      prompt: input.prompt,
      description: input.description,
    });
    if (!r.ok) {
      err.write(`task add failed: ${r.error}\n`);
      return 2;
    }
    out.write(
      `task ${r.id} added: ${r.task.description}\n` +
        `  schedule:    ${r.task.schedule}\n` +
        `  next run:    ${r.task.nextRunAt.toISOString()}\n` +
        `  next review: ${r.task.nextReviewAt.toISOString()}\n`,
    );
    return 0;
  } finally {
    if (!input.store) store.close();
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

function formatTaskOneLine(t: Task): string {
  const flag = t.active ? "" : " [inactive]";
  return (
    `[${t.id}] ${t.description}${flag}` +
    `  schedule=${t.schedule}  next=${t.nextRunAt.toISOString()}  runs=${t.runCount}`
  );
}

function formatTaskFull(t: Task): string {
  return (
    `id:           ${t.id}\n` +
    `description:  ${t.description}\n` +
    `persona:      ${t.persona}\n` +
    `schedule:     ${t.schedule}\n` +
    `active:       ${t.active}\n` +
    `created:      ${t.createdAt.toISOString()}\n` +
    `last run:     ${t.lastRunAt ? t.lastRunAt.toISOString() : "(never)"}\n` +
    `next run:     ${t.nextRunAt.toISOString()}\n` +
    `runs:         ${t.runCount}\n` +
    `next review:  ${t.nextReviewAt.toISOString()}\n` +
    `reviews:      ${t.reviewCount}\n` +
    `--- prompt ---\n${t.prompt}\n`
  );
}

export default defineCommand({
  meta: {
    name: "task",
    description:
      "Manage scheduled tasks. Add a recurring prompt, list/show/cancel existing ones. The harnessed agent calls these via Bash to set up cron-style work for the user.",
  },
  subCommands: {
    add: defineCommand({
      meta: {
        name: "add",
        description:
          "Add a recurring task. The agent calls this to schedule background work.",
      },
      args: {
        schedule: {
          type: "string",
          required: true,
          description: "5-field cron expression (e.g. '0 * * * *' for hourly)",
        },
        prompt: {
          type: "string",
          required: true,
          description: "Prompt to fire at each scheduled tick.",
        },
        description: {
          type: "string",
          required: true,
          description: "Human-readable name shown by `task list`.",
        },
      },
      async run({ args }) {
        process.exitCode = await runTaskAdd({
          schedule: args.schedule as string,
          prompt: args.prompt as string,
          description: args.description as string,
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
  },
});
