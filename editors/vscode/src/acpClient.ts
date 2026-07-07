/**
 * Embedded ACP client — spawns `phantombot acp` and speaks newline-delimited
 * JSON-RPC 2.0 over its stdio.
 *
 * The extension is the CLIENT; phantombot is the AGENT. We hand-roll the wire
 * protocol over stdio (no MCP libraries, no third-party ACP client) reusing the
 * exact shapes the server already implements (see ./protocol.ts, which mirrors
 * the server's src/connectors/acp/protocol.ts). Lifecycle:
 *
 *     initialize → session/new (or session/load) → session/prompt …
 *
 * `session/prompt` is long-running: the agent streams `session/update`
 * notifications (agent_message_chunk / tool_call) while the request is in
 * flight, then resolves the request with `{ stopReason }`. We surface those
 * updates through a per-prompt callback and resolve the prompt promise on the
 * matching response.
 *
 * STDOUT IS THE PROTOCOL CHANNEL on the server side — so the agent's stderr is
 * the ONLY place diagnostics appear. We forward stderr to an injected sink for
 * surfacing into the panel / output channel.
 *
 * The transport is fully injectable (`AcpTransport`) so the handshake/streaming
 * logic is unit-tested over an in-memory duplex with zero real subprocess and
 * zero `vscode` dependency — mirroring how the server's own tests drive
 * runAcpServer over a PassThrough.
 */

import { spawn } from "node:child_process";

import { snapAwareSpawnEnv } from "./snapEnv.ts";
import {
  ACP_PROTOCOL_VERSION,
  allocId,
  isJsonRpcError,
  jsonRpcNotification,
  jsonRpcRequest,
  textPrompt,
  type AcpContentBlock,
  type AcpInitializeResult,
  type AcpLoadSessionResult,
  type AcpNewSessionResult,
  type AcpPromptResult,
  type AcpSessionUpdate,
  type AcpStopReason,
  type JsonRpcId,
  type JsonRpcResponse,
  type SessionUpdateParams,
} from "./protocol.ts";

/** A bidirectional newline-delimited byte transport to the agent. */
export interface AcpTransport {
  /** Write one already-serialized line (no trailing newline) to the agent. */
  write(line: string): void;
  /** Register a handler for each complete line received from the agent. */
  onLine(handler: (line: string) => void): void;
  /** Register a handler for stderr text from the agent (diagnostics only). */
  onStderr(handler: (text: string) => void): void;
  /** Register the close handler (process exit / pipe end). */
  onClose(handler: (info: { code: number | null }) => void): void;
  /** Tear the transport (and underlying process) down. */
  close(): void;
}

/** What the caller gets streamed during a prompt turn. */
export interface PromptHandlers {
  /** A delta of assistant text. */
  onText?(text: string): void;
  /** A presentational tool-call indicator ("working on X"). */
  onToolCall?(title: string, status: string): void;
  /** Raw update escape hatch (rarely needed). */
  onUpdate?(update: AcpSessionUpdate): void;
}

export interface AcpClientOptions {
  /** Pre-built transport (tests). Default: spawn `binaryPath acp [--persona]`. */
  transport?: AcpTransport;
  /** Absolute path / command for the phantombot binary. */
  binaryPath?: string;
  /** Persona override → `phantombot acp --persona NAME`. */
  persona?: string;
  /** Working dir the subprocess is spawned in (session cwd is passed separately). */
  cwd?: string;
  /** Per-call request timeout (ms). Prompts are exempt (they're long-running). */
  requestTimeoutMs?: number;
  /** Diagnostics sink for agent stderr + transport notes. */
  onDiagnostic?(text: string): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(reason: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Spawn `phantombot acp` (or wrap an injected transport) and expose the ACP
 * client lifecycle. One client instance owns one subprocess.
 */
export class AcpClient {
  private readonly transport: AcpTransport;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private readonly requestTimeoutMs: number;
  private readonly onDiagnostic: (text: string) => void;
  /** sessionId → live prompt handlers, set for the duration of a prompt. */
  private readonly promptStreams = new Map<string, PromptHandlers>();
  private closed = false;
  private closeError: Error | undefined;

  constructor(options: AcpClientOptions = {}) {
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.onDiagnostic = options.onDiagnostic ?? (() => {});
    this.transport = options.transport ?? spawnAcpTransport(options);

    this.transport.onLine((line) => this.handleLine(line));
    this.transport.onStderr((text) => this.onDiagnostic(text));
    this.transport.onClose((info) => this.handleClose(info));
  }

  // ── public lifecycle ─────────────────────────────────────────────────

  /** `initialize` — negotiate protocol version + capabilities. */
  async initialize(): Promise<AcpInitializeResult> {
    const result = (await this.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {},
    })) as AcpInitializeResult;
    return result;
  }

