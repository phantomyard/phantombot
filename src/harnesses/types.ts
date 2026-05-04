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
  /**
   * Idle timeout: kill the subprocess if no chunk lands on stdout for this
   * long. Resets on every emitted chunk. This is the right knob for
   * "subprocess is wedged" (e.g. a tool call hanging on a TCP read) —
   * a productive turn that's emitting tool events constantly is not stuck.
   */
  idleTimeoutMs: number;
  /**
   * Hard wall-clock ceiling. Kills the subprocess regardless of activity.
   * Guards against runaway agents that legitimately keep the idle timer
   * fed but never converge on a final reply.
   */
  hardTimeoutMs: number;
  /** External abort signal (e.g. /stop command). When fired, the harness should kill the subprocess and yield a non-recoverable "stopped" error. */
  signal?: AbortSignal;
}

export type HarnessChunk =
  /** Streamed assistant text. Concatenate all `text` chunks for the final reply. */
  | { type: "text"; text: string }
  /**
   * Payload-less "model is alive" tick. Emitted on internal events the
   * channel layer shouldn't surface (chain-of-thought tokens,
   * tool_use block starts) but that prove the harness is working.
   * Channel adapters use these to refresh their typing/working
   * indicator — when heartbeats stop, the indicator naturally
   * expires, which is the truthful "frozen" signal.
   */
  | { type: "heartbeat" }
  /** Out-of-band progress with a human-readable note (e.g. "running tool X"). */
  | { type: "progress"; note: string }
  /** Final marker. `finalText` is the full assistant reply (sum of all `text` chunks). */
  | { type: "done"; finalText: string; meta?: Record<string, unknown> }
  /**
   * Error. `recoverable: true` means the orchestrator should try the next harness.
   * `false` means abort the turn.
   *
   * `httpStatus` is the upstream HTTP status code when the failure originates
   * from a network request the CLI made (e.g. gemini's 429 for capacity
   * exhaustion). Optional — many failures don't have one (timeouts, missing
   * binary, ARG_MAX guard). The orchestrator uses presence of a 4XX as a
   * signal to apply a longer cooldown to the harness, since 4XX usually
   * means "this CLI's auth/quota/model state is bad" rather than a transient
   * blip a retry would fix. 5XX is just logged; we don't treat server-side
   * blips as a reason to cool the harness off.
   */
  | { type: "error"; error: string; recoverable: boolean; httpStatus?: number };

export interface Harness {
  /** Stable identifier — matches the wrapper file name. */
  readonly id: string;

  /**
   * Largest allowable rendered payload (system prompt + history + new
   * message) in bytes. The orchestrator should skip this harness when
   * the turn would exceed the budget (Pi takes its payload via argv,
   * so it's bounded by Linux ARG_MAX). undefined = unbounded.
   */
  readonly maxPayloadBytes?: number;

  /** Quick check: is the binary present and minimally callable? */
  available(): Promise<boolean>;

  /** Run a turn. Returns an async iterable of chunks. The caller consumes until 'done' or 'error'. */
  invoke(req: HarnessRequest): AsyncIterable<HarnessChunk>;
}
