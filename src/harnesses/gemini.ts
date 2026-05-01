/**
 * Gemini CLI harness. STUB.
 *
 * Use src/harnesses/claude.ts as the template. Gemini CLI is Google's
 * official tool; check its --help for the equivalents of:
 *   - non-interactive output (claude's --print)
 *   - streaming output format (claude's --output-format stream-json)
 *   - system prompt override (claude's --system-prompt)
 *   - permission bypass (claude's --permission-mode bypassPermissions)
 *
 * Gemini CLI typically authenticates via Google Cloud (gcloud auth) or an
 * API key in env. Document whichever your install uses.
 */

import type { Harness, HarnessChunk, HarnessRequest } from "./types.js";

export interface GeminiHarnessConfig {
  bin: string;
  model: string;
}

export class GeminiHarness implements Harness {
  readonly id = "gemini";

  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(_config: GeminiHarnessConfig) {}

  async available(): Promise<boolean> {
    return false; // TODO: implement
  }

  async *invoke(_req: HarnessRequest): AsyncIterable<HarnessChunk> {
    yield {
      type: "error",
      error: "GeminiHarness not implemented yet — see src/harnesses/gemini.ts",
      recoverable: true,
    };
  }
}
