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

import type { ToolCallDetail } from "./toolNote.ts";

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
  /**
   * Persona key for THIS turn (e.g. "burt"). Exposed to the subprocess as
   * the `PHANTOMBOT_PERSONA` env var so tools can self-identify without a
   * hardcoded name — this is the single source of truth for "which bot am
   * I". Per-turn, not global: a host running multiple personas gets the
   * right identity on every spawn. Optional — degraded paths (e.g. the
   * no-tools recovery reply) may omit it.
   */
  persona?: string;
  /** Conversation key for THIS turn (e.g. "telegram:123"). Exposed to the subprocess as PHANTOMBOT_CONVERSATION so tools can mutate conversation-scoped runtime state safely. Optional for degraded/non-chat paths. */
  conversation?: string;
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
  hardTimeoutMs?: number;
  /** External abort signal (e.g. /stop command). When fired, the harness should kill the subprocess and yield a non-recoverable "stopped" error. */
  signal?: AbortSignal;
  /**
   * Tool capability mode for this invocation. Omitted = the harness's
   * normal full-capability turn. `"none"` runs a capability-restricted
   * completion for the tool-less threat judge (lib/threatJudge.ts): the
   * judge reads untrusted content and returns a score, and must not be able
   * to ACT on what it reads (its own host credentials would otherwise make a
   * successful injection dangerous).
   *
   * Each harness maps `"none"` to its CLI's NATIVE capability-restriction
   * flag — NOT a hand-maintained per-tool deny-list (which silently rots as
   * new tools ship, the bug Kai flagged on the first cut):
   *   - claude → `--tools ""`            (true zero-tools)
   *   - pi     → `--no-tools`            (true zero-tools)
   *   - gemini → `--approval-mode plan`  (read-only: may read, cannot act)
   *   - codex  → `--sandbox read-only`   (read-only: may read, cannot act)
   *
   * claude/pi reach genuine zero-tools; gemini/codex reach read-only (they
   * can read local files but cannot mutate state or reach the network to
   * act). That residual is accepted (Andrew): the screener consumes only the
   * judge's number and never executes anything it "decides", so read-only is
   * a sufficient floor. CRITICAL: the judge runs on whichever harness is
   * PRIMARY in the turn's chain — it never assumes a specific binary (e.g.
   * claude) is installed. A user who installs only one of the four supported
   * harnesses still gets screening on that one. Optional; normal turns omit.
   */
  toolsMode?: "none";
  /**
   * MCP capability mode. Omitted = the harness's normal turn, which loads
   * every MCP server the CLI is configured with (including the user's remote
   * claude.ai connectors). `"none"` runs the turn with ZERO MCP servers.
   *
   * This exists for BACKGROUND turns — the nightly maintenance stages — which
   * need no MCP at all. On a non-interactive `--print` run an unauthenticated
   * remote connector blocks the startup handshake on an OAuth flow that can
   * never complete, so the turn emits nothing and is killed at the idle
   * ceiling. Skipping MCP entirely removes that failure mode. Interactive
   * persona turns omit this and keep their connectors.
   *
   * Each harness maps `"none"` to its CLI's native "restrict MCP config" flag:
   *   - claude → `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`
   * Harnesses without such a flag ignore it (they don't share claude's
   * connector-startup hang). Optional; normal turns omit.
   */
  mcpMode?: "none";
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
  /**
   * Out-of-band progress with a human-readable note (e.g. "running tool X").
   * `note` remains the presentational title every consumer already reads.
   * `tool` (issue #231) optionally carries the structured tool-call detail —
   * ACP `kind` (panel icon) + clickable `locations` — for connectors that
   * render it (the Zed/ACP bridge). Omitted for progress that isn't a tool
   * call (e.g. raw stderr liveness), and safely ignored by string-only sinks.
   */
  | { type: "progress"; note: string; tool?: ToolCallDetail }
  /** Final marker. `finalText` is the full assistant reply (sum of all `text` chunks). `meta.replyMode` may be "text", "voice", or "default"/"disable" for channel adapters that support model-selected reply modality. */
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

/**
 * Snapshot of the harness's configured model(s), for `/status` and `/model`
 * display (issue #313). Purely presentational — nothing reads this to make
 * routing decisions; the harness's own config remains the source of truth.
 */
export interface HarnessModelInfo {
  /** Primary model the harness runs, or "(default)" when unpinned. */
  model: string;
  /** Provider id when meaningful (Pi routing, e.g. "openrouter"). */
  provider?: string;
  /** Pi capability-routing delegates, when configured. */
  codingModel?: string;
  imageModel?: string;
  /** Claude's --fallback-model, when configured. */
  fallbackModel?: string;
}

export interface Harness {
  /** Stable identifier — matches the wrapper file name. */
  readonly id: string;

  /**
   * Configured model snapshot for /status and /model. Optional so test stubs
   * and third-party harnesses don't have to implement it — the command layer
   * degrades to omitting the harness from the models line when absent.
   */
  modelInfo?(): HarnessModelInfo;

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
