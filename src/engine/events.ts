/**
 * Internal `HarnessChunk` stream → public `EngineEvent` stream.
 *
 * The mapping is the stability boundary: harness adapters may add chunk
 * types or fields at will; applications only ever see `EngineEvent`.
 */

import type { HarnessChunk } from "../harnesses/types.ts";
import type { EngineErrorCode } from "./errors.ts";
import type { EngineEvent } from "./types.ts";

/**
 * @internal
 * Map one chunk. Returns undefined for chunks an application has no use for
 * (liveness heartbeats). `aborted` tells an error apart from a cancellation,
 * since a killed harness reports both the same way.
 */
export function toEngineEvent(
  chunk: HarnessChunk,
  aborted: boolean,
): EngineEvent | undefined {
  switch (chunk.type) {
    case "text":
      return { type: "text", text: chunk.text };
    case "heartbeat":
      return undefined;
    case "progress":
      if (chunk.tool) {
        return {
          type: "tool",
          title: chunk.tool.title,
          kind: chunk.tool.kind,
          locations: chunk.tool.locations.map((l) => l.path),
        };
      }
      return { type: "status", note: chunk.note };
    case "replay":
      return { type: "status", note: chunk.note };
    case "done": {
      const held = chunk.meta?.screenedHold === true;
      return held
        ? { type: "held", message: chunk.finalText }
        : { type: "done", text: chunk.finalText, held: false };
    }
    case "error": {
      const code: EngineErrorCode =
        aborted || chunk.killCause === "aborted" ? "cancelled" : "harness_failed";
      return { type: "error", code, message: chunk.error };
    }
  }
}
