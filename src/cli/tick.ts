/**
 * `phantombot tick` — fired every minute by phantombot-tick.timer.
 *
 * Reads tasks where next_run_at <= now() AND active=1, and either:
 *   - runs the task's normal prompt (the agent owns whether to surface
 *     anything to the user; tick itself is silent), then advances
 *     next_run_at;
 *   - runs a command-backed task directly, logging stdout/stderr and exit
 *     status without constructing a harness;
 *   - or, if next_review_at <= now(), runs the SELF-REVIEW prompt that
 *     asks the agent KEEP / STOP, and updates the task accordingly.
 *
 * Quiet-by-default contract: tick does NOT post the harness reply to
 * Telegram. The harnessed agent is the sole arbiter of whether the
 * user hears about a fire — if it wants to notify, it calls
 * `phantombot notify` from inside the prompt. This matches the standing
 * rule embedded in the persona builder ("Scheduled tasks run silently
 * by default — no Telegram chatter on every fire") which the previous
 * auto-delivery branch directly contradicted.
 *
 * Lockfile prevents overlapping ticks: if a previous tick is still
 * running (e.g. a slow Claude call), this minute's tick exits 0 and
 * the next minute's tick picks up. Skipping is preferred over piling
 * up — see the "skip missed runs" decision in the design doc.
 *
 * The tick runs as the OS user that owns the systemd timer
 * (typically the same user as `phantombot run`), so it inherits both
 * EnvironmentFile=-%h/.config/phantombot/.env and EnvironmentFile=-%h/.env
 * from the unit. Spawned harnesses see the merged environment; command
 * tasks do not. They get a minimal env plus explicitly allowlisted
 * `--secret NAME` values.
 */

import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { type Config, loadConfig, personaDir, xdgStateHome } from "../config.ts";
import { buildHarnessChain } from "../harnesses/buildChain.ts";
import type { Harness } from "../harnesses/types.ts";
import type { WriteSink } from "../lib/io.ts";
import { log } from "../lib/logger.ts";
import {
  acquireRunLock,
  isLockHandle,
} from "../lib/runLock.ts";
import { openTaskStore, type Task, type TaskStore } from "../lib/tasks.ts";
import { recordTickFired } from "../lib/timerHealth.ts";
import { openMemoryStore, type MemoryStore } from "../memory/store.ts";
import { runTurn } from "../orchestrator/turn.ts";

export function defaultTickLockPath(): string {
  return join(xdgStateHome(), "phantombot", "tick.lock");
}

export interface RunTickInput {
  config?: Config;
  /** "Now" injection point — tests pass a fixed instant. */
  now?: Date;
  /** Override the tick lock path (for testing). */
  lockPath?: string;
  /** Inject task store + memory store + harness factory for testing. */
  taskStore?: TaskStore;
  memory?: MemoryStore;
  harnesses?: Harness[];
  out?: WriteSink;
  err?: WriteSink;
}

