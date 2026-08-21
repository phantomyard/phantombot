/**
 * Shared kill/timeout coordination for harness subprocesses.
 *
 * Every harness needs the same machinery:
 *
 *   - spawn the binary in a fresh process group (so grandchildren die too)
 *   - run an idle timer that resets on useful activity from stdout
 *   - optionally run a hard wall-clock timer that never resets
 *   - listen for an external AbortSignal (the user typed /stop)
 *   - on any of those firing, SIGTERM → 5s grace → SIGKILL the whole group
 *
 * Factoring this into one place keeps the three harness files focused on
 * their per-CLI parsing and prevents the kill semantics from drifting.
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

export type KillCause =
  | "timeout"
  | "idle"
  | "startup"
  | "aborted"
  | "policy"
  | undefined;
export type HarnessActivity = "model" | "tool" | "productive";

export interface KillCoordinatorOpts {
  proc: HarnessSubprocess;
  /** Kill if no chunk seen for this long. Resets via touch(). */
  idleTimeoutMs: number;
  /** Hard wall-clock cap. Never resets. Omit to disable the wall-clock SIGTERM. */
  hardTimeoutMs?: number;
  /**
   * Cap on time-to-FIRST-stdout-byte. Distinct from idleTimeoutMs, which only
   * starts biting once output has begun and then resets on every chunk — a
   * subprocess that emits NOTHING at all still had to wait the full idle window
   * (default 300s) before the idle timer fired. This bounds that startup phase
   * separately so a harness wedged BEFORE it produces any output (the classic
   * case: `claude --print` blocking its MCP `initialize` handshake on a proxy
   * that never answers — e.g. under Windows SQLite lock contention) fails over
   * to the next harness in seconds, not minutes. Cleared on the first stdout
   * byte via firstOutput(); after that, only idle/hard/tool timers apply. Omit
   * to disable (legacy behaviour: only the idle window bounds startup silence).
   */
  startupTimeoutMs?: number;
  /**
   * Wall-clock cap on how long a SINGLE contiguous tool-run may keep resetting
   * the idle timer via `"tool"` activity WITHOUT any productive output.
   * Measured from the start of the tool-run; any productive output resets the
   * budget. Past this cap, tool activity stops deferring the idle kill, so a
   * wedged-but-chattery tool trips the idle timeout instead of surviving to the
   * hard cap. Omit to disable (tool activity resets the idle timer for as long
   * as it keeps arriving — the legacy behaviour). See touch() and issue #351.
   */
  toolTimeoutMs?: number;
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
  /**
   * Signal that the subprocess has produced its first stdout byte, cancelling
   * the startup timer (see startupTimeoutMs). Idempotent and cheap — the runner
   * calls it on every stdout chunk; only the first call does anything. A no-op
   * when startupTimeoutMs was not set or the coordinator already fired/disposed.
   */
  firstOutput(): void;
  /** Stop all timers and detach signal listener. Idempotent. */
  dispose(): Promise<void>;
  /**
   * Kill the process group immediately as a POLICY violation (terminal
   * tripwire fired). Same SIGTERM → grace → SIGKILL path as the timers;
   * idempotent and a no-op once a cause is set or the coordinator is
   * disposed.
   */
  terminate(): void;
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
  // Wall-clock start of the current contiguous tool-run (undefined when no tool
  // is running). Used with opts.toolTimeoutMs to cap how long tool activity
  // alone may keep deferring the idle kill. See touch().
  let toolRunStart: number | undefined;

  const triggerKill = (newCause: Exclude<KillCause, undefined>): void => {
    if (cause || disposed) return;
    cause = newCause;
    log.warn(`${opts.harnessId}.invoke killed: ${newCause}`, {
      idleTimeoutMs: opts.idleTimeoutMs,
      hardTimeoutMs: opts.hardTimeoutMs ?? "disabled",
    });
    // Fire-and-forget; the for-await over stdout will end naturally as
    // the kernel closes the pipe after SIGKILL.
    void killProcessGroup(opts.proc, graceMs);
  };

  let idleTimer: ReturnType<typeof setTimeout> = setTimeout(
    () => triggerKill("idle"),
    opts.idleTimeoutMs,
  );
  const hardTimer: ReturnType<typeof setTimeout> | undefined =
    opts.hardTimeoutMs === undefined
      ? undefined
      : setTimeout(() => triggerKill("timeout"), opts.hardTimeoutMs);
  // Startup timer: fires only if the subprocess emits NO stdout at all before
  // it elapses. Cancelled by firstOutput() on the first stdout byte. See
  // KillCoordinatorOpts.startupTimeoutMs.
  let startupTimer: ReturnType<typeof setTimeout> | undefined =
    opts.startupTimeoutMs === undefined
      ? undefined
      : setTimeout(() => triggerKill("startup"), opts.startupTimeoutMs);

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
        if (!toolRunning) {
          toolRunning = true;
          toolRunStart = Date.now();
        } else if (
          opts.toolTimeoutMs !== undefined &&
          toolRunStart !== undefined &&
          Date.now() - toolRunStart >= opts.toolTimeoutMs
        ) {
          // This contiguous tool-run has kept the idle timer alive via tool
          // activity for longer than the tool cap WITHOUT any productive
          // (text) output. Past the cap a tool update no longer counts as
          // liveness: fall through WITHOUT re-arming the idle timer, so the
          // last-armed idle window runs out and triggerKill("idle") finally
          // fires — a wedged-but-chattery tool (e.g. a stalled router that
          // keeps trickling tool_execution_update) fails over in minutes
          // instead of surviving to the hard cap (issue #351). Any productive
          // output resets the budget (the "productive" branch clears
          // toolRunStart), so a healthy turn interleaving tools with text is
          // never affected.
          return;
        }
      } else if (activity === "productive") {
        toolRunning = false;
        toolRunStart = undefined;
      } else if (toolRunning) {
        return;
      }
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => triggerKill("idle"),
        opts.idleTimeoutMs,
      );
    },
    firstOutput(): void {
      if (cause || disposed) return;
      if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = undefined;
      }
    },
    terminate(): void {
      triggerKill("policy");
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      if (startupTimer) clearTimeout(startupTimer);
      if (opts.signal && !opts.signal.aborted) {
        opts.signal.removeEventListener("abort", onAbort);
      }
    },
    killCause(): KillCause {
      return cause;
    },
  };
}