  /** `session/new` — open a fresh session bound to a workspace cwd. */
  async newSession(cwd: string): Promise<string> {
    const result = (await this.request("session/new", {
      cwd,
      // phantombot owns its own tools; we register no MCP servers.
      mcpServers: [],
    })) as AcpNewSessionResult;
    return result.sessionId;
  }

  /**
   * `session/load` — reattach to an existing session id for a cwd. The agent
   * replays history as `session/update` chunks before resolving; route those
   * through `handlers`. Returns the (struct, never-null) load result.
   */
  async loadSession(
    sessionId: string,
    cwd: string,
    handlers?: PromptHandlers,
  ): Promise<AcpLoadSessionResult> {
    if (handlers) this.promptStreams.set(sessionId, handlers);
    try {
      const result = (await this.request("session/load", {
        sessionId,
        cwd,
      })) as AcpLoadSessionResult;
      return result;
    } finally {
      if (handlers) this.promptStreams.delete(sessionId);
    }
  }

  /**
   * `session/prompt` — send the user's turn and stream the response. Resolves
   * with the stop reason when the agent finishes the turn. This request is
   * long-running and is NOT subject to `requestTimeoutMs`.
   */
  async prompt(
    sessionId: string,
    prompt: string | AcpContentBlock[],
    handlers: PromptHandlers = {},
  ): Promise<AcpStopReason> {
    const blocks = typeof prompt === "string" ? textPrompt(prompt) : prompt;
    this.promptStreams.set(sessionId, handlers);
    try {
      const result = (await this.request(
        "session/prompt",
        { sessionId, prompt: blocks },
        { longRunning: true },
      )) as AcpPromptResult;
      return result.stopReason;
    } finally {
      this.promptStreams.delete(sessionId);
    }
  }

  /** `session/cancel` — fire-and-forget notification to abort the live turn. */
  cancel(sessionId: string): void {
    if (this.closed) return;
    this.sendRaw(jsonRpcNotification("session/cancel", { sessionId }));
  }

  /** Tear down the subprocess and reject any in-flight requests. */
  dispose(): void {
    if (this.closed) return;
    this.transport.close();
    this.handleClose({ code: null });
  }

  // ── request plumbing ─────────────────────────────────────────────────

  private request(
    method: string,
    params: unknown,
    opts: { longRunning?: boolean } = {},
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(
        this.closeError ?? new Error(`acp client is closed (method ${method})`),
      );
    }
    const id = allocId();
    return new Promise<unknown>((resolve, reject) => {
      const pending: Pending = { resolve, reject };
      if (!opts.longRunning && this.requestTimeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(
            new Error(
              `phantombot acp: '${method}' timed out after ${this.requestTimeoutMs}ms`,
            ),
          );
        }, this.requestTimeoutMs);
        // Don't keep the event loop alive on a stuck timer in node hosts.
        (pending.timer as { unref?: () => void }).unref?.();
      }
      this.pending.set(id, pending);
      this.sendRaw(jsonRpcRequest(id, method, params));
    });
  }

  private sendRaw(message: unknown): void {
    this.transport.write(JSON.stringify(message));
  }

  // ── inbound line handling ────────────────────────────────────────────

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.onDiagnostic(`acp client: dropping non-JSON line: ${trimmed.slice(0, 200)}`);
      return;
    }
    if (!msg || typeof msg !== "object") return;

    const obj = msg as Record<string, unknown>;

    // A response carries an id and either result or error.
    if ("id" in obj && ("result" in obj || "error" in obj)) {
      this.handleResponse(obj as unknown as JsonRpcResponse);
      return;
    }

    // Otherwise it's a notification (or a request from the agent, which the
    // server side never sends in v1). Route session/update; ignore the rest.
    if (obj.method === "session/update") {
      this.handleSessionUpdate(obj.params as SessionUpdateParams | undefined);
      return;
    }
    // Unknown notification — diagnostic only, never throws.
    if (typeof obj.method === "string") {
      this.onDiagnostic(`acp client: ignoring notification ${obj.method}`);
    }
  }

  private handleResponse(res: JsonRpcResponse): void {
    const id = res.id;
    if (id === null || id === undefined) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (isJsonRpcError(res)) {
      pending.reject(
        new Error(`phantombot acp error ${res.error.code}: ${res.error.message}`),
      );
    } else {
      pending.resolve(res.result);
    }
  }

  private handleSessionUpdate(params: SessionUpdateParams | undefined): void {
    if (!params || typeof params !== "object") return;
    const handlers = this.promptStreams.get(params.sessionId);
    if (!handlers) return;
    const update = params.update;
    if (!update || typeof update !== "object") return;

    handlers.onUpdate?.(update);
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "user_message_chunk":
        if (update.content?.type === "text") {
          handlers.onText?.(update.content.text);
        }
        return;
      case "tool_call":
        handlers.onToolCall?.(update.title, update.status);
        return;
      default:
        return;
    }
  }

  private handleClose(info: { code: number | null }): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = new Error(
      info.code === null || info.code === 0
        ? "phantombot acp: subprocess closed"
        : `phantombot acp: subprocess exited with code ${info.code}`,
    );
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(this.closeError);
    }
    this.pending.clear();
    this.promptStreams.clear();
  }
}

