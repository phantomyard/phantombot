/**
 * `phantombot tick` — fired every minute by phantombot-tick.timer.
 *
 * Two phases, connected by per-task CLAIMS (issue #631):
 *
 *   Phase A — under the process-wide tick.lock: expire stale tasks, select
 *   due tasks, defer against live conversations (#391), apply the per-persona
 *   wake concurrency cap, and CLAIM each task it will dispatch (atomic
 *   `claimForRun`). The lock is then RELEASED — it covers selection only,
 *   never a run.
 *
 *   Phase B — lock-free:
 *     - command-backed tasks run in-process, serially, BEFORE any agent wake
 *       is dispatched (a 2-second poller never waits behind a 60-minute LLM
 *       turn), and
 *     - agent wakes dispatch as DETACHED child processes
 *       (`phantombot tick --run-task <id>`, see `runTaskWake`) that own the
 *       run end to end: they hold the claim, run the turn, write task_runs,
 *       advance/deactivate the row and release the claim. On Linux the child
 *       launches through `systemd-run --user --scope` so it escapes the tick
 *       unit's cgroup — a plain child of a oneshot unit is killed by systemd
 *       the moment the unit deactivates. The tick process itself exits
 *       seconds after the timer fires.
 *
 * The claim replaced the lock as the no-double-fire guarantee: a second tick
 * refuses a task with a LIVE claim (pid still probeable-alive), transparently
 * STEALS a STALE one (pid dead — the runner crashed before releasing), and
 * one-off deactivation plus next_run_at advancement happen in the runner.
 *
 * Quiet-by-default contract: neither tick nor the wake child posts the
 * harness reply to Telegram. The harnessed agent is the sole arbiter of
 * whether the user hears about a fire — if it wants to notify, it calls
 * `phantombot notify` from inside the prompt.
 *
 * The tick runs as the OS user that owns the systemd timer (typically the
 * same user as `phantombot run`) and decrypts the active persona's vault at
 * startup like any other invocation (#452). Command tasks get a minimal env
 * plus explicitly allowlisted `--secret NAME` values; wake children get a
 * full env minus every vault-injected key (they re-bootstrap the TASK
 * persona's own vault through PHANTOMBOT_PERSONA — see `wakeChildEnv`).
 */

import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, hostname } from "node:os";
import { spawn } from "node:child_process";
import { signalProcessGroup } from "../lib/processGroup.ts";
import { NON_INTERACTIVE_ENV } from "../lib/envBootstrap.ts";
import { isCompiledBinary } from "../lib/embeddedPi.ts";
import { vaultTrackedKeys } from "../lib/vault.ts";

import {
  type Config,
  loadConfig,
  personaDir,
  withHostHarnessBins,
  xdgStateHome,
} from "../config.ts";
import { buildHarnessChain } from "../harnesses/buildChain.ts";
import { resolveHarnessBinsForConfig } from "../lib/harnessAvailability.ts";
import type { Harness, HarnessChunk } from "../harnesses/types.ts";
import type { WriteSink } from "../lib/io.ts";
import { log } from "../lib/logger.ts";
import { redactForLog } from "../lib/redact.ts";
import {
  acquireRunLock,
  isLockHandle,
} from "../lib/runLock.ts";
import { openTaskStore, type Task, type TaskStore } from "../lib/tasks.ts";
import { ambientEnvKeyAllowed, getPersonaSecretStrict } from "../lib/vaultSecrets.ts";
import { recordTickFired } from "../lib/timerHealth.ts";
import { healStaleMaintenanceFromTick } from "../lib/maintenanceHeal.ts";
import { shouldDeferWake } from "../lib/turnRegistry.ts";
import { openMemoryStore, type MemoryStore } from "../memory/store.ts";
import { runTurn } from "../orchestrator/turn.ts";
import { makeRetriever } from "../orchestrator/retrieval.ts";
import { makeTurnIndexer } from "../orchestrator/turnIndexer.ts";
import {
  makeDurableFactPuller,
  requestFactExtractionIfEnabled,
} from "../orchestrator/durableFacts.ts";

const WAKE_STREAM_PREVIEW_CHARS = 2000;
/**
 * Total wall-clock budget for ONE background wake, across its whole harness
 * chain (issue #631). The wake child clamps every attempt's hard cap to the
 * time remaining, so a timed-out primary hands the fallback only what is
 * left — the value is unchanged from before the claim-then-dispatch change;
 * it just stopped being PER-HARNESS.
 */
const BACKGROUND_WAKE_HARD_TIMEOUT_MS = 30 * 60 * 1000;

export function defaultTickLockPath(): string {
  return join(xdgStateHome(), "phantombot", "tick.lock");
}

