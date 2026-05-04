/**
 * Run a HarnessRequest through a chain of harnesses, advancing on
 * recoverable errors and stopping on success or terminal error.
 *
 * Yields chunks from whichever harness ends up handling the turn. The
 * caller doesn't need to know which one won; it just consumes the stream.
 *
 * Pre-spawn precheck: if a harness declares maxPayloadBytes and the turn
 * would exceed it, the orchestrator skips that harness without spawning
 * a subprocess. This matters for Pi, which takes its payload via argv
 * and is bounded by Linux ARG_MAX. The skip is treated as a recoverable
 * error so the chain falls through to the next harness (typically claude,
 * which has no payload ceiling).
 *
 * Cooldown semantics (see src/lib/cooldown.ts):
 *   - Each recoverable failure (recoverable error chunk OR empty done
 *     that triggers a non-last fall-through) bumps the harness's
 *     cooldown counter.
 *   - A successful turn (done with non-empty finalText, OR a "best we
 *     can do" empty-done from the last harness) clears the harness's
 *     counter.
 *   - At turn start, a snapshot is taken; harnesses whose cooldown is
 *     active are skipped in chain order. Escape hatch: if EVERY harness
 *     in the chain is currently cooled, the snapshot is ignored and we
 *     try them in chain order anyway. Better to give the user a
 *     possibly-flaky reply than to refuse outright.
 */

import type { Harness, HarnessChunk, HarnessRequest } from "../harnesses/types.ts";
import { type CooldownStore, cooldownStore as defaultStore } from "../lib/cooldown.ts";
import { log } from "../lib/logger.ts";

export interface RunWithFallbackOptions {
  /**
   * Cooldown store. Defaults to the process-wide singleton; tests inject
   * a fresh `new CooldownStore()` to avoid cross-test bleed.
   */
  cooldown?: CooldownStore;
}

