/**
 * Shared kill/timeout coordination for harness subprocesses.
 *
 * Every harness (claude/gemini/pi) needs the same machinery:
 *
 *   - spawn the binary in a fresh process group (so grandchildren die too)
 *   - run an idle timer that resets on useful activity from stdout
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
 *       runner.touch("productive"); // resets idle timer
 *       // ...emit chunks...
 *     }
 *   } finally {
 *     await runner.dispose();
 *   }
 *   const cause = runner.killCause();   // 'timeout' | 'idle' | 'aborted' | undefined
 */

import type { FileSink, Subprocess, SpawnOptions } from "bun";
import { killProcessGroup } from "./processGroup.ts";
import { log } from "./logger.ts";
import type { HarnessChunk, HarnessRequest } from "../harnesses/types.ts";

type HarnessSubprocess = Subprocess<
  SpawnOptions.Writable,
  SpawnOptions.Readable,
  SpawnOptions.Readable
>;

export type KillCause = "timeout" | "idle" | "aborted" | undefined;
export type HarnessActivity = "model" | "tool" | "productive";

export interface KillCoordinatorOpts {
  proc: HarnessSubprocess;
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
  /**
   * Record subprocess activity.
   *
   * - productive: visible text, completed tool output, non-JSON stdout, done
   * - model: model-side thinking/progress while no tool is known to be running
   * - tool: tool invocation/start; later generic model heartbeats do not extend
   *   the idle window until productive output arrives
   */
  touch(activity?: HarnessActivity): void;
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
  let toolRunning = false;

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
    touch(activity: HarnessActivity = "productive"): void {
      if (cause || disposed) return;
      if (activity === "tool") {
        toolRunning = true;
      } else if (activity === "productive") {
        toolRunning = false;
      } else if (toolRunning) {
        return;
      }
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

/**
 * Drain a subprocess stderr stream line-by-line, invoking `onLine` for every
 * non-empty trimmed line. Swallows read errors (a stderr drain must never take
 * down the harness). This is the single copy of the buffer/decode/split loop
 * that used to be duplicated verbatim in every harness file; per-harness
 * policy (log level, banner filtering, HTTP-status scanning) lives in `onLine`.
 */
export async function drainStderr(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for await (const chunk of stream) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) onLine(trimmed);
      }
    }
  } catch {
    /* swallow — stderr drain shouldn't take down the harness */
  }
}

/**
 * The shared "run the subprocess and pump its JSONL stdout" engine.
 *
 * Every harness used to reimplement this same body: write stdin, arm the kill
 * coordinator, drain stderr, loop over stdout splitting on newlines, JSON.parse
 * each line, translate it to a HarnessChunk via the harness's parser, feed the
 * idle timer via the harness's activity classifier, accumulate `text` chunks
 * into finalText, capture a mid-stream `done` event's meta, then after the loop
 * translate kill-cause / exit-code into the terminal chunk. ~70% of each
 * harness file was this. Now it lives here once; harnesses supply only the
 * per-CLI variable points via the spec.
 *
 * The caller spawns the process (it owns the CLI-specific args/env/stdin-mode)
 * and hands the live Subprocess in. The generator yields the same chunk stream
 * the old hand-written loops did — `done`/`error` are always synthesized HERE,
 * so a parser that returns a `done` chunk mid-stream only contributes its meta.
 */
export interface HarnessProcessSpec {
  /** The already-spawned subprocess. The harness owns args/env/stdin-mode. */
  proc: HarnessSubprocess;
  /** The originating request (for timeouts, signal, harnessId labelling). */
  req: HarnessRequest;
  /** Stable harness id, e.g. "claude". Used in logs and terminal chunks. */
  harnessId: string;
  /** Payload to write to stdin then close. Omit for argv-only harnesses (pi). */
  stdinPayload?: string;
  /** Translate one parsed stdout line into a HarnessChunk (or undefined). */
  parseEvent: (parsed: unknown) => HarnessChunk | undefined;
  /** Classify a chunk for the idle timer (model / tool / productive). */
  activity: (parsed: unknown, chunk: HarnessChunk) => HarnessActivity;
  /**
   * Build the terminal `done` chunk's meta from the accumulated final text and
   * the meta captured from any mid-stream `done` event the parser emitted
   * (codex usage, gemini stats). Always includes whatever the harness wants —
   * harnessId is the caller's responsibility to add.
   */
  buildDoneMeta: (
    finalText: string,
    captured: Record<string, unknown> | undefined,
  ) => Record<string, unknown>;
  /** Cap for a non-JSON progress note. Omit for the full line (claude/pi). */
  progressNoteLimit?: number;
  /** Side-effect for each non-JSON stdout line (e.g. gemini debug log). */
  onNonJsonLine?: (line: string) => void;
  /** Per-line stderr handler. Defaults to a debug log tagged with harnessId. */
  onStderrLine?: (line: string) => void;
  /** Parse the decoder tail after stdout closes (gemini's trailing line). */
  flushTail?: boolean;
  /**
   * Terminal error to emit with priority over kill-cause / exit-code, e.g.
   * gemini's mid-stream 4XX fast-fallback. Called after the loop; if it returns
   * a chunk, the engine drains the process and yields that instead.
   */
  earlyError?: () =>
    | { type: "error"; error: string; recoverable: boolean; httpStatus?: number }
    | undefined;
}