export interface RunTickInput {
  config?: Config;
  /** "Now" injection point — tests pass a fixed instant. */
  now?: Date;
  /** Override the tick lock path (for testing). */
  lockPath?: string;
  /** Inject task store + memory store for testing. */
  taskStore?: TaskStore;
  memory?: MemoryStore;
  /**
   * Test seam for the stale-maintenance self-heal (#510). Pass `false` to skip
   * it, or a function to substitute a fake. Production passes undefined → heal
   * via the host's service-manager backend, but only when this IS the
   * installed binary, only when a served persona's heartbeat is stale, and at
   * most once every {@link TICK_HEAL_MIN_INTERVAL_MINUTES}.
   */
  healMaintenance?: false | (() => Promise<void>);
  /**
   * Test seam replacing the detached wake-child spawn (issue #631). Tests
   * either record the dispatch, or run the wake IN-PROCESS via `runTaskWake`
   * with injected harnesses. Production passes undefined → `spawnWakeChild`.
   */
  spawnWake?: (task: Task, opts: { err: WriteSink }) => Promise<void>;
  /**
   * Resolve one persona's EFFECTIVE config (test seam, phantombot#439).
   * Used by the command-task path; agent wakes resolve in the child.
   */
  loadPersonaConfig?: (persona: string) => Promise<Config>;
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

  // Stale-maintenance self-heal (#510). Tick is a SEPARATE scheduled job from
  // the heartbeat (its own plist / timer), so when the heartbeat's job dies —
  // matt's launchd agent started returning exit 78 and went 41h stale — tick is
  // still firing and can re-arm it. The migration used to be reachable only
  // from the heartbeat itself, which made a single scheduler failure permanent.
  //
  // Gated three ways because tick runs every minute: only the installed binary
  // (never a dev `bun src/index.ts`), only when a served persona's heartbeat
  // marker is actually stale, and then at most once per quarter hour. Awaited
  // so a heal can't be cut short by the process exiting, and wrapped so a
  // service-manager hiccup never costs the task work below.
  if (input.healMaintenance !== false) {
    try {
      if (input.healMaintenance) await input.healMaintenance();
      else await healStaleMaintenanceFromTick(config, { now });
    } catch (e) {
      log.warn("tick: maintenance self-heal threw unexpectedly", {
        error: (e as Error).message,
      });
    }
  }

  const taskStore = input.taskStore ?? (await openTaskStore(config.memoryDbPath));

  // Every task runs under ITS OWN persona's effective config (phantombot#439).
  // The row stores the persona; the settings that decide how a COMMAND task
  // runs (its timeout) live in that persona's config.toml. Resolving them once
  // per persona (not once per task) keeps a busy tick to one extra config read
  // per distinct persona, and the default persona costs nothing at all because
  // `config` already IS its layer. (Agent wakes resolve their own config in
  // the wake child; only command tasks need it here now.)
  const personaConfigs = new Map<string, Config>();
  const resolvePersonaConfig = async (persona: string): Promise<Config> => {
    // `config` already IS this persona's layer when it was loaded for it —
    // or when the caller injected a config (tests, embedded callers) that
    // names no layer at all, in which case the default persona's settings are
    // the only ones there are.
    if (persona === (config.personaLayer ?? config.defaultPersona)) return config;
    const cached = personaConfigs.get(persona);
    if (cached) return cached;
    let resolved: Config;
    try {
      resolved = input.loadPersonaConfig
        ? await input.loadPersonaConfig(persona)
        : await loadConfig(persona);
    } catch (e) {
      // A persona whose file cannot be read still runs — on the host layer,
      // exactly as it did before per-persona config existed. Degrade, never
      // drop the wake.
      log.warn("tick: could not load persona config, using host layer", {
        persona,
        error: (e as Error).message,
      });
      resolved = config;
    }
    personaConfigs.set(persona, resolved);
    return resolved;
  };
  // The persona layer is cached RAW and given the host's harness binary paths
  // at each use, never at cache time.
  const effectiveConfigFor = async (persona: string): Promise<Config> =>
    withHostHarnessBins(await resolvePersonaConfig(persona), config);

