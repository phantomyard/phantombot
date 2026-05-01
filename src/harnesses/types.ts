/**
 * Harness contract. One implementation per AI CLI binary.
 *
 * A harness gets a system prompt + conversation history + a new user message,
 * spawns the CLI as a subprocess, and streams the assistant reply back as a
 * series of HarnessChunks.
 *
 * The harness's tool loop happens INSIDE the subprocess and is invisible to
 * phantombot. Tool execution, permission prompts, multi-step reasoning — all
 * the harness's responsibility. Phantombot only sees text coming back out.
 */

export interface HistoryTurn {
  role: "user" | "assistant";
  text: string;
}

export interface HarnessRequest {
  /** The agent's full system prompt (persona + retrieved memory + channel context). */
  systemPrompt: string;
  /** The new user message to respond to. */
  userMessage: string;
  /** Prior turns of this conversation, oldest first. May be empty. */
  history: HistoryTurn[];
  /** Subprocess working directory. Defaults to the agent dir. */
  workingDir?: string;
  /** Per-turn wall-clock cap. After this, the harness should kill the subprocess and yield a recoverable error. */
  timeoutMs: number;
}

export type HarnessChunk =
  /** Streamed assistant text. Concatenate all `text` chunks for the final reply. */
  | { type: "text"; text: string }
  /** Out-of-band progress (e.g. "running tool X"). Useful for keeping channels alive on long turns. */
  | { type: "progress"; note: string }
  /** Final marker. `finalText` is the full assistant reply (sum of all `text` chunks). */
  | { type: "done"; finalText: string; meta?: Record<string, unknown> }
  /** Error. `recoverable: true` means the orchestrator should try the next harness. `false` means abort the turn. */
  | { type: "error"; error: string; recoverable: boolean };

export interface Harness {
  /** Stable identifier — matches the wrapper file name. */
  readonly id: string;

  /** Quick check: is the binary present and minimally callable? */
  available(): Promise<boolean>;

  /** Run a turn. Returns an async iterable of chunks. The caller consumes until 'done' or 'error'. */
  invoke(req: HarnessRequest): AsyncIterable<HarnessChunk>;
}
