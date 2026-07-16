/**
 * Tool-call audit log (issue #282, feature 1 of 2 — the always-on half).
 *
 * Bash-tool invocations run inside the harness subprocess with `HISTFILE`
 * unset, so nothing an agent runs lands in shell history. Once a turn ends the
 * exact tool calls it made (diagnostics, vault writes, index rebuilds) are
 * gone — the operator sees only narration plus a paraphrased result, never the
 * verbatim calls. This module gives phantombot the one thing it CAN faithfully
 * record at the layer it controls: every tool call the harness surfaces, with a
 * timestamp, appended to a per-persona, per-day file.
 *
 * Deliberate scope / known limits (documented, not accidental):
 *   - Phantombot only ever sees the harness's `progress` chunks, so this logs
 *     the tool NAME + kind + the (already length-capped, ≤80-char) detail
 *     title and any file locations — NOT the full untruncated argv, and NOT
 *     tool EXIT CODES. Those live inside the subprocess and never cross the
 *     harness boundary. Capturing them would require populating
 *     `ToolCallDetail.content` in every adapter, which reopens the redaction
 *     question the toolNote module explicitly deferred (#218/#231). That is
 *     the natural follow-up; this is the honest first cut.
 *   - Best-effort by contract: a failed write must never break or slow a turn.
 *     Writes are fire-and-forget and errors degrade to a debug log.
 *
 * Redaction: every field is passed through {@link redactForLog} before it
 * touches disk — the same net that guards the logger and the task_runs table —
 * so a token echoed into a command title doesn't outlive the process on disk.
 *
 * Toggle: on by default. Set `PHANTOMBOT_AUDIT_TOOL_CALLS` to `0`/`off`/
 * `false`/`no` to disable, mirroring the other `PHANTOMBOT_*` runtime knobs.
 *
 * Retention: audit files are pruned on write — each append also unlinks any
 * `<date>.log` older than the retention window so growth is bounded by design
 * (no timer to maintain). The window defaults to 30 days and is tunable via
 * `PHANTOMBOT_AUDIT_RETENTION_DAYS`. The prune runs inside the same
 * never-throws guard as the append: a readdir/unlink failure degrades to a
 * debug log and can never break or slow a turn.
 */

import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ToolCallDetail } from "../harnesses/toolNote.ts";
import { redactForLog } from "./redact.ts";
import { log } from "./logger.ts";

/** A sink the orchestrator calls once per tool-call `progress` chunk. */
export type AuditSink = (detail: ToolCallDetail) => void;

/** Is the audit log enabled? On unless explicitly turned off. */
export function auditEnabled(): boolean {
  const v = process.env.PHANTOMBOT_AUDIT_TOOL_CALLS;
  if (v === undefined) return true;
  return !/^(0|off|false|no)$/i.test(v.trim());
}

/** UTC `YYYY-MM-DD` — the audit file is rotated per calendar day. */
function dateStamp(now: Date): string {
  return now.toISOString().slice(0, 10);
}

const DEFAULT_RETENTION_DAYS = 30;

/**
 * Retention window in days. Defaults to 30; overridable via
 * `PHANTOMBOT_AUDIT_RETENTION_DAYS`. Garbage (non-numeric, ≤0, non-finite) is
 * ignored and falls back to the default — a bad knob must never disable
 * pruning or, worse, unlink everything.
 */
function retentionDays(): number {
  const raw = process.env.PHANTOMBOT_AUDIT_RETENTION_DAYS;
  if (raw === undefined) return DEFAULT_RETENTION_DAYS;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RETENTION_DAYS;
  return Math.floor(n);
}

/**
 * Prune-on-write: unlink every `<agentDir>/audit/<date>.log` older than the
 * retention window. Filenames are `YYYY-MM-DD.log`, which sorts lexically =
 * chronologically, so we compare stamps as strings. Best-effort: per-file
 * unlink errors are swallowed, and the whole step sits inside the caller's
 * never-throws write-chain guard.
 */
async function pruneOldLogs(dir: string, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - retentionDays() * 86_400_000);
  const cutoffStamp = dateStamp(cutoff);
  const entries = await readdir(dir);
  await Promise.all(
    entries
      .filter(
        (name) =>
          /^\d{4}-\d{2}-\d{2}\.log$/.test(name) &&
          name.slice(0, 10) < cutoffStamp,
      )
      .map((name) => unlink(join(dir, name)).catch(() => {})),
  );
}

// Per-file write chain. Appends are fire-and-forget from the caller's view,
// but we serialize them per file so lines land in the order the tool calls
// happened rather than racing each other. A rejected link never breaks the
// chain (each link swallows the prior error before doing its own work).
// This module-level Map is safe under multi-persona concurrency: the key is
// the full absolute file path, so two personas writing the same calendar day
// use distinct keys and never share a chain.
const writeChains = new Map<string, Promise<void>>();

/**
 * Record one tool call. Best-effort and non-blocking: returns immediately,
 * the actual write happens on a serialized background chain, and any failure
 * (permissions, full disk, bad path) degrades to a debug log — it never
 * throws and never slows the turn.
 */
export function recordToolCall(
  agentDir: string,
  detail: ToolCallDetail,
  now: Date = new Date(),
): void {
  const dir = join(agentDir, "audit");
  const file = join(dir, `${dateStamp(now)}.log`);
  const line =
    JSON.stringify({
      ts: now.toISOString(),
      kind: detail.kind,
      note: redactForLog(detail.title),
      // NB: redactForLog's email pattern will also mask legitimate
      // `user@host`-style path segments (e.g. `/home/user@example.com/...`).
      // That's an accepted over-redaction here — an audit trail should err
      // toward masking, never toward leaking.
      locations: detail.locations.map((l) => redactForLog(l.path)),
    }) + "\n";

  const prev = writeChains.get(file) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => mkdir(dir, { recursive: true, mode: 0o700 }))
    .then(() => appendFile(file, line, { mode: 0o600 }))
    .then(() => pruneOldLogs(dir, now))
    .catch((err) =>
      log.debug("audit: failed to record tool call", { err: String(err) }),
    );
  writeChains.set(file, next);
}

/**
 * Build the sink the orchestrator wires into a turn, or `undefined` when
 * auditing is disabled or there's no persona dir to write into (degraded
 * paths). `undefined` means "don't audit", so the caller passes it straight
 * through as the optional `onToolCall` hook.
 */
export function createAuditSink(
  agentDir: string | undefined,
): AuditSink | undefined {
  if (!agentDir || !auditEnabled()) return undefined;
  return (detail) => recordToolCall(agentDir, detail);
}

/**
 * Test hook: drain and reset the per-file write chains so a test can await all
 * pending appends and start clean. Not used in production.
 */
export async function flushAuditWritesForTest(): Promise<void> {
  const pending = [...writeChains.values()];
  writeChains.clear();
  await Promise.allSettled(pending);
}