  // ══ Phase A — selection + claiming, under the tick lock ══
  const claimedCommands: Task[] = [];
  const claimedWakes: Task[] = [];
  try {
    // Expire any tasks past their expires_at before processing due.
    taskStore.expireStaleTasks(now);

    // Housekeeping first: claims whose runner died (pid dead, or hung past
    // the TTL) are released so the task becomes claimable again. This also
    // clears leftovers on rows that will never fire again (cancelled, or a
    // one-off that completed just before its runner crashed mid-cleanup).
    for (const t of taskStore.claimed()) {
      if (t.claim && taskStore.claimIsStale(t.claim, { nowMs: now.getTime() })) {
        taskStore.releaseClaim(t.id);
        log.warn("tick: released stale claim", {
          id: t.id,
          persona: t.persona,
          claimPid: t.claim.pid,
          claimedAtMs: t.claim.claimedAt,
        });
      }
    }

    const due = taskStore.due(now);
    if (due.length === 0) {
      log.debug("tick: no due tasks");
      return 0;
    }
    log.info("tick: running due tasks", { count: due.length });

    const isCommandTask = (t: Task): boolean =>
      t.command !== undefined && t.command.trim() !== "";

    // Issue #631 ordering: command tasks are considered FIRST. A 2-second
    // deterministic poller must never queue behind a 60-minute LLM wake.
    // (Nothing "runs" here — this is pure dispatch ordering; command tasks
    // run in-process after the lock is released, agent wakes dispatch as
    // detached children.)
    const ordered = [
      ...due.filter(isCommandTask),
      ...due.filter((t) => !isCommandTask(t)),
    ];

    // Per-persona wake concurrency cap (#631). Count LIVE claims per persona
    // — each is either a wake child still running or a hung runner doctor
    // will report. Same-persona wakes collide on shared checkouts and PRs
    // (#391), so they queue in their own lane; other personas and command
    // tasks are never blocked by them.
    const maxConcurrentWakes = Math.max(1, config.tick?.maxConcurrentWakes ?? 1);
    const liveWakesByPersona = new Map<string, number>();
    for (const t of taskStore.claimed()) {
      if (!t.claim) continue;
      if (taskStore.claimIsStale(t.claim, { nowMs: now.getTime() })) continue;
      if (isCommandTask(t)) continue; // commands are not agent wakes
      liveWakesByPersona.set(
        t.persona,
        (liveWakesByPersona.get(t.persona) ?? 0) + 1,
      );
    }

    for (const task of ordered) {
      // #391 — DEFER while the principal is mid-conversation.
      //
      // A task wake starts an agent that shares state with the daemon's live
      // interactive turn — twice now the two have worked the same PR and the
      // same unlocked checkout, and a contributor got duplicate review
      // comments. The gap between the interactive turn and the wake was 63
      // seconds, which is why this is checked HERE, at claim time, and not
      // when the task was scheduled.
      //
      // Deliberately no write-back to the row: leaving `next_run_at` untouched
      // and the task UNCLAIMED means the next tick (60s away) re-evaluates for
      // free, and "how long have we been deferring" is just "how overdue is
      // this task" — so the MAX_DEFERRAL_MS starvation ceiling needs no extra
      // state and no migration. The task is not marked run, so run_count,
      // one-off deactivation and maxRuns all stay honest.
      //
      // Command tasks are NOT exempt, despite running no harness themselves.
      // The shipped contract tells a poller to call `phantombot ask` when it
      // finds work (`persona/builder.ts`, and the Jira example in the README),
      // and `ask` starts a full `runTurn` in yet another process. Exempting
      // command tasks would leave that documented path as an unguarded back
      // door into the exact collision this defers against — the poller fires
      // mid-conversation, decides there is work, and wakes an agent anyway.
      // Deferring the poller is cheap and safe: it is idempotent by
      // construction, the next tick re-evaluates 60s later, and MAX_DEFERRAL_MS
      // still guarantees it runs.
      const verdict = shouldDeferWake(task.persona, task.nextRunAt, { now });
      if (verdict.defer) {
        log.info("tick: deferring task wake", {
          id: task.id,
          description: task.description,
          persona: task.persona,
          isCommandTask: isCommandTask(task),
          reason: verdict.reason,
          overdueMs: now.getTime() - task.nextRunAt.getTime(),
        });
        continue;
      }

      const agentDir = personaDir(config, task.persona);
      if (!existsSync(agentDir)) {
        log.error("tick: persona dir missing — skipping task", {
          id: task.id,
          persona: task.persona,
          agentDir,
        });
        continue;
      }

      if (!isCommandTask(task)) {
        const inFlight = liveWakesByPersona.get(task.persona) ?? 0;
        if (inFlight >= maxConcurrentWakes) {
          log.info(
            "tick: persona at wake concurrency cap — deferring to next tick",
            {
              id: task.id,
              persona: task.persona,
              inFlight,
              maxConcurrentWakes,
            },
          );
          continue;
        }
      }

      // Atomic claim: the loser of a race with another tick gets undefined
      // here and simply skips — that task was dispatched by the winner.
      const claimed = taskStore.claimForRun(task.id, {
        claimedAt: now.getTime(),
        host: hostname(),
        pid: process.pid,
        nowMs: now.getTime(),
      });
      if (!claimed) {
        log.debug("tick: claim refused — live claim holds it", {
          id: task.id,
        });
        continue;
      }
      if (isCommandTask(task)) {
        claimedCommands.push(claimed);
      } else {
        claimedWakes.push(claimed);
        liveWakesByPersona.set(
          task.persona,
          (liveWakesByPersona.get(task.persona) ?? 0) + 1,
        );
      }
    }

    if (claimedCommands.length === 0 && claimedWakes.length === 0) {
      log.debug("tick: nothing to dispatch after claiming");
      return 0;
    }
    log.info("tick: dispatching claimed tasks", {
      commands: claimedCommands.length,
      wakes: claimedWakes.length,
    });
  } finally {
    // The lock covers SELECTION ONLY (issue #631). From here on the claims —
    // not the lock — are what stops a second tick from double-firing a task,
    // so the next minute's tick can start (and dispatch its own due set)
    // while this one is still finishing long work.
    lock.release();
  }