export async function runTick(input: RunTickInput = {}): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const config = input.config ?? (await loadConfig());
  const now = input.now ?? new Date();

  // Record that the tick timer fired — even if the body exits early
  // because the lock is held. Doctor uses this marker's mtime to flag
  // a dead tick timer; the signal we want is "the timer fires," not
  // "tick did meaningful work."
  await recordTickFired();

  const lockPath = input.lockPath ?? defaultTickLockPath();
  const lock = acquireRunLock(lockPath);
  if (!isLockHandle(lock)) {
    // Previous tick still running. Don't pile up; next minute will retry.
    log.info("tick: previous tick still running, skipping", {
      holderPid: lock.pid,
    });
    return 0;
  }

  const taskStore =
    input.taskStore ?? (await openTaskStore(config.memoryDbPath));
  const memory = input.memory ?? (await openMemoryStore(config.memoryDbPath));
  let harnesses = input.harnesses;

  try {
    // Expire any tasks past their expires_at before processing due.
    taskStore.expireStaleTasks(now);

    const due = taskStore.due(now);
    if (due.length === 0) {
      log.debug("tick: no due tasks");
      return 0;
    }
    log.info("tick: running due tasks", { count: due.length });

    for (const task of due) {
      const isCommandTask = task.command !== undefined && task.command.trim() !== "";
      const isReview = !isCommandTask && task.nextReviewAt.getTime() <= now.getTime();
      const promptText = isReview
        ? buildReviewPrompt(task)
        : appendHygieneFooter(task);
      const conversation = isReview
        ? `tick:${task.id}:review`
        : `tick:${task.id}`;

      log.info("tick: firing task", {
        id: task.id,
        description: task.description,
        runCount: task.runCount,
        isReview,
      });

      const agentDir = personaDir(config, task.persona);
      if (!existsSync(agentDir)) {
        log.error("tick: persona dir missing — skipping task", {
          id: task.id,
          persona: task.persona,
          agentDir,
        });
        continue;
      }

      let finalText = "";
      let runError: string | undefined;
      let exitCode = 0;
      try {
        if (isCommandTask) {
          const result = await runCommandTask(task.command!, {
            timeoutMs: config.harnessHardTimeoutMs,
            cwd: agentDir,
            env: buildCommandEnv(task.commandSecrets),
          });
          finalText = result.output;
          exitCode = result.exitCode;
          if (result.exitCode !== 0) {
            runError = `command exited ${result.exitCode}`;
          }
        } else {
          harnesses ??= buildHarnessChain(config, err);
          if (harnesses.length === 0) {
            throw new Error("no harnesses configured");
          }
          for await (const chunk of runTurn({
            persona: task.persona,
            conversation,
            userMessage: promptText,
            agentDir,
            harnesses,
            memory,
            idleTimeoutMs: config.harnessIdleTimeoutMs,
            hardTimeoutMs: config.harnessHardTimeoutMs,
          })) {
            if (chunk.type === "text") finalText += chunk.text;
            if (chunk.type === "done") finalText = chunk.finalText;
          }
        }
      } catch (e) {
        runError = (e as Error).message;
        exitCode = 1;
        log.error("tick: task threw", {
          id: task.id,
          error: runError,
        });
      }

      // Log the fire to task_runs for auditability.
      const outputExcerpt = runError
        ? `ERROR: ${runError}${finalText ? `\n${finalText}` : ""}`.slice(0, 500)
        : finalText.slice(0, 500);
      const status = runError ? "error" : "ok";

      // Quiet-by-default: tick never auto-posts the harness reply to
      // Telegram. The agent calls `phantombot notify` from inside the
      // prompt if it wants the user to see something. `delivered` is
      // recorded false here for back-compat with the task_runs schema;
      // it no longer corresponds to a tick-side delivery decision. If
      // we ever wire up post-hoc "did notify fire during this run"
      // tracking, this is the field to revive.
      taskStore.logRun({
        taskId: task.id,
        firedAt: now,
        status: status as "ok" | "error",
        exitCode,
        outputExcerpt,
        delivered: false,
      });

      if (isReview) {
        const decision = parseReviewDecision(finalText);
        log.info("tick: review decision", {
          id: task.id,
          decision,
          replyChars: finalText.length,
        });
        taskStore.recordReview(task.id, decision, now);
      } else {
        taskStore.recordRun(task.id, now);
      }
      out.write(
        `tick: task ${task.id} done (${finalText.length} chars, ${status})\n`,
      );
    }
    return 0;
  } finally {
    if (!input.taskStore) taskStore.close();
    if (!input.memory) await memory.close();
    lock.release();
  }
}

