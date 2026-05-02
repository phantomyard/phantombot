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
 */

import type { Harness, HarnessChunk, HarnessRequest } from "../harnesses/types.ts";
import { log } from "../lib/logger.ts";

export async function* runWithFallback(
  chain: Harness[],
  req: HarnessRequest,
): AsyncIterable<HarnessChunk> {
  if (chain.length === 0) {
    yield {
      type: "error",
      error: "no harnesses configured",
      recoverable: false,
    };
    return;
  }

  const estimatedBytes = estimatePayloadBytes(req);

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
            },
          );
          recoverableError = true;
          break;
        }
        yield chunk;
        return;
      }
      yield chunk;
      if (chunk.type === "done") succeeded = true;
    }

    if (succeeded) return;
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