  // ══ Phase B — dispatch, lock-free ══
  try {
    // Command tasks first, in-process and serial. They are bounded by the
    // persona's harnessHardTimeoutMs and run to completion here; a second
    // tick that starts meanwhile sees their live claim and does not
    // double-fire them.
    for (const task of claimedCommands) {
      const startedAt = Date.now();
      let finalText = "";
      let runError: string | undefined;
      let exitCode = 0;
      try {
        const taskConfig = await effectiveConfigFor(task.persona);
        const result = await runCommandTask(task.command!, {
          timeoutMs: taskConfig.harnessHardTimeoutMs,
          cwd: personaDir(config, task.persona),
          env: await buildCommandEnv(
            taskConfig,
            task.persona,
            task.commandSecrets,
          ),
        });
        finalText = result.output;
        exitCode = result.exitCode;
        if (result.exitCode !== 0) {
          runError = `command exited ${result.exitCode}`;
        }
      } catch (e) {
        runError = (e as Error).message;
        exitCode = 1;
        log.error("tick: task threw", {
          id: task.id,
          error: runError,
        });
      }
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
      taskStore.recordRun(task.id, now);
      taskStore.releaseClaim(task.id);
      const durationMs = Date.now() - startedAt;
      if (runError) {
        log.error("tick: command task failed", {
          taskId: task.id,
          description: task.description,
          persona: task.persona,
          durationMs,
          exitCode,
          error: redactForLog(runError),
        });
      } else {
        log.info("tick: command task completed", {
          taskId: task.id,
          description: task.description,
          persona: task.persona,
          durationMs,
          outputChars: finalText.length,
        });
      }
      out.write(
        `tick: task ${task.id} done (${finalText.length} chars, ${status})\n`,
      );
    }

    // Agent wakes: detached children (issue #631). The parent exits right
    // after dispatching; the child owns the run, the task_runs row, the row
    // advance and the claim release.
    for (const task of claimedWakes) {
      try {
        await (input.spawnWake ?? spawnWakeChild)(task, { err });
      } catch (e) {
        log.error("tick: failed to dispatch wake child", {
          taskId: task.id,
          persona: task.persona,
          error: (e as Error).message,
        });
        // Release so the next tick re-dispatches instead of waiting for the
        // stale-claim sweep on this (short-lived) process's pid.
        taskStore.releaseClaim(task.id);
      }
    }
    return 0;
  } finally {
    if (!input.taskStore) taskStore.close();
  }
}

/**
 * Run ONE claimed agent wake to completion (issue #631).
 *
 * This is the body the tick parent used to run inline under the global lock.
 * It now runs in a DETACHED child process (`phantombot tick --run-task <id>`)
 * that owns everything about the run: it re-derives the prompt/review shape
 * from the task row and the claim instant, runs the turn, writes the
 * task_runs row, advances next_run_at (or deactivates a one-off / records
 * the review) and releases the claim. It does NOT take the tick lock — the
 * claim is the ownership token — and it does NOT re-check the #391
 * conversation deferral (the parent deferred before claiming; a wake already
 * dispatched must not starve because the owner started typing seconds later).
 *
 * Also callable in-process (tests, `spawnWake` seam): every store/harness
 * input is injectable, and production defaults are resolved exactly like the
 * old inline path.
 */
export interface RunTaskWakeInput {
  config?: Config;
  /** "Now" injection point — tests pass a fixed instant. */
  now?: Date;
  taskStore?: TaskStore;
  memory?: MemoryStore;
  /** Inject harnesses for testing; production builds the persona's chain. */
  harnesses?: Harness[];
  /** Build a task's effective chain (test seam for persona routing). */
  buildHarnesses?: typeof buildHarnessChain;
  /**
   * Resolve one persona's EFFECTIVE config (test seam, phantombot#439).
   * Production layers `<persona>/config.toml` over the host globals.
   */
  loadPersonaConfig?: (persona: string) => Promise<Config>;
  /**
   * Override the wake's wall-clock budget (test seam). Default:
   * {@link BACKGROUND_WAKE_HARD_TIMEOUT_MS} — the TOTAL for the wake, shared
   * across the harness chain via the runWithFallback deadline.
   */
  wakeBudgetMs?: number;
  out?: WriteSink;
  err?: WriteSink;
}

