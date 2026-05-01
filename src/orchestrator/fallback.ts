/**
 * Run a HarnessRequest through a chain of harnesses, advancing on
 * recoverable errors and stopping on success or terminal error.
 *
 * Yields chunks from whichever harness ends up handling the turn. The
 * caller doesn't need to know which one won; it just consumes the stream.
 */

import type { Harness, HarnessChunk, HarnessRequest } from "../harnesses/types.js";
import { log } from "../lib/logger.js";

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

  for (let i = 0; i < chain.length; i++) {
    const harness = chain[i]!;
    log.info("orchestrator: trying harness", { harnessId: harness.id, attempt: i + 1, of: chain.length });

    let succeeded = false;
    let recoverableError = false;

    for await (const chunk of harness.invoke(req)) {
      if (chunk.type === "error") {
        if (chunk.recoverable && i < chain.length - 1) {
          log.warn("orchestrator: harness recoverable error, falling through", {
            harnessId: harness.id,
            error: chunk.error,
          });
          recoverableError = true;
          break;
        }
        // terminal error or last harness in chain — surface to caller
        yield chunk;
        return;
      }
      yield chunk;
      if (chunk.type === "done") {
        succeeded = true;
      }
    }

    if (succeeded) return;
    if (!recoverableError) {
      // Stream ended without 'done' or 'error' — treat as terminal.
      yield {
        type: "error",
        error: `harness ${harness.id} ended without 'done' or 'error'`,
        recoverable: false,
      };
      return;
    }
  }
}
