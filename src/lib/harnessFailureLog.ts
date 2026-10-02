/**
 * Bounded on-disk log of harness failure diagnostics (issue #638).
 *
 * ── The gap ──
 * When a harness attempt fails, the orchestrator logs the error STRING and
 * exit code — "codex exited with code 1", cause "other" — and the cooldown
 * store tracks consecutive failures. But the child's stderr, which is where
 * a CLI actually says WHY ("ERROR: You've hit your usage limit. Upgrade to
 * Pro ... try again at Oct 4th"), was retained only in memory: the alerter's
 * incident counter and, for the one terminal error, the turn registry's
 * `stderr_tail`. A mid-chain failure that a fallback absorbed left no
 * evidence at all — diagnosing the 2026-10-01 codex quota exhaustion meant
 * re-running the harness by hand.
 *
 * ── What this is ──
 * One JSON line per harness failure, appended best-effort to
 * `<agentDir>/harness-failures/<YYYY-MM-DD>.jsonl`. Date-stamped like the
 * audit log so rotation is free, JSONL so `grep`/`jq` work, and every text
 * field bounded so a chatty stderr cannot balloon the file. Persona-attributed
 * so a multi-persona host can answer "which bot's harness is dying?".
 *
 * Sinks never throw: evidence capture sits on the failure path of a turn
 * that is already failing, and must not be able to make anything worse.
 */

import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./logger.ts";

/** Cap on retained stderr lines per record. */
const MAX_STDERR_LINES = 20;
/** Cap on each retained stderr line (chars). */
const MAX_STDERR_LINE_CHARS = 400;

/** One harness failure, as recorded by the orchestrator. */
export interface HarnessFailureRecord {
  /** RFC-3339 timestamp of the failure. */
  ts: string;
  /** Persona whose turn hit the failure, when the turn had one. */
  persona?: string;
  /** Harness id, e.g. "codex". */
  harnessId: string;
  /** The orchestrator's error string for the failure. */
  error: string;
  /** Upstream HTTP status, when the adapter surfaced one. */
  httpStatus?: number;
  /** Subprocess exit code, when the failure was an exit. */
  exitCode?: number;
  /** Kill-cause, when the failure was a coordinator kill. */
  killCause?: string;
  /** Coarse classification (see lib/harnessAlert.ts classifyFailure). */
  cause?: string;
  /** Last stderr lines, bounded. Already redacted upstream. */
  stderrTail?: string[];
}

/** Clamp a stderr tail to the record bounds. */
export function boundStderrTail(
  tail?: readonly string[],
): string[] | undefined {
  if (!tail || tail.length === 0) return undefined;
  return tail
    .slice(-MAX_STDERR_LINES)
    .map((l) => (l.length > MAX_STDERR_LINE_CHARS ? l.slice(0, MAX_STDERR_LINE_CHARS) : l));
}

export interface HarnessFailureSink {
  (record: HarnessFailureRecord): void;
}

/**
 * Build a best-effort JSONL appender under `<agentDir>/harness-failures/`.
 * One line per call; a write or mkdir failure is logged once per process
 * (not per call — a dead disk should not spam the journal) and the sink
 * degrades to a no-op.
 */
export function createHarnessFailureSink(
  agentDir: string,
): HarnessFailureSink {
  let broken = false;
  return (record: HarnessFailureRecord) => {
    if (broken) return;
    try {
      const dir = join(agentDir, "harness-failures");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
      const bounded: HarnessFailureRecord = {
        ...record,
        ...(record.stderrTail ? { stderrTail: boundStderrTail(record.stderrTail) } : {}),
      };
      appendFileSync(file, `${JSON.stringify(bounded)}\n`);
    } catch (e) {
      broken = true;
      log.warn("harnessFailureLog: write failed — sink disabled", {
        agentDir,
        error: (e as Error).message,
      });
    }
  };
}
