/**
 * ACP (Agent Client Protocol) JSON-RPC 2.0 wire types + builders.
 *
 * ACP is the protocol Zed (and, soon, other editors) speaks to an agent it
 * spawns as a subprocess: newline-delimited JSON-RPC 2.0 over stdio. The
 * editor is the CLIENT, phantombot is the AGENT. This module is pure data —
 * no I/O, no runTurn — so the server, session, and turn-bridge layers can all
 * share one definition of the wire shapes.
 *
 * We implement only the slice of ACP phantombot needs as a chat agent:
 *   initialize / authenticate / session.new / session.load /
 *   session.prompt / session.cancel (notification) / session.update (notif).
 *
 * NOTE ON STDOUT: the server writes exactly one JSON object per line to
 * stdout, and stdout is the protocol channel — never log there. See server.ts.
 */

import {isAbsolute, resolve as resolvePath} from "node:path";

import type {
  ToolCallDetail,
  ToolKind,
  ToolLocation
} from "../../harnesses/toolNote.ts";

// Re-export the tool-call vocabulary so ACP consumers import it from the
// protocol module rather than reaching into the harness layer.
export type {ToolKind, ToolLocation};

// ── JSON-RPC 2.0 envelopes ─────────────────────────────────────────────

/** A JSON-RPC id is a string or number (we never use null ids). */
export type JsonRpcId = string | number;

/** A request OR a notification (notifications have no `id`). */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  /** Absent ⇒ this is a notification (no response expected). */
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

/** Standard JSON-RPC 2.0 error codes (the ones we actually emit). */
export const JSON_RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

// ── ACP protocol constants ─────────────────────────────────────────────

/** Protocol version phantombot speaks. ACP draft = 1. */
export const ACP_PROTOCOL_VERSION = 1;

// ── ACP content blocks (subset) ────────────────────────────────────────

/**
 * A prompt content block. Zed sends an array of these in `session/prompt`.
 * We handle `text` (the user's instruction) and `resource`/`resource_link`
 * (@-mentioned files = reference DATA). image/audio are accepted on the wire
 * but ignored in v1.
 */
export interface AcpTextBlock {
  type: "text";
  text: string;
}

export interface AcpResourceContents {
  /** URI of the mentioned resource (e.g. file:///path). */
  uri: string;
  /** Inline text contents, when Zed embeds them. */
  text?: string;
  mimeType?: string;
}

export interface AcpResourceBlock {
  type: "resource";
  resource: AcpResourceContents;
}

export interface AcpResourceLinkBlock {
  type: "resource_link";
  uri: string;
  name?: string;
  mimeType?: string;
  /** Some clients inline a snippet on the link itself. */
  text?: string;
}

export interface AcpImageBlock {
  type: "image";
  data?: string;
  mimeType?: string;
}

export interface AcpAudioBlock {
  type: "audio";
  data?: string;
  mimeType?: string;
}

export type AcpContentBlock =
  | AcpTextBlock
  | AcpResourceBlock
  | AcpResourceLinkBlock
  | AcpImageBlock
  | AcpAudioBlock;

// ── session/update notification payloads ───────────────────────────────

/**
 * The streaming surface back to the editor. Each is wrapped in a
 * `session/update` notification carrying `{ sessionId, update }`.
 *
 * We emit:
 *   - agent_message_chunk  — a delta of assistant text (streamed live).
 *   - tool_call            — a minimal presentational tool indicator for
 *                            `progress` chunks (so Zed shows "working").
 */
export interface AgentMessageChunkUpdate {
  sessionUpdate: "agent_message_chunk";
  content: AcpTextBlock;
}

/** A tool-call `content` item — the panel renders it as a preview body. */
export interface ToolCallContentBlock {
  type: "content";
  content: AcpContentBlock;
}

export interface ToolCallUpdate {
  sessionUpdate: "tool_call";
  toolCallId: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  /** Panel icon (read/edit/execute/search/…). */
  kind?: ToolKind;
  /** File paths the editor renders as clickable jump-to-file links. */
  locations?: ToolLocation[];
  /** Optional richer preview body (issue #231; unpopulated pending redaction). */
  content?: ToolCallContentBlock[];
}

