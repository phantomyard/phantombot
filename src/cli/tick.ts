/**
 * `phantombot tick` — fired every minute by phantombot-tick.timer.
 *
 * Reads tasks where next_run_at <= now() AND active=1, runs each through
 * the harness chain, and either:
 *   - runs the task's normal prompt (yielding to the agent's notify rule
 *     embedded in that prompt), then advances next_run_at;
 *   - or, if next_review_at <= now(), runs the SELF-REVIEW prompt that
 *     asks the agent KEEP / STOP, and updates the task accordingly.
 *
 * Lockfile prevents overlapping ticks: if a previous tick is still
 * running (e.g. a slow Claude call), this minute's tick exits 0 and
 * the next minute's tick picks up. Skipping is preferred over piling
 * up — see the "skip missed runs" decision in the design doc.
 *
 * The tick runs as the OS user that owns the systemd timer
 * (typically the same user as `phantombot run`), so it inherits both
 * EnvironmentFile=-%h/.config/phantombot/.env and EnvironmentFile=-%h/.env
 * from the unit. Spawned harnesses see the merged environment.
 */

import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  HttpTelegramTransport,
  type TelegramTransport,
} from "../channels/telegram.ts";
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
  /** Inject telegram transport for testing. */
  transport?: TelegramTransport;
  out?: WriteSink;
  err?: WriteSink;
}

export async function runTick(input: RunTickInput = {}): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const config = input.config ?? (await loadConfig());
  const now = input.now ?? new Date();

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
  const harnesses = input.harnesses ?? buildHarnessChain(config, err);
  if (harnesses.length === 0) {
    err.write("tick: no harnesses configured; skipping\n");
    if (!input.taskStore) taskStore.close();
    if (!input.memory) await memory.close();
    lock.release();
    return 1;
  }

  // Init telegram transport for notifications.
  let transport: TelegramTransport | undefined;
  const tg = config.channels.telegram;
  if (tg && tg.allowedUserIds.length > 0) {
    transport = input.transport ?? new HttpTelegramTransport(tg.token);
  }

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
      const isReview = task.nextReviewAt.getTime() <= now.getTime();
      const promptText = isReview ? buildReviewPrompt(task) : task.prompt;
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
      try {
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
      } catch (e) {
        runError = (e as Error).message;
        log.error("tick: task threw", {
          id: task.id,
          error: runError,
        });
      }

      // Log the fire to task_runs for auditability.
      const outputExcerpt = runError
        ? `ERROR: ${runError}`.slice(0, 500)
        : finalText.slice(0, 500);
      const status = runError ? "error" : "ok";
      const exitCode = runError ? 1 : 0;

      // For non-silent, non-review tasks: notify the user via Telegram.
      let delivered = false;
      if (!isReview && !task.silent && !runError && finalText.trim().length > 0 && transport) {
        try {
          const notifyMsg = formatTaskNotify(task, finalText);
          for (const chatId of tg!.allowedUserIds) {
            try {
              await transport.sendMessage(chatId, notifyMsg);
              delivered = true;
            } catch (e) {
              log.warn("tick: notify send failed", {
                taskId: task.id,
                chatId,
                error: (e as Error).message,
              });
            }
          }
        } catch (e) {
          log.warn("tick: notify failed", {
            taskId: task.id,
            error: (e as Error).message,
          });
        }
      }

      taskStore.logRun({
        taskId: task.id,
        firedAt: now,
        status: status as "ok" | "error",
        exitCode,
        outputExcerpt,
        delivered,
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
        `tick: task ${task.id} done (${finalText.length} chars, ${status}, notified=${delivered})\n`,
      );
    }
    return 0;
  } finally {
    if (!input.taskStore) taskStore.close();
    if (!input.memory) await memory.close();
    lock.release();
  }
}

/**
 * Format a task's output as a Telegram notification message.
 * Truncates to avoid hitting Telegram's 4096 char limit.
 */
function formatTaskNotify(task: Task, output: string): string {
  const header = `📋 *${task.description}*`;
  const body = output.trim().slice(0, 3500); // leave room for Markdown
  return `${header}\n\n${body}`;
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
