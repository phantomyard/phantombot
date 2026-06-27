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

export interface ToolCallUpdate {
  sessionUpdate: "tool_call";
  toolCallId: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  kind?: string;
}

export type AcpSessionUpdate = AgentMessageChunkUpdate | ToolCallUpdate;

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

/** Build a minimal presentational `tool_call` `session/update`. */
export function toolCallUpdate(
  sessionId: string,
  toolCallId: string,
  title: string,
  status: ToolCallUpdate["status"] = "in_progress",
): JsonRpcRequest {
  return sessionUpdateNotification(sessionId, {
    sessionUpdate: "tool_call",
    toolCallId,
    title,
    status,
  });
}
