/**
 * Pi Coding Agent harness. STUB.
 *
 * Use src/harnesses/claude.ts as the template. Investigate Pi's CLI
 * surface — non-interactive flags, streaming format, system prompt
 * mechanism — and document any quirks here.
 */

import type { Harness, HarnessChunk, HarnessRequest } from "./types.js";

export interface PiHarnessConfig {
  bin: string;
  model: string;
}

export class PiHarness implements Harness {
  readonly id = "pi";

  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(_config: PiHarnessConfig) {}

  async available(): Promise<boolean> {
    return false; // TODO: implement
  }

  async *invoke(_req: HarnessRequest): AsyncIterable<HarnessChunk> {
    yield {
      type: "error",
      error: "PiHarness not implemented yet — see src/harnesses/pi.ts",
      recoverable: true,
    };
  }
}
