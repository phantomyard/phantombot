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
 */

import { appendFile, mkdir } from "node:fs/promises";
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

// Per-file write chain. Appends are fire-and-forget from the caller's view,
// but we serialize them per file so lines land in the order the tool calls
// happened rather than racing each other. A rejected link never breaks the
// chain (each link swallows the prior error before doing its own work).
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
      locations: detail.locations.map((l) => redactForLog(l.path)),
    }) + "\n";

  const prev = writeChains.get(file) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => mkdir(dir, { recursive: true, mode: 0o700 }))
    .then(() => appendFile(file, line, { mode: 0o600 }))
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
