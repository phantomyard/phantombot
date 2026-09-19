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

import type { Harness } from "../harnesses/types.ts";
import { type CooldownStore, cooldownStore as defaultStore } from "./cooldown.ts";
import { log } from "./logger.ts";

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
  for (const harness of harnesses) {
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
      cooldown.markFailure(harness.id);
      lastError = e;
      log.warn(`${options.label}: harness failed — falling through`, {
        harnessId: harness.id,
        error: (e as Error).message,
      });
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(
        `${options.label}: no harness produced a completion (tried ${attempted})`,
      );
}