export async function runTaskWake(
  taskId: number,
  input: RunTaskWakeInput = {},
): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  let config = input.config ?? (await loadConfig());
  const now = input.now ?? new Date();

  const taskStore = input.taskStore ?? (await openTaskStore(config.memoryDbPath));
  const memory = input.memory ?? (await openMemoryStore(config.memoryDbPath));
  try {
    const task = taskStore.get(taskId);
    if (!task || !task.active) {
      log.warn("tick: wake child found no active task — nothing to run", {
        taskId,
      });
      return 1;
    }

    const claim = task.claim;
    const claimedAtMs = claim?.claimedAt ?? now.getTime();
    // The parent decided review-vs-run at claim time; re-derive from the
    // SAME instant so a child that starts seconds late (cold runtime start,
    // a queue of dispatches) cannot flip a normal run into a review or vice
    // versa. Falls back to "now" only if the claim is missing entirely.
    const isReview = task.nextReviewAt.getTime() <= claimedAtMs;
    const promptText = isReview
      ? buildReviewPrompt(task)
      : appendHygieneFooter(task);
    const conversation = isReview
      ? `tick:${task.id}:review`
      : `tick:${task.id}`;

    // This persona's EFFECTIVE config (phantombot#439): the row stores the
    // persona; harness chain, timeouts, retrieval policy live in that
    // persona's config.toml, layered over the host globals.
    const personaConfigs = new Map<string, Config>();
    const resolvePersonaConfig = async (persona: string): Promise<Config> => {
      if (input.loadPersonaConfig) return input.loadPersonaConfig(persona);
      if (persona === (config.personaLayer ?? config.defaultPersona)) {
        return config;
      }
      const cached = personaConfigs.get(persona);
      if (cached) return cached;
      let resolved: Config;
      try {
        resolved = await loadConfig(persona);
      } catch (e) {
        // A persona whose file cannot be read still runs — on the host
        // layer, exactly as it did before per-persona config existed.
        log.warn("tick: could not load persona config, using host layer", {
          persona,
          error: (e as Error).message,
        });
        resolved = config;
      }
      personaConfigs.set(persona, resolved);
      return resolved;
    };
    const effectiveConfigFor = async (persona: string): Promise<Config> =>
      withHostHarnessBins(await resolvePersonaConfig(persona), config);

    const agentDir = personaDir(config, task.persona);
    if (!existsSync(agentDir)) {
      log.error("tick: persona dir missing — aborting wake child", {
        id: task.id,
        persona: task.persona,
        agentDir,
      });
      taskStore.releaseClaim(task.id);
      return 1;
    }

    log.info("tick: background wake started", {
      taskId: task.id,
      description: task.description,
      persona: task.persona,
      conversation,
      runCount: task.runCount,
      isReview,
    });

    let finalText = "";
    let runError: string | undefined;
    let exitCode = 0;
    const startedAt = Date.now();
    // One wall-clock budget across the WHOLE harness chain (#631).
    const wakeBudgetMs = input.wakeBudgetMs ?? BACKGROUND_WAKE_HARD_TIMEOUT_MS;
    const chainDeadlineMs = startedAt + wakeBudgetMs;
    try {
      // Resolve harness binaries against the live filesystem the same way
      // the `run` daemon does — the tick oneshot otherwise relied solely on
      // the systemd unit's narrow Environment=PATH, so a PATH-relative `pi`
      // could fail with `exit 127` (issue #181 §1). The wake child resolves
      // its own; the parent no longer pays the filesystem search at all.
      // Skipped when harnesses are injected (tests): they ARE the chain.
      if (input.harnesses === undefined) {
        ({ config } = await resolveHarnessBinsForConfig(config, { err }));
      }
      const taskConfig = await effectiveConfigFor(task.persona);
      const taskHarnesses =
        input.harnesses ??
        (input.buildHarnesses ?? buildHarnessChain)(
          taskConfig,
          err,
          task.persona,
        );
      if (taskHarnesses.length === 0) {
        throw new Error("no harnesses configured");
      }
      for await (const chunk of runTurn({
        persona: task.persona,
        conversation,
        userMessage: promptText,
        agentDir,
        // Interactive surface: the owner asks for work on repos all over their
        // home dir, so home stays the cwd. Explicit since #387 removed the
        // silent homedir() default in runTurn.
        workingDir: homedir(),
        harnesses: taskHarnesses,
        memory,
        idleTimeoutMs: taskConfig.harnessIdleTimeoutMs,
        // #631: the wake budget is TOTAL for the wake, not per harness —
        // runWithFallback clamps every attempt's hard cap to the time left
        // before chainDeadlineMs, so a timed-out primary hands the fallback
        // only what remains instead of a fresh 30 minutes.
        hardTimeoutMs: wakeBudgetMs,
        chainDeadlineMs,
        toolTimeoutMs: Math.min(
          taskConfig.harnessToolTimeoutMs ?? 1_200_000,
          wakeBudgetMs,
        ),
        thinkingTimeoutMs: taskConfig.harnessThinkingTimeoutMs,
        promptCache: taskConfig.promptCache,
        // #324: an agent-woken task should wake with the same memory
        // instincts a conversation turn gets — semantic recall + durable
        // facts on the READ side, and consolidate its observations back on
        // the WRITE side — instead of running context-blind and mute. Each
        // factory self-gates: it returns undefined when its feature is
        // disabled in config, so this is a no-op when retrieval/durable
        // facts are off. (--command tasks never reach here — they stay
        // blind/mute by design.)
        retrieve: makeRetriever(
          taskConfig,
          task.persona,
          agentDir,
          conversation,
        ),
        indexTurns: makeTurnIndexer(
          taskConfig,
          task.persona,
          conversation,
          memory,
        ),
        pullFacts: makeDurableFactPuller(
          taskConfig,
          task.persona,
          conversation,
          memory,
        ),
        // #626 — NEVER extract in-process here: tick is a short-lived
        // oneshot whose teardown closes the shared SQLite handle under
        // the fire-and-forget extraction, silently dropping the facts
        // (Matt: 1072 losses vs 22 wins). The awaited enqueue after the
        // turn hands the pass to the daemon's drain loop instead.
        extractFacts: false,
        // Provenance: an autonomous task wake can ingest UNTRUSTED content
        // mid-turn (email body, web page, Plane issue) via tools — content
        // the threat judge never screened because it arrives as tool output,
        // not a judged `ask` turn (#327). So stamp BOTH turns `other`: every
        // durable fact a task produces lands in the untrusted tier (weight
        // 0.3, 7-day half-life, injected only tagged `unverified`, never
        // recall-bumped) and can never masquerade as first-hand `self`
        // knowledge or poison the persona-wide pool one tier below the owner.
        // Conservative by design — we can't tell here which task wakes truly
        // ingested untrusted content, so all are treated as if they did.
        // NOT `trusted`: a task has no principal command authority either.
        userSource: "other",
        assistantSource: "other",
        // ORIGIN, not trust: `other` above says "do not trust this like
        // the principal", which a stranger in a group chat also gets.
        // This says "a scheduled task produced it" — the distinction
        // that lets tier-2 retrieval avoid replaying my own unreviewed
        // speculation back to me as though someone had said it.
        origin: "task",
      })) {
        logBackgroundWakeChunk(task, conversation, chunk);
        if (chunk.type === "text") finalText += chunk.text;
        if (chunk.type === "done") finalText = chunk.finalText;
      }
      // #626 — hand eviction-cliff extraction to the daemon drain. This
      // is AWAITED (a plain INSERT) so the request is durable BEFORE the
      // finally below closes the DB — the exact guarantee the old
      // fire-and-forget extraction could not give. A failed insert
      // THROWS into the catch below: visible failure, not silent loss.
      await requestFactExtractionIfEnabled(
        taskConfig,
        task.persona,
        conversation,
        memory,
      );
    } catch (e) {
      runError = (e as Error).message;
      exitCode = 1;
      log.error("tick: task threw", {
        id: task.id,
        error: runError,
      });
    }

    const fields = {
      taskId: task.id,
      description: task.description,
      persona: task.persona,
      conversation,
      runCount: task.runCount,
      isReview,
      durationMs: Date.now() - startedAt,
      outputChars: finalText.length,
    };
    if (runError) {
      log.error("tick: background wake failed", {
        ...fields,
        error: redactForLog(runError),
      });
    } else {
      log.info("tick: background wake completed", {
        ...fields,
        status: "ok",
      });
    }

    // Log the fire to task_runs for auditability.
    const outputExcerpt = runError
      ? `ERROR: ${runError}${finalText ? `\n${finalText}` : ""}`.slice(0, 500)
      : finalText.slice(0, 500);
    const status = runError ? "error" : "ok";

    // Quiet-by-default: neither tick nor the wake child auto-posts the
    // harness reply to Telegram. The agent calls `phantombot notify` from
    // inside the prompt if it wants the user to see something. `delivered`
    // is recorded false for back-compat with the task_runs schema; it no
    // longer corresponds to a tick-side delivery decision.
    taskStore.logRun({
      taskId: task.id,
      firedAt: now,
      status: status as "ok" | "error",
      exitCode,
      outputExcerpt,
      delivered: false,
    });

    // Record BEFORE releasing the claim: if the child dies between the two,
    // the next tick finds the task no longer due (recordRun advanced it /
    // deactivated the one-off) and only the claim needs sweeping — the
    // reverse order would let a crash re-fire a completed run.
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
    taskStore.releaseClaim(task.id);
    out.write(
      `tick: task ${task.id} done (${finalText.length} chars, ${status})\n`,
    );
    return runError ? 1 : 0;
  } finally {
    if (!input.taskStore) taskStore.close();
    if (!input.memory) await memory.close();
  }
}