export async function* runWithFallback(
  chain: Harness[],
  req: HarnessRequest,
  options: RunWithFallbackOptions = {},
): AsyncIterable<HarnessChunk> {
  if (chain.length === 0) {
    yield {
      type: "error",
      error: "no harnesses configured",
      recoverable: false,
    };
    return;
  }

  const cooldown = options.cooldown ?? defaultStore;
  const estimatedBytes = estimatePayloadBytes(req);

  // Snapshot cooldown state at turn start. We don't re-poll within the
  // turn — failures we register as we go are scoped to FUTURE turns,
  // not the rest of this one. (Otherwise a single bad turn could cool
  // every harness in the chain mid-flight and we'd skip the next one
  // we were about to try.)
  const cooledIds = new Set<string>();
  for (const h of chain) {
    if (cooldown.isCooledDown(h.id).cooled) cooledIds.add(h.id);
  }
  const allCooled = cooledIds.size === chain.length;
  if (allCooled && chain.length > 0) {
    // Escape hatch: if everyone's cooled we still need to produce a
    // reply, so ignore the snapshot for this turn. Logged loudly because
    // it indicates Andrew should look at upstream auth/quota.
    log.warn(
      "orchestrator: every harness in cooldown — ignoring cooldown for this turn",
      { harnessIds: chain.map((h) => h.id) },
    );
    cooledIds.clear();
  }

  for (let i = 0; i < chain.length; i++) {
    // Short-circuit if the channel layer has already aborted — otherwise
    // every harness in the chain spawns a subprocess just to discover the
    // signal and kill itself, which is wasteful when the user just typed
    // /stop and meant it.
    if (req.signal?.aborted) {
      yield { type: "error", error: "stopped", recoverable: false };
      return;
    }

    const harness = chain[i]!;
    const isLast = i === chain.length - 1;

    if (cooledIds.has(harness.id)) {
      const status = cooldown.isCooledDown(harness.id);
      log.info(
        "orchestrator: skipping harness — cooldown active",
        {
          harnessId: harness.id,
          consecutiveFailures: status.consecutiveFailures,
          cooldownRemainingMs: Math.max(0, status.untilMs - Date.now()),
        },
      );
      // Not the last harness: fall through silently. If somehow we're at
      // the last harness while still being cooled (shouldn't happen given
      // the allCooled escape hatch above, but defensive), yield a
      // terminal error rather than producing nothing.
      if (isLast) {
        yield {
          type: "error",
          error: `all harnesses in chain skipped (last in cooldown: ${harness.id})`,
          recoverable: false,
        };
        return;
      }
      continue;
    }

    if (
      harness.maxPayloadBytes !== undefined &&
      estimatedBytes > harness.maxPayloadBytes
    ) {
      if (!isLast) {
        log.warn(
          "orchestrator: skipping harness — payload exceeds maxPayloadBytes",
          {
            harnessId: harness.id,
            estimatedBytes,
            maxPayloadBytes: harness.maxPayloadBytes,
          },
        );
        continue;
      }
      yield {
        type: "error",
        error: `payload ${estimatedBytes} bytes exceeds ${harness.id}'s maxPayloadBytes ${harness.maxPayloadBytes} (no remaining harnesses)`,
        recoverable: false,
      };
      return;
    }

    log.info("orchestrator: trying harness", {
      harnessId: harness.id,
      attempt: i + 1,
      of: chain.length,
    });

    let succeeded = false;
    let recoverableError = false;

    for await (const chunk of harness.invoke(req)) {
      if (chunk.type === "error") {
        if (chunk.recoverable && !isLast) {
          log.warn(
            "orchestrator: harness recoverable error, falling through",
            {
              harnessId: harness.id,
              error: chunk.error,
              httpStatus: chunk.httpStatus,
            },
          );
          // Cool the harness off — esp. fast for 4XX (the harness
          // detected an upstream auth/quota/capacity issue and we
          // don't want to keep slamming it). markFailure() handles
          // the exponential backoff bookkeeping.
          cooldown.markFailure(harness.id);
          recoverableError = true;
          break;
        }
        yield chunk;
        return;
      }
      // Empty `done` = the harness exited cleanly but produced no
      // assistant text (gemini SIGTERMed mid-stream by an updater
      // restart, or a tool-only run with no final message). On a
      // non-last harness, fall through — pi getting a chance is far
      // better than the user seeing "(no reply)". On the last harness,
      // yield it and let the channel surface "(no reply)" so the user
      // knows something happened.
      if (
        chunk.type === "done" &&
        chunk.finalText.length === 0 &&
        !isLast
      ) {
        log.warn(
          "orchestrator: harness produced empty reply, falling through",
          { harnessId: harness.id },
        );
        cooldown.markFailure(harness.id);
        recoverableError = true;
        break;
      }
      yield chunk;
      if (chunk.type === "done") succeeded = true;
    }

    if (succeeded) {
      // A clean turn — even if the text was empty and we're on the last
      // harness, the CLI did its job. Clear any prior cooldown so the
      // next turn picks the chain back up at the top.
      cooldown.markSuccess(harness.id);
      return;
    }
    if (!recoverableError) {
      yield {
        type: "error",
        error: `harness ${harness.id} ended without 'done' or 'error'`,
        recoverable: false,
      };
      return;
    }
  }
}

/**
 * Estimate the rendered payload size for the precheck. Sums the system
 * prompt, every history turn, the new user message, plus a constant
 * per turn for the `<previous_response>` wrapper bytes. Conservative —
 * actual Pi argv may include a few additional flag bytes which this
 * doesn't account for, but the slack is well under the typical budget.
 *
 * Exported for testing.
 */
export function estimatePayloadBytes(req: HarnessRequest): number {
  let total = Buffer.byteLength(req.systemPrompt, "utf8");
  for (const turn of req.history) {
    total += Buffer.byteLength(turn.text, "utf8");
    total += turn.role === "assistant" ? 36 : 0; // <previous_response>...</previous_response> markers
    total += 2; // joiner newlines
  }
  total += Buffer.byteLength(req.userMessage, "utf8");
  return total;
}
