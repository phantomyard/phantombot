/**
 * OpenAI Codex CLI harness. STUB.
 *
 * Use src/harnesses/claude.ts as the template. The general shape:
 *   1. spawn the codex CLI in non-interactive mode
 *   2. install the system prompt via whatever flag codex supports
 *   3. write history + new user message to stdin (or argv if codex insists)
 *   4. parse codex's streaming output format and yield HarnessChunks
 *
 * Things to investigate before writing this:
 *   - What's codex's --print equivalent? (`codex exec`, `codex run`?)
 *   - Does codex have a system-prompt flag, or do you have to embed it
 *     in the user prompt? If embedding: this harness will inherit the
 *     "persona-as-data" weakness that --system-prompt fixed for Claude.
 *   - How does codex authenticate? OAuth (ChatGPT plus/pro), API key, or
 *     both? Document quirks here.
 *   - What's codex's fallback-model story? Is there an equivalent of
 *     Claude's --fallback-model, or do we need to handle 429s ourselves?
 */

import type { Harness, HarnessChunk, HarnessRequest } from "./types.js";

export interface CodexHarnessConfig {
  bin: string;
  model: string;
}

export class CodexHarness implements Harness {
  readonly id = "codex";

  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(_config: CodexHarnessConfig) {}

  async available(): Promise<boolean> {
    return false; // TODO: implement
  }

  async *invoke(_req: HarnessRequest): AsyncIterable<HarnessChunk> {
    yield {
      type: "error",
      error: "CodexHarness not implemented yet — see src/harnesses/codex.ts",
      recoverable: true,
    };
  }
}
