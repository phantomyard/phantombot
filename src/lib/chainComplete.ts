/**
 * Run a one-shot, tool-less completion over the WHOLE harness chain.
 *
 * Two features ran their model call on `harnesses[0]` and nowhere else: the
 * durable-facts extractor and the threat judge. Both predate the fallback
 * orchestrator and neither consulted it, so when the primary harness was out
 * of quota:
 *
 *   - durable facts logged "extraction call failed; will retry batch" and
 *     dropped the batch, once per turn, for as long as the window lasted.
 *     Chat turns meanwhile failed over and looked perfectly healthy, so the
 *     only symptom was memory quietly not being written (observed on
 *     kw-phantombot 2026-09-19: a four-hour codex quota window).
 *   - the threat judge FAILED OPEN. A quota exhaustion on the primary
 *     silently switched off the screener that stands in front of every
 *     untrusted input — the one failure mode the perimeter exists to prevent.
 *
 * Both are background/inline calls with no user watching a stream, so unlike
 * `runWithFallback` there is nothing to yield and no partial-reply trade-off
 * to make: just try the next harness.
 *
 * Cooldown semantics deliberately MATCH the orchestrator's, because both
 * share one store and must not fight each other:
 *   - cooled harnesses are skipped, snapshot at call time;
 *   - if EVERYONE is cooled the snapshot is ignored and the chain is tried in
 *     order anyway (a screener that refuses to run is the fail-open bug);
 *   - a thrown attempt cools the harness, a successful one clears it;
 *   - an EMPTY result falls through WITHOUT cooling (#499): the process ran
 *     clean and produced no text, which is a model flake, not ill health.
 */

import type { Harness, HarnessChunk } from "../harnesses/types.ts";
import { type CooldownStore, cooldownStore as defaultStore } from "./cooldown.ts";
import { classifyFailure } from "./harnessAlert.ts";
import { log } from "./logger.ts";

/**
 * A harness error chunk, preserved as a throwable.
 *
 * `attempt` callbacks consume a chunk stream and can only signal failure by
 * throwing, and both production callers used to flatten the chunk to
 * `new Error(chunk.error)`. That threw away the three fields this module
 * actually needs (#595):
 *
 *   - `stderrTail`, which is what #591 taught `classifyFailure` to read. A CLI
 *     harness dies with "codex exited with code 1" and says WHY on stderr, so
 *     without the tail every failure classifies `other`.
 *   - `retryAfterMs`, the window the provider itself asked for — already
 *     parsed by the runner out of "try again at 8:58 PM". Dropping it means
 *     a four-hour quota gets benched by the ~150 s ladder and re-probed all
 *     afternoon.
 *   - `httpStatus`, the least ambiguous signal there is when present.
 *
 * It matters MORE here than in the orchestrator, because on an untrusted turn
 * the threat judge runs FIRST: whatever cooldown it stamps is the one
 * `fallback.ts` then sees, and a harness already cooled is skipped without
 * ever being classified. A blind window here silently pre-empts the sighted
 * one downstream.
 */
export class HarnessCompletionError extends Error {
  readonly httpStatus: number | undefined;
  readonly stderrTail: string[] | undefined;
  readonly retryAfterMs: number | undefined;
  readonly recoverable: boolean;

  constructor(chunk: Extract<HarnessChunk, { type: "error" }>) {
    super(chunk.error);
    this.name = "HarnessCompletionError";
    this.httpStatus = chunk.httpStatus;
    this.stderrTail = chunk.stderrTail;
    this.retryAfterMs = chunk.retryAfterMs;
    this.recoverable = chunk.recoverable;
  }
}

export interface ChainCompleteOptions {
  /** Which feature is calling, for the logs ("durable-facts", "threat-judge"). */
  label: string;
  /** Defaults to the process-wide store; tests inject a fresh one. */
  cooldown?: CooldownStore;
  /**
   * The caller's abort signal. Checked between attempts so a cancelled turn
   * stops the chain instead of walking it — and, more importantly, so an
   * abort is never mistaken for harness ill health and cooled. Harnesses
   * surface an abort as an ordinary error chunk ("stopped"), which is
   * indistinguishable from a real failure by message alone.
   */
  signal?: AbortSignal;
}