async function runCommandTask(
  command: string,
  opts: { timeoutMs: number; cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ exitCode: number; output: string }> {
  return await new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (result: { exitCode: number; output: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(command, {
      shell: true,
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const append = (chunk: Buffer) => {
      output = appendCommandOutput(output, chunk.toString());
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      output = appendCommandOutput(output, "\nERROR: command timed out");
      finish({ exitCode: 124, output });
    }, opts.timeoutMs);
    child.on("close", (code, signal) => {
      if (signal) {
        finish({
          exitCode: 128,
          output: appendCommandOutput(output, `\nterminated by ${signal}`),
        });
      } else {
        finish({ exitCode: code ?? 0, output });
      }
    });
    child.on("error", (e) => {
      finish({ exitCode: 1, output: e.message });
    });
  });
}

function buildCommandEnv(secretNames: string[]): NodeJS.ProcessEnv {
  const allowlist = [
    "HOME",
    "PATH",
    "SHELL",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const name of allowlist) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  if (env.PATH === undefined) {
    env.PATH = "/usr/local/bin:/usr/bin:/bin";
  }
  for (const name of secretNames) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function appendCommandOutput(current: string, next: string): string {
  const combined = current + next;
  if (combined.length <= 4000) return combined;
  return `${combined.slice(0, 1900)}\n... output truncated ...\n${combined.slice(-1900)}`;
}

/**
 * Soft self-policing nudge appended to the prompt of every recurring,
 * forever-running fire (i.e. recurring tasks with no expiry set).
 *
 * Recurring tasks with an explicit expiry (--until/--count/--for) skip
 * this — the user has already set an end. One-offs skip it — they
 * delete themselves. Reviews skip it — `buildReviewPrompt` does its
 * own thing.
 *
 * The nudge is short, factual, and ends with the exact cancel command.
 * The aim is that even a small model notices the line and acts on it
 * when the task is genuinely no longer useful, without us having to
 * hard-stop everything that doesn't have a calendar end-date.
 *
 * Exported for testing.
 */
export function appendHygieneFooter(task: Task): string {
  if (task.oneOff) return task.prompt;
  const hasExpiry = task.expiresAt !== undefined || task.maxRuns !== undefined;
  if (hasExpiry) return task.prompt;
  return (
    task.prompt +
    `\n\n---\n` +
    `Task hygiene: this is recurring task #${task.id} ("${task.description}"), ` +
    `schedule \`${task.schedule}\`, has fired ${task.runCount} time(s) so far, no expiry set.\n` +
    `After completing the work above, briefly ask yourself: is this task still useful? ` +
    `If not, run \`phantombot task cancel ${task.id}\` to retire it. ` +
    `If yes, ignore this footer and continue.`
  );
}

/**
 * The self-review prompt fired when a task's next_review_at has passed.
 * The agent is expected to reply starting with KEEP, STOP, or MODIFY
 * (a literal sentinel — same contract style as `notify` rules).
 *
 * KEEP  → next review interval doubles.
 * STOP  → task deactivates; the agent should also call
 *         `phantombot notify --message "..."` to tell the user.
 * MODIFY → agent should call `phantombot notify` with a proposed change
 *         and then `phantombot task cancel <id>` + `task add ...` once
 *         the user confirms. We treat MODIFY same as KEEP at the store
 *         level (the agent owns the reshape).
 */
function buildReviewPrompt(t: Task): string {
  return (
    `Self-review of scheduled task #${t.id}: "${t.description}".\n` +
    `\n` +
    `You scheduled this on ${t.createdAt.toISOString()}. It has run ${t.runCount} times. ` +
    (t.schedule ? `Schedule: ${t.schedule}.\n` : `Type: one-off.\n`) +
    `Original prompt:\n  ${t.prompt}\n` +
    `\n` +
    `Looking at recent memory + this task's recent run history, decide:\n` +
    `- Begin your reply with one of: KEEP / STOP / MODIFY\n` +
    `- KEEP: leave the task as-is (next review will fire later).\n` +
    `- STOP: deactivate the task. Briefly say why, then call ` +
    `\`phantombot notify --message "..."\` to tell the user.\n` +
    `- MODIFY: call \`phantombot notify\` to propose a change to the user. ` +
    `If they confirm, run \`phantombot task cancel ${t.id}\` then \`phantombot task add\` with the new shape.\n`
  );
}

function parseReviewDecision(reply: string): "keep" | "stop" {
  // Default to KEEP — we err on the side of leaving the user's task in
  // place if the agent's reply is ambiguous. STOP requires an explicit
  // sentinel.
  const trimmed = reply.trimStart().toUpperCase();
  if (trimmed.startsWith("STOP")) return "stop";
  return "keep";
}

export default defineCommand({
  meta: {
    name: "tick",
    description:
      "Fire any scheduled tasks that are due. Called every minute by phantombot-tick.timer; safe to run by hand for debugging.",
  },
  async run() {
    process.exitCode = await runTick();
  },
});