/**
 * One slash command the editor should offer in its `/`-menu.
 *
 * `input` describes the free-text argument, if the command takes one — Zed
 * renders `hint` as the placeholder after the command name.
 */
export interface AcpAvailableCommand {
  name: string;
  description: string;
  input?: { hint: string };
}

/**
 * Tells the client which slash commands this session accepts. Without it the
 * editor has no idea `/stop` exists, so it never offers it and (worse) sends
 * the typed text straight through as an ordinary prompt.
 */
export interface AvailableCommandsUpdate {
  sessionUpdate: "available_commands_update";
  availableCommands: AcpAvailableCommand[];
}

export type AcpSessionUpdate =
  | AgentMessageChunkUpdate
  | ToolCallUpdate
  | AvailableCommandsUpdate;

/** Why a `session/prompt` stopped. */
export type AcpStopReason = "end_turn" | "cancelled" | "refusal" | "max_tokens";

// ── Builders ───────────────────────────────────────────────────────────

export function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

export function jsonRpcError(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  const error: JsonRpcErrorObject = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

/** Build a `session/update` notification for a single update payload. */
export function sessionUpdateNotification(
  sessionId: string,
  update: AcpSessionUpdate,
): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update },
  };
}

/** Build an `agent_message_chunk` `session/update` for a text delta. */
export function agentMessageChunk(
  sessionId: string,
  text: string,
): JsonRpcRequest {
  return sessionUpdateNotification(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  });
}

/** Build an `available_commands_update` `session/update`. */
export function availableCommandsUpdate(
  sessionId: string,
  availableCommands: AcpAvailableCommand[],
): JsonRpcRequest {
  return sessionUpdateNotification(sessionId, {
    sessionUpdate: "available_commands_update",
    availableCommands,
  });
}

/**
 * Resolve tool-call `locations` to ABSOLUTE paths against the ACP session cwd.
 *
 * The ACP spec requires `ToolCallLocation.path` to be an absolute file path so
 * the editor can open/follow it. Harness tool args, however, are usually
 * relative to the session working dir (`src/foo.ts`), and a few are already
 * absolute. We resolve the relative ones against `cwd` and pass absolute ones
 * through untouched. Pure computation — `node:path` does no I/O. `cwd` is the
 * ACP session working dir, which is always absolute (server defaults it to
 * `process.cwd()`), so the result is always absolute regardless of input.
 */
export function toAbsoluteLocations(
  locations: readonly ToolLocation[],
  cwd: string
): ToolLocation[] {
  return locations.map((loc) =>
    isAbsolute(loc.path) ? loc : {...loc, path: resolvePath(cwd, loc.path)}
  );
}

/**
 * Build a presentational `tool_call` `session/update`.
 *
 * `detail` (issue #231) optionally carries the structured tool-call info —
 * `kind` (panel icon) and `locations` (clickable jump-to-file paths). Each
 * field is emitted only when present, so clients that don't consume them (and
 * the pre-#231 title-only behaviour) are unaffected. `content` is threaded but
 * emitted only when `detail.content` is set — currently never, pending the
 * secret-masking carry-over noted on `ToolCallDetail`.
 *
 * `cwd` is the ACP session working dir; `locations` are resolved against it to
 * absolute paths before hitting the wire, as the ACP spec requires.
 */
export function toolCallUpdate(
  sessionId: string,
  toolCallId: string,
  title: string,
  cwd: string,
  status: ToolCallUpdate["status"] = "in_progress",
  detail?: Pick<ToolCallDetail, "kind" | "locations" | "content">,
): JsonRpcRequest {
  const update: ToolCallUpdate = {
    sessionUpdate: "tool_call",
    toolCallId,
    title,
    status
  };
  if (detail) {
    if (detail.kind) update.kind = detail.kind;
    if (detail.locations && detail.locations.length > 0) {
      update.locations = toAbsoluteLocations(detail.locations, cwd);
    }
    if (detail.content) {
      update.content = [
        {type: "content", content: {type: "text", text: detail.content}}
      ];
    }
  }
  return sessionUpdateNotification(sessionId, update);
}