export async function completeOverChain(
  harnesses: Harness[],
  attempt: (harness: Harness) => Promise<string>,
  options: ChainCompleteOptions,
): Promise<string> {
  if (harnesses.length === 0) throw new Error("no harnesses configured");
  const cooldown = options.cooldown ?? defaultStore;

  const cooled = new Set<string>();
  for (const h of harnesses) {
    if (cooldown.isCooledDown(h.id).cooled) cooled.add(h.id);
  }
  if (cooled.size === harnesses.length) {
    log.warn(`${options.label}: every harness in cooldown — trying anyway`, {
      harnessIds: harnesses.map((h) => h.id),
    });
    cooled.clear();
  }

  let lastError: unknown;
  let attempted = 0;
  const causes: { harnessId: string; cause: string }[] = [];
  for (const [i, harness] of harnesses.entries()) {
    if (options.signal?.aborted) break;
    if (cooled.has(harness.id)) continue;
    attempted++;
    try {
      const text = await attempt(harness);
      if (text.length === 0) {
        // Empty but clean. Try the next harness for a usable answer; do NOT
        // cool this one for it (#499).
        log.warn(`${options.label}: harness returned empty — falling through`, {
          harnessId: harness.id,
        });
        lastError = new Error(`${harness.id} returned an empty completion`);
        continue;
      }
      cooldown.markSuccess(harness.id);
      return text;
    } catch (e) {
      // An abort is the CALLER stopping us, not a harness fault. Cooling the
      // harness for it would bench a healthy binary because a turn was
      // cancelled, and there is no point trying the next one either.
      if (options.signal?.aborted) throw e;
      // Classify BEFORE cooling, on the same evidence the orchestrator uses.
      // A bare Error still works (tests, and any caller that has not been
      // taught to carry the chunk) — it just classifies on the message alone,
      // exactly as this path always did.
      const detail = e instanceof HarnessCompletionError ? e : undefined;
      const message = e instanceof Error ? e.message : String(e);
      const cause = classifyFailure(
        message,
        detail?.httpStatus,
        detail?.stderrTail,
      );
      // Honour the provider's own deadline when it gave one. Unlike the
      // ladder, this window is an instruction, and it is the reason a quota
      // that resets in four hours stops being re-probed every few minutes.
      const status = cooldown.markFailure(harness.id, {
        retryAfterMs: detail?.retryAfterMs,
      });
      lastError = e;
      causes.push({ harnessId: harness.id, cause });
      // Log AFTER markFailure so the line reports the window it really
      // produced — "which harness, why, and how long is it benched" is the
      // whole question at 3am, and until #595 this line answered only the
      // first third of it.
      log.warn(`${options.label}: harness failed — falling through`, {
        harnessId: harness.id,
        error: message,
        httpStatus: detail?.httpStatus,
        cause,
        retryAfterMs: detail?.retryAfterMs,
        cooldownUntilMs: status.untilMs,
        nextHarnessId: nextEligibleId(harnesses, i, cooled),
      });
    }
  }

  // Nothing answered. For durable facts that is a dropped batch; for the
  // threat judge it is a FAIL-OPEN — every untrusted input for the length of
  // the outage goes unscreened. Either way it deserves a record naming what
  // each harness died of, because a chain-wide quota window and a chain-wide
  // misconfiguration look identical from the one rethrown error.
  if (!options.signal?.aborted && causes.length > 0) {
    log.error(`${options.label}: no harness completed — chain exhausted`, {
      attempted,
      causes,
    });
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(
        `${options.label}: no harness produced a completion (tried ${attempted})`,
      );
}

/**
 * The harness this chain will actually try next — the next one that is not
 * being skipped for cooldown, not merely `harnesses[i + 1]`. An operator
 * reading the fall-through line wants to know where the work went; naming a
 * harness that is itself benched would send them to the wrong journal.
 */
function nextEligibleId(
  harnesses: Harness[],
  from: number,
  cooled: ReadonlySet<string>,
): string | undefined {
  for (let j = from + 1; j < harnesses.length; j++) {
    const h = harnesses[j]!;
    if (!cooled.has(h.id)) return h.id;
  }
  return undefined;
}