/**
 * Default transport: spawn `phantombot acp [--persona NAME]` and wire its
 * stdio into the line-delimited contract. Buffers partial stdout lines.
 */
/**
 * Build the discrete `(command, args)` pair for spawning `phantombot acp`.
 *
 * Pure and platform-parameterized so the Windows shim path is unit-testable
 * off-Windows. On Windows, a `.cmd`/`.bat` shim (e.g. an npm-global phantombot)
 * cannot be spawned directly — Node throws EINVAL unless it goes through
 * cmd.exe. A native `phantombot.exe` runs fine directly.
 *
 * SECURITY: never route this through `shell:true`. `persona` comes from VS Code
 * workspace settings (attacker-controllable via a malicious .code-workspace),
 * and `shell:true` would hand it to cmd.exe for metacharacter interpretation —
 * `--persona "x & calc.exe"` would run calc.exe. Instead we spawn cmd.exe
 * explicitly (with `shell:false` at the call site) and pass `/d /s /c <bin>
 * ...args` as discrete argv elements. Node then applies its normal argv
 * double-quoting, so cmd treats `&`/`|`/`>` inside the quoted args literally
 * rather than as separators. (Ref: reviewer Kai/Lena on PR #277.)
 */
export function buildAcpSpawnCommand(
  bin: string,
  persona: string | undefined,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  const args = ["acp"];
  if (persona) args.push("--persona", persona);

  const isShim = platform === "win32" && /\.(cmd|bat)$/i.test(bin);
  if (isShim) {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", bin, ...args] };
  }
  return { command: bin, args };
}

export function spawnAcpTransport(options: AcpClientOptions): AcpTransport {
  const bin = options.binaryPath;
  if (!bin) {
    throw new Error(
      "spawnAcpTransport: binaryPath is required (resolve the phantombot binary first)",
    );
  }

  const { command, args } = buildAcpSpawnCommand(bin, options.persona);

  const child = spawn(command, args, {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    // Never use a shell: shim resolution is handled by cmd.exe above with
    // discrete argv, which keeps attacker-controlled args from being parsed as
    // shell syntax.
    shell: false,
    // Suppress the console window Windows opens for the ACP subprocess and any
    // tool subprocess it spawns. No-op on POSIX.
    windowsHide: true,
    // Inherit env so phantombot finds its config/secrets exactly as on a TTY —
    // but under a STRICT SNAP (Ubuntu App Center VS Code) `$HOME` is redirected
    // into the snap sandbox, whose persona/config store is empty, so plain
    // `phantombot acp` exits 2 ("no other personas exist"). snapAwareSpawnEnv
    // pins PHANTOMBOT_CONFIG back to the REAL home (via $SNAP_REAL_HOME) when —
    // and only when — we're snap-confined; loadConfig then resolves personas_dir
    // from that config (default OR custom), so PHANTOMBOT_PERSONAS_DIR is left
    // unset to avoid overriding a custom persona root.
    env: snapAwareSpawnEnv(process.env) as NodeJS.ProcessEnv,
  });

  let stdoutBuf = "";
  let lineHandler: (line: string) => void = () => {};
  let stderrHandler: (text: string) => void = () => {};
  let closeHandler: (info: { code: number | null }) => void = () => {};

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuf += chunk;
    let idx: number;
    while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      lineHandler(line);
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => stderrHandler(chunk));
  child.on("close", (code) => closeHandler({ code }));
  child.on("error", (err) => stderrHandler(`spawn error: ${err.message}`));

  return {
    write(line: string) {
      child.stdin?.write(line + "\n");
    },
    onLine(handler) {
      lineHandler = handler;
    },
    onStderr(handler) {
      stderrHandler = handler;
    },
    onClose(handler) {
      closeHandler = handler;
    },
    close() {
      try {
        child.stdin?.end();
      } catch {
        /* ignore */
      }
      child.kill();
    },
  };
}