/**
 * The argv that re-invokes THIS phantombot for a wake child. Compiled
 * binary: the binary itself. From source (`bun src/index.ts`): the bun
 * runtime re-running this checkout's entry point — same shape
 * `embeddedPiCommand` uses for the embedded pi engine.
 */
function tickSelfCommand(): { cmd: string; args: string[] } {
  if (isCompiledBinary()) return { cmd: process.execPath, args: ["tick"] };
  return {
    cmd: process.execPath,
    args: [resolve(import.meta.dir, "..", "index.ts"), "tick"],
  };
}

/**
 * Environment for the wake child: the parent's env with every key THIS
 * process injected from a VAULT scrubbed, plus the TASK persona's identity.
 *
 * The tick parent's env carries the startup persona's vault secrets
 * (injected by the index.ts bootstrap, tracked by vaultEnvTracking). The
 * child is a full CLI invocation that bootstraps the TASK persona's vault
 * itself — but `loadVaultIntoEnv`'s sticky rule ("a key already in the
 * environment at boot wins") means an inherited foreign-persona secret would
 * SHADOW the task persona's own value and leak into its harness spawns.
 * Scrubbing the tracked keys here gives the child clean provenance: it boots
 * with host-wide env only, and its own bootstrap injects exactly its
 * persona's secrets.
 */
function wakeChildEnv(persona: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...NON_INTERACTIVE_ENV, ...process.env };
  for (const key of vaultTrackedKeys()) delete env[key];
  env.PHANTOMBOT_PERSONA = persona;
  return env;
}

/**
 * Whether `systemd-run --user --scope` is worth trying for cgroup escape.
 * Optimistic on Linux: the actual spawn falls back to a plain detached child
 * if systemd-run errors, and the next tick retries via the stale-claim sweep.
 */
function systemdScopeAvailable(): boolean {
  return process.platform === "linux";
}