/*
 * Suffix marking the hard wall-clock cap error message, and the matcher for
 * it. Exported so callers that act on error chunks (e.g. the pi coder-swap
 * retry ladder) can recognise "the FINAL timer killed this run" without
 * re-hardcoding the string in two places.
 */
export const HARD_CAP_ERROR_SUFFIX = "(hard wall-clock cap)";

export function isHardCapError(error: string): boolean {
  return error.endsWith(HARD_CAP_ERROR_SUFFIX);
}

/**
 * Render the standard "killed by X" HarnessChunk for a kill cause.
 * Returns undefined if the process exited naturally (no kill).
 *
 *   - "timeout"  → recoverable (orchestrator advances to next harness)
 *   - "idle"     → recoverable (same — wedged subprocess, try a different one)
 *   - "startup"  → recoverable (never produced output — likely wedged on init;
 *     orchestrator falls through fast instead of eating the full idle window)
 *   - "aborted"  → non-recoverable (user said /stop and meant it)
 *   - "policy"   → recoverable (terminal tripwire; normally unreachable here
 *     because the tripwire's own error chunk was already yielded and the
 *     generator returned — this is the belt-and-suspenders fallback)
 */
export function killCauseToErrorChunk(
  cause: KillCause,
  harnessId: string,
  hardTimeoutMs: number | undefined,
  idleTimeoutMs: number,
  startupTimeoutMs?: number,
):
  | { type: "error"; error: string; recoverable: boolean }
  | undefined {
  if (cause === "timeout") {
    return {
      type: "error",
      error: `${harnessId} timed out after ${hardTimeoutMs ?? "unknown"}ms ${HARD_CAP_ERROR_SUFFIX}`,
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
  if (cause === "startup") {
    return {
      type: "error",
      error: `${harnessId} produced no output within ${startupTimeoutMs ?? "unknown"}ms of startup (likely wedged on the MCP/init handshake)`,
      recoverable: true,
    };
  }
  if (cause === "aborted") {
    return { type: "error", error: "stopped", recoverable: false };
  }
  if (cause === "policy") {
    return {
      type: "error",
      error: `${harnessId} killed by policy tripwire`,
      recoverable: true,
    };
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
   * (codex usage, provider stats). Always includes whatever the harness wants —
   * harnessId is the caller's responsibility to add.
   */
  buildDoneMeta: (
    finalText: string,
    captured: Record<string, unknown> | undefined,
  ) => Record<string, unknown>;
  /** Cap for a non-JSON progress note. Omit for the full line (claude/pi). */
  progressNoteLimit?: number;
   /** Side-effect for each non-JSON stdout line (e.g. provider debug log). */
  onNonJsonLine?: (line: string) => void;
  /** Per-line stderr handler. Defaults to a debug log tagged with harnessId. */
  onStderrLine?: (line: string) => void;
   /** Parse the decoder tail after stdout closes, when an adapter needs it. */
  flushTail?: boolean;
  /**
   * Require an explicit completion signal before treating an exit-0 run as a
   * finished answer. When true, the engine yields the terminal `done` on exit 0
   * ONLY if the parser emitted at least one `done` chunk during the stream (the
   * harness's "the model finished" marker); otherwise it yields a recoverable
   * error so the orchestrator falls through to the next harness.
   *
   * This exists for harnesses whose stream carries no native terminal `done`
   * and would otherwise derive completion from the exit code alone — pi, whose
   * only completion signal is `turn_end` (issue #352). A run that exits 0
   * mid-task (only tool narration, no turn_end) is a "no real answer" state,
   * not a success. Omit/false ⇒ exit 0 is accepted as done (the legacy
   * behaviour every other harness relies on).
   */
  requireCompletion?: boolean;
  /**
   * Wall-clock cap (ms) on how long a SINGLE contiguous tool-run may keep the
   * idle watchdog alive via `"tool"` activity alone, with no productive output.
   * Forwarded to the kill coordinator. Guards against a wedged-but-chattery
   * tool (e.g. a stalled router or a hung retry that keeps trickling output)
   * resetting the idle timer up to the hard cap with no fallback (issue #351).
   * Omit to disable (legacy: any tool activity resets the idle timer as long as
   * it keeps arriving).
   */
  toolTimeoutMs?: number;
  /**
   * Terminal error to emit with priority over kill-cause / exit-code, e.g.
   * An adapter's mid-stream 4XX fast-fallback. Called after the loop; if it returns
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
    startupTimeoutMs: req.startupTimeoutMs,
    toolTimeoutMs: spec.toolTimeoutMs,
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
  // Set once the parser emits a `done` chunk — the harness's "the model
  // finished this turn" marker (pi's turn_end, codex's turn.completed). Only
  // consulted when spec.requireCompletion is set; see the exit-0 gate below.
  let sawCompletion = false;
  // Set when a parser returns a terminal policy error (e.g. the subagent
  // tripwire). The error chunk is yielded, the subprocess is killed NOW,
  // and every line after it — same batch or later — is dropped: nothing a
  // process says after violating policy may reach the user.
  let terminalError: HarnessChunk | undefined;
  const decoder = new TextDecoder();

  // Translate one parsed line, feed the idle timer, fold text/done. Yields the
  // chunk for everything except `done` (whose meta is captured, not surfaced —
  // the single terminal `done` is synthesized after the loop).
  function* consume(parsed: unknown): Generator<HarnessChunk> {
    const c = spec.parseEvent(parsed);
    if (!c) return;
    if (c.type === "error" && c.terminal) {
      terminalError = c;
      killer.terminate(); // SIGTERM → grace → SIGKILL the whole group
      yield c;
      return;
    }
    killer.touch(spec.activity(parsed, c));
    if (c.type === "text") finalText += c.text;
    if (c.type === "done") {
      captured = c.meta;
      sawCompletion = true;
      return;
    }
    yield c;
  }

  try {
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      // First stdout byte means the subprocess got past its startup/init
      // handshake and is alive — cancel the startup timer. Idempotent, so
      // calling it every iteration is cheap. NB: this is deliberately distinct
      // from touch(): startup measures "any output at all", while the idle
      // timer below measures "productive output". We do NOT touch() here — the
      // idle timer must measure time since last *productive* output, not since
      // last raw chunk, or synthetic heartbeats keep postponing the idle kill
      // on a wedged turn. See #123.
      killer.firstOutput();
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
        if (terminalError) break; // policy violation: drop the rest of the batch
      }
      if (terminalError) break; // ...and stop reading stdout entirely
    }
    if (spec.flushTail && !terminalError) {
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

  // Priority order matches the old hand-written loops: a terminal policy
  // error wins over everything (its chunk was already yielded mid-loop; the
  // orchestrator has it, so just stop), then a harness-specific early
  // provider error wins over kill-cause, which wins over exit code.
  if (terminalError) {
    await proc.exited;
    return;
  }

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
    req.startupTimeoutMs,
  );
  if (errChunk) {
    yield errChunk;
    return;
  }

  const code = await proc.exited;
  const signalCode = (proc as { signalCode?: string | null }).signalCode ?? undefined;
  if (code !== 0) {
    // Host shutdown, not a harness fault. systemd (and `phantombot restart`)
    // SIGTERMs the whole cgroup, so an in-flight harness child dies with
    // 143 while phantombot is on its way down. The old code classified that
    // as a recoverable harness error, which made the orchestrator spawn a
    // FALLBACK harness mid-shutdown — a fresh subprocess that burns paid
    // provider tokens for a reply nobody will ever receive, and then dies
    // with 143 itself. Observed on Robbie: 5 restarts in one day, each one
    // manufacturing a phantom failover. Mark it terminal so the chain stops.
    //
    // Deliberately NOT including SIGKILL/137: that is the OOM killer at
    // least as often as it is a shutdown, and an OOM is a real failure the
    // owner should see reported rather than silently swallowed.
    if (isShutdownExit(signalCode, code)) {
      yield {
        type: "error",
        error: `${harnessId} terminated by ${signalCode ?? "SIGTERM"} (host shutting down)`,
        recoverable: false,
      };
      return;
    }
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

  // Completion gate (opt-in via spec.requireCompletion): an exit-0 run that
  // never emitted the harness's completion marker (pi's turn_end) is a
  // "stopped mid-turn" state, not a finished answer — the accumulated text is
  // only partial output / tool narration. Yield a recoverable error so the
  // orchestrator falls through to the next harness instead of storing the
  // fragment as the reply. See issue #352. Note `finalText` may be non-empty
  // here (narration IS text), so the existing empty-done fall-through in
  // runWithFallback cannot catch this case — the completion marker can.
  if (spec.requireCompletion && !sawCompletion) {
    yield {
      type: "error",
      error: `${harnessId} exited 0 without a completion signal (only partial/tool output — likely stopped mid-turn)`,
      recoverable: true,
    };
    return;
  }

  yield {
    type: "done",
    finalText,
    meta: spec.buildDoneMeta(finalText, captured),
  };
}

/**
 * Did this subprocess die because the host asked everything to stop?
 *
 * Bun surfaces a signal death two ways depending on how the child was
 * reaped — `signalCode` ("SIGTERM"), or the shell convention of 128+signum
 * in the exit code — so both are checked. Only the "please stop" signals
 * count: SIGTERM (systemd stop/restart, `phantombot restart`), SIGINT
 * (Ctrl-C) and SIGHUP (terminal went away).
 *
 * Note this is only ever consulted when the kill coordinator did NOT fire —
 * our own timeout/abort kills are classified earlier from `killCause()`, so
 * reaching here with a signal means it came from OUTSIDE phantombot.
 *
 * Exported for testing.
 */
export function isShutdownExit(
  signalCode: string | undefined,
  code: number,
): boolean {
  if (signalCode === "SIGTERM" || signalCode === "SIGINT" || signalCode === "SIGHUP") {
    return true;
  }
  return code === 143 || code === 130 || code === 129;
}