export async function* runHarnessProcess(
  spec: HarnessProcessSpec,
): AsyncGenerator<HarnessChunk> {
  const { proc, req, harnessId } = spec;

  // IMPORTANT: The KillCoordinator must be armed BEFORE any potentially
  // blocking I/O (like stdin.write). If the child process hangs and stops
  // reading stdin, the `await stdin.end()` below will block indefinitely
  // on pipe backpressure. By arming the killer first, we ensure the hard
  // timeout still fires and kills the process group, causing the blocked
  // write to fail with EPIPE (which our catch block handles).
  const killer = createKillCoordinator({
    proc,
    idleTimeoutMs: req.idleTimeoutMs,
    hardTimeoutMs: req.hardTimeoutMs,
    signal: req.signal,
    harnessId,
  });

  // Write stdin then close. EPIPE-tolerant: a proc killed between spawn and
  // write makes stdin unwritable; we don't want that to escape before the
  // for-await loop yields the proper terminal chunk.
  if (spec.stdinPayload !== undefined) {
    try {
      // Concrete narrowing: a harness that supplies stdinPayload spawned with
      // stdin:"pipe", so proc.stdin is a FileSink (the generic Subprocess type
      // widens it to number|FileSink|undefined for the ignore/inherit cases).
      const stdin = proc.stdin as FileSink;
      stdin.write(spec.stdinPayload);
      await stdin.end();
    } catch (e) {
      log.warn(`${harnessId}.invoke stdin write failed`, {
        error: (e as Error).message,
      });
    }
  }

  const onStderrLine =
    spec.onStderrLine ??
    ((line: string) => log.debug(`${harnessId} stderr`, { text: line.slice(0, 500) }));
  void drainStderr(proc.stderr as ReadableStream<Uint8Array>, onStderrLine);

  let buffer = "";
  let finalText = "";
  let captured: Record<string, unknown> | undefined;
  const decoder = new TextDecoder();

  // Translate one parsed line, feed the idle timer, fold text/done. Yields the
  // chunk for everything except `done` (whose meta is captured, not surfaced —
  // the single terminal `done` is synthesized after the loop).
  function* consume(parsed: unknown): Generator<HarnessChunk> {
    const c = spec.parseEvent(parsed);
    if (!c) return;
    killer.touch(spec.activity(parsed, c));
    if (c.type === "text") finalText += c.text;
    if (c.type === "done") {
      captured = c.meta;
      return;
    }
    yield c;
  }

  try {
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      // NB: do NOT touch() here. The idle timer must measure time since last
      // *productive* output, not since last raw chunk — otherwise synthetic
      // heartbeats keep postponing the idle kill on a wedged turn. See #123.
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          spec.onNonJsonLine?.(trimmed);
          killer.touch("productive"); // non-JSON line is real output
          yield {
            type: "progress",
            note: spec.progressNoteLimit
              ? trimmed.slice(0, spec.progressNoteLimit)
              : trimmed,
          };
          continue;
        }
        yield* consume(parsed);
      }
    }
    if (spec.flushTail) {
      buffer += decoder.decode();
      const tail = buffer.trim();
      if (tail) {
        try {
          yield* consume(JSON.parse(tail));
        } catch {
          /* drop trailing partial line */
        }
      }
    }
  } finally {
    await killer.dispose();
  }

  // Priority order matches the old hand-written loops: a harness-specific
  // early error (gemini 4XX) wins over kill-cause, which wins over exit code.
  const early = spec.earlyError?.();
  if (early) {
    await proc.exited;
    yield early;
    return;
  }

  const errChunk = killCauseToErrorChunk(
    killer.killCause(),
    harnessId,
    req.hardTimeoutMs,
    req.idleTimeoutMs,
  );
  if (errChunk) {
    yield errChunk;
    return;
  }

  const code = await proc.exited;
  if (code !== 0) {
    yield {
      type: "error",
      error: `${harnessId} exited with code ${code}`,
      // 127 = command not found — terminal. Anything else (rate limits,
      // network blips, transient model errors) is recoverable so the
      // orchestrator tries the next harness.
      recoverable: code !== 127,
    };
    return;
  }

  yield {
    type: "done",
    finalText,
    meta: spec.buildDoneMeta(finalText, captured),
  };
}
