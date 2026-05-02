/**
 * Shared kill/timeout coordination for harness subprocesses.
 *
 * Every harness (claude/gemini/pi) needs the same machinery:
 *
 *   - spawn the binary in a fresh process group (so grandchildren die too)
 *   - run an idle timer that resets on every chunk from stdout
 *   - run a hard wall-clock timer that never resets
 *   - listen for an external AbortSignal (the user typed /stop)
 *   - on any of those firing, SIGTERM → 5s grace → SIGKILL the whole group
 *
 * Factoring this into one place keeps the three harness files focused on
 * their per-CLI parsing and prevents the kill semantics from drifting
 * between them (which is exactly what bit us before — claude knew about
 * /stop but gemini didn't).
 *
 * Usage shape:
 *
 *   const runner = createKillCoordinator({
 *     proc, idleTimeoutMs, hardTimeoutMs, signal, harnessId,
 *   });
 *   try {
 *     for await (const chunk of proc.stdout) {
 *       runner.touch();   // resets idle timer
 *       // ...emit chunks...
 *     }
 *   } finally {
 *     await runner.dispose();
 *   }
 *   const cause = runner.killCause();   // 'timeout' | 'idle' | 'aborted' | undefined
 */

import type { Subprocess, SpawnOptions } from "bun";
import { killProcessGroup } from "./processGroup.ts";
import { log } from "./logger.ts";

export type KillCause = "timeout" | "idle" | "aborted" | undefined;

export interface KillCoordinatorOpts {
  proc: Subprocess<
    SpawnOptions.Writable,
    SpawnOptions.Readable,
    SpawnOptions.Readable
  >;
  /** Kill if no chunk seen for this long. Resets via touch(). */
  idleTimeoutMs: number;
  /** Hard wall-clock cap. Never resets. */
  hardTimeoutMs: number;
  /** External abort, e.g. user typed /stop. */
  signal?: AbortSignal;
  /** For log lines only. */
  harnessId: string;
  /** Grace period between SIGTERM and SIGKILL. Default 5000ms. */
  graceMs?: number;
}

export interface KillCoordinator {
  /** Reset the idle timer. Call after every emitted chunk. */
  touch(): void;
  /** Stop all timers and detach signal listener. Idempotent. */
  dispose(): Promise<void>;
  /** Why the process was killed, if it was. undefined = exited normally. */
  killCause(): KillCause;
}

export function createKillCoordinator(
  opts: KillCoordinatorOpts,
): KillCoordinator {
  const graceMs = opts.graceMs ?? 5000;
  let cause: KillCause;
  let disposed = false;

  const triggerKill = (newCause: Exclude<KillCause, undefined>): void => {
    if (cause || disposed) return;
    cause = newCause;
    log.warn(`${opts.harnessId}.invoke killed: ${newCause}`, {
      idleTimeoutMs: opts.idleTimeoutMs,
      hardTimeoutMs: opts.hardTimeoutMs,
    });
    // Fire-and-forget; the for-await over stdout will end naturally as
    // the kernel closes the pipe after SIGKILL.
    void killProcessGroup(opts.proc, graceMs);
  };

  let idleTimer: ReturnType<typeof setTimeout> = setTimeout(
    () => triggerKill("idle"),
    opts.idleTimeoutMs,
  );
  const hardTimer: ReturnType<typeof setTimeout> = setTimeout(
    () => triggerKill("timeout"),
    opts.hardTimeoutMs,
  );

  const onAbort = (): void => triggerKill("aborted");
  if (opts.signal) {
    if (opts.signal.aborted) {
      onAbort();
    } else {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  return {
    touch(): void {
      if (cause || disposed) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => triggerKill("idle"),
        opts.idleTimeoutMs,
      );
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      if (opts.signal && !opts.signal.aborted) {
        opts.signal.removeEventListener("abort", onAbort);
      }
    },
    killCause(): KillCause {
      return cause;
    },
  };
}

/**
 * Render the standard "killed by X" HarnessChunk for a kill cause.
 * Returns undefined if the process exited naturally (no kill).
 *
 *   - "timeout"  → recoverable (orchestrator advances to next harness)
 *   - "idle"     → recoverable (same — wedged subprocess, try a different one)
 *   - "aborted"  → non-recoverable (user said /stop and meant it)
 */
export function killCauseToErrorChunk(
  cause: KillCause,
  harnessId: string,
  hardTimeoutMs: number,
  idleTimeoutMs: number,
):
  | { type: "error"; error: string; recoverable: boolean }
  | undefined {
  if (cause === "timeout") {
    return {
      type: "error",
      error: `${harnessId} timed out after ${hardTimeoutMs}ms (hard wall-clock cap)`,
      recoverable: true,
    };
  }
  if (cause === "idle") {
    return {
      type: "error",
      error: `${harnessId} timed out after ${idleTimeoutMs}ms with no output (likely wedged on a tool call)`,
      recoverable: true,
    };
  }
  if (cause === "aborted") {
    return { type: "error", error: "stopped", recoverable: false };
  }
  return undefined;
}