/**
 * Dispatch one agent wake as a DETACHED child process (issue #631).
 *
 * The child is `phantombot tick --run-task <id>` with PHANTOMBOT_PERSONA set
 * to the task's persona, so its index.ts bootstrap injects the TASK persona's
 * vault. The parent does not wait for it — the tick process exits right
 * after dispatch, which is the entire point.
 *
 * On Linux the child launches through `systemd-run --user --scope --collect`
 * so it lives in its own TRANSIENT scope cgroup. A plain child of the tick
 * oneshot would be killed by systemd the moment the tick unit deactivates
 * (KillMode=control-group is the default) — exactly when the parent exits.
 * On launchd, Windows and non-systemd Linux a plain detached spawn survives
 * its parent, so that is the fallback there.
 */
async function spawnWakeChild(
  task: Task,
  _opts: { err: WriteSink },
): Promise<void> {
  const self = tickSelfCommand();
  const args = [...self.args, "--run-task", String(task.id)];
  const env = wakeChildEnv(task.persona);

  // stdio inherit: the child's structured logs (wake lifecycle, task throws)
  // land wherever the tick unit's stdout/stderr goes — the journal on
  // systemd, the plist's StandardErrorPath on launchd. A wake that dies
  // silently is exactly what #631 is trying to make impossible.
  const spawnOpts = {
    env,
    stdio: "inherit" as const,
    detached: true,
    windowsHide: true,
  };

  let scoped = systemdScopeAvailable();
  const child = spawn(
    scoped ? "systemd-run" : self.cmd,
    scoped
      ? [
          "--user",
          "--scope",
          "--collect",
          `--unit=phantombot-wake-${task.id}-${Date.now()}`,
          self.cmd,
          ...args,
        ]
      : args,
    spawnOpts,
  );
  child.on("error", (e) => {
    if (scoped) {
      // systemd-run itself failed (missing binary, no user bus). Retry once
      // as a plain detached child: on launchd/Windows/non-systemd Linux that
      // is the correct launch anyway, and on a systemd host it at least runs
      // until the tick unit deactivates instead of never running at all.
      scoped = false;
      log.warn("tick: scoped wake spawn failed — retrying as plain child", {
        taskId: task.id,
        persona: task.persona,
        error: e.message,
      });
      const plain = spawn(self.cmd, args, spawnOpts);
      plain.on("error", (e2) => {
        // The claim stays held by THIS (now exiting) process's pid — the
        // next tick's stale-claim sweep releases it and re-dispatches.
        log.error("tick: wake child spawn failed — will retry next tick", {
          taskId: task.id,
          persona: task.persona,
          error: e2.message,
        });
      });
      plain.unref();
      return;
    }
    // The claim stays held by THIS (now exiting) process's pid — the next
    // tick's stale-claim sweep releases it and re-dispatches. Loud here so
    // a persistently failing dispatch is visible in the journal.
    log.error("tick: wake child spawn failed — will retry next tick", {
      taskId: task.id,
      persona: task.persona,
      error: e.message,
    });
  });
  child.unref();
  log.info("tick: wake child dispatched", {
    taskId: task.id,
    persona: task.persona,
    scoped,
  });
}
function unrefTimer(t: ReturnType<typeof setTimeout>): void {
  if (typeof (t as { unref?: () => void }).unref === "function") {
    (t as { unref: () => void }).unref();
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
      // Put the subshell in its own process group on POSIX so timeouts kill
      // the entire descendant tree (e.g. commands spawned by sh -c).
      detached: process.platform !== "win32",
      // With shell:true Windows spawns cmd.exe, which pops a visible console
      // window per command task. Suppress it (issue #271); no-op on POSIX.
      windowsHide: true,
    });

    let output = "";
    const append = (chunk: Buffer) => {
      output = appendCommandOutput(output, chunk.toString());
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    timer = setTimeout(() => {
      if (typeof child.pid === "number" && child.pid > 0) {
        const pgid = child.pid;
        signalProcessGroup(pgid, "SIGTERM");
        // Escalate to SIGKILL after 3s to reap any SIGTERM-resistant processes
        // in the process group. Unref'd so it never stalls tick exit on its own;
        // signalProcessGroup swallows ESRCH if the group is already dead.
        unrefTimer(
          setTimeout(() => {
            signalProcessGroup(pgid, "SIGKILL");
          }, 3000),
        );
      } else {
        child.kill("SIGTERM");
      }
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

/**
 * Build the minimal environment for a command-backed task, resolving each
 * `--secret NAME` from the TASK'S OWN persona vault (#452).
 *
 * `process.env` is the wrong source here. One tick process runs tasks for
 * EVERY persona, but only the startup persona's vault was injected into the
 * ambient environment — so reading `process.env[name]` hands persona B's
 * poller either persona A's credential or nothing. Both are wrong, and the
 * first is worse: it is a silent cross-persona credential leak.
 *
 * The `process.env` fallback survives, but narrowed: only for names that were
 * NOT vault-injected by this process. Those are genuinely host-wide (a shell
 * export, a systemd `Environment=`) and belong to no persona; a vault-injected
 * name belongs to exactly one, and must not stand in for another's.
 */
async function buildCommandEnv(
  config: Config,
  persona: string,
  secretNames: string[],
): Promise<NodeJS.ProcessEnv> {
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
  // Windows-only additions (issue #270): without USERPROFILE the spawned
  // process's os.homedir() — and therefore every home-relative config/state
  // path phantombot reads (voice config.toml, personas, .env) — resolves to a
  // DIFFERENT location than the one the wizard wrote to, so voice/memory look
  // "not configured". APPDATA/LOCALAPPDATA back the same home-relative stores;
  // SystemRoot + ComSpec are required for cmd.exe (shell:true) and most Windows
  // binaries to launch at all; PATHEXT lets bare command names resolve their
  // .cmd/.exe form. All are harmless no-ops when absent (POSIX).
  if (process.platform === "win32") {
    allowlist.push(
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "SystemRoot",
      "SystemDrive",
      "ComSpec",
      "PATHEXT",
      "Path",
    );
  }
  const env: NodeJS.ProcessEnv = {
    ...NON_INTERACTIVE_ENV,
  };
  for (const name of allowlist) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  // #505 — the command MUST know which persona owns it.
  //
  // A command task is per-persona, exactly like an agent-backed one, and the
  // documented contract tells the checker to shell back into `phantombot`
  // (`ask`, `notify`, `mcp call`, `memory ...`). Those commands resolve their
  // persona through `resolvePersona`: --persona, then PHANTOMBOT_PERSONA, then
  // the HOST DEFAULT. With no PHANTOMBOT_PERSONA in this minimal env, every
  // poller silently fell through to the default persona — reading another
  // persona's vault, memory and MCP registry. That is a correctness bug, not
  // an ergonomic one, and its quiet form (an empty registry behind a stale
  // default) is what silently stopped email triage for ~200 fires.
  //
  // Set AFTER the allowlist copy so the owning persona always wins over an
  // ambient PHANTOMBOT_PERSONA inherited by the tick process itself.
  env.PHANTOMBOT_PERSONA = persona;
  if (env.PATH === undefined && process.platform !== "win32") {
    env.PATH = "/usr/local/bin:/usr/bin:/bin";
  }
  for (const name of secretNames) {
    const fromVault = await getPersonaSecretStrict(config, name, persona);
    if (fromVault !== undefined) {
      env[name] = fromVault;
      continue;
    }
    // Not in this persona's vault. Ambient host values are still fair game,
    // as is a key injected from THIS persona's own vault (a same-persona open
    // blip leaves it in place); another persona's vault value is not.
    const ambient = process.env[name];
    if (ambient !== undefined && ambientEnvKeyAllowed(config, name, persona)) {
      env[name] = ambient;
    }
  }
  return env;
}

function appendCommandOutput(current: string, next: string): string {
  const combined = current + next;
  if (combined.length <= 4000) return combined;
  return `${combined.slice(0, 1900)}\n... output truncated ...\n${combined.slice(-1900)}`;
}

function logBackgroundWakeChunk(
  task: Task,
  conversation: string,
  chunk: HarnessChunk,
): void {
  const fields = {
    taskId: task.id,
    description: task.description,
    persona: task.persona,
    conversation,
    chunkType: chunk.type,
  };

  if (chunk.type === "text") {
    log.info("tick: background wake stream", {
      ...fields,
      chars: chunk.text.length,
      ...previewForLog(chunk.text),
    });
    return;
  }

  if (chunk.type === "replay") {
    // Narration-decay replay (issue #551): model reasoning — redact the
    // preview so nothing lands in persisted logs.
    log.info("tick: background wake stream", {
      ...fields,
      chars: chunk.note.length,
      preview: "(reasoning replay — redacted)",
      truncated: false,
    });
    return;
  }

  if (chunk.type === "progress") {
    log.info("tick: background wake stream", {
      ...fields,
      chars: chunk.note.length,
      ...previewForLog(chunk.note),
    });
    return;
  }

  if (chunk.type === "done") {
    log.info("tick: background wake stream", {
      ...fields,
      chars: chunk.finalText.length,
      ...previewForLog(chunk.finalText),
      meta: chunk.meta,
    });
    return;
  }

  if (chunk.type === "error") {
    log.warn("tick: background wake stream", {
      ...fields,
      recoverable: chunk.recoverable,
      httpStatus: chunk.httpStatus,
      chars: chunk.error.length,
      ...previewForLog(chunk.error),
    });
    return;
  }

  log.debug("tick: background wake stream", fields);
}

export function previewForLog(text: string): {
  preview: string;
  truncated: boolean;
} {
  const redacted = redactForLog(text);
  return {
    preview: redacted.slice(0, WAKE_STREAM_PREVIEW_CHARS),
    truncated: redacted.length > WAKE_STREAM_PREVIEW_CHARS,
  };
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
  args: {
    "run-task": {
      type: "string",
      description:
        "INTERNAL (issue #631): run one already-claimed task in this process. Tick dispatches agent wakes as detached children with this flag; it is not for interactive use.",
    },
  },
  async run(ctx) {
    const runTaskArg = ctx.args["run-task"];
    if (runTaskArg !== undefined) {
      const id = Number(runTaskArg);
      if (!Number.isInteger(id) || id <= 0) {
        process.stderr.write(
          "phantombot tick: --run-task needs a numeric task id\n",
        );
        process.exitCode = 2;
        return;
      }
      process.exitCode = await runTaskWake(id);
      return;
    }
    process.exitCode = await runTick();
  },
});
