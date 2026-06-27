/**
 * ACP (Agent Client Protocol) JSON-RPC 2.0 wire types — CLIENT side.
 *
 * This is the editor-side mirror of `src/connectors/acp/protocol.ts` in the
 * phantombot server. The shapes here are deliberately a 1:1 copy of the wire
 * contract the server already implements — they are NOT invented. Grounding
 * references (server source, as of PR #209):
 *
 *   - initialize result:
 *       { protocolVersion, agentInfo:{name,version}, authMethods:[],
 *         agentCapabilities:{ loadSession, promptCapabilities:{...} } }
 *     (server.ts handleInitialize)
 *   - session/new params { cwd?, mcpServers? } → result { sessionId }
 *     (server.ts handleSessionNew)
 *   - session/load params { sessionId, cwd? } → streams session/update,
 *     then result { modes: null }   (server.ts handleSessionLoad)
 *   - session/prompt params { sessionId, prompt: AcpContentBlock[] } →
 *       streams agent_message_chunk + tool_call session/update notifications,
 *       then result { stopReason }   (server.ts handleSessionPrompt)
 *   - session/update notification { sessionId, update }
 *       update.sessionUpdate ∈ { agent_message_chunk, user_message_chunk,
 *                                tool_call }   (protocol.ts + server.ts)
 *   - session/cancel notification { sessionId }   (server.ts handleSessionCancel)
 *
 * The extension is the CLIENT (it spawns `phantombot acp` and drives it);
 * phantombot is the AGENT and owns persona/memory/tools/trust server-side.
 * This module is pure data — no I/O — so the client and participant layers
 * share one definition.
 */

// ── JSON-RPC 2.0 envelopes ─────────────────────────────────────────────

/** A JSON-RPC id is a string or number (the server never uses null ids). */
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

/** True for the success arm of a JSON-RPC response. */
export function isJsonRpcError(r: JsonRpcResponse): r is JsonRpcError {
  return (r as JsonRpcError).error !== undefined;
}

// ── ACP protocol constants ─────────────────────────────────────────────

/** Protocol version phantombot speaks. ACP draft = 1. Must match the server. */
export const ACP_PROTOCOL_VERSION = 1;

// ── ACP content blocks (subset we send) ────────────────────────────────

export interface AcpTextBlock {
  type: "text";
  text: string;
}

export interface AcpResourceContents {
  uri: string;
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
  text?: string;
}

export interface AcpImageBlock {
  type: "image";
  data?: string;
  mimeType?: string;
}

export type AcpContentBlock =
  | AcpTextBlock
  | AcpResourceBlock
  | AcpResourceLinkBlock
  | AcpImageBlock;

// ── initialize result ──────────────────────────────────────────────────

export interface AcpPromptCapabilities {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
}

export interface AcpAgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: AcpPromptCapabilities;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentInfo?: { name?: string; version?: string };
  authMethods?: unknown[];
  agentCapabilities?: AcpAgentCapabilities;
}

// ── session/new + session/load results ─────────────────────────────────

export interface AcpNewSessionResult {
  sessionId: string;
}

/** session/load returns a LoadSessionResponse struct (NEVER null). */
export interface AcpLoadSessionResult {
  modes: unknown | null;
}

// ── session/update notification payloads (what we receive) ─────────────

export interface AgentMessageChunkUpdate {
  sessionUpdate: "agent_message_chunk";
  content: AcpTextBlock;
}

export interface UserMessageChunkUpdate {
  sessionUpdate: "user_message_chunk";
  content: AcpTextBlock;
}

export interface ToolCallUpdate {
  sessionUpdate: "tool_call";
  toolCallId: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  kind?: string;
}

export type AcpSessionUpdate =
  | AgentMessageChunkUpdate
  | UserMessageChunkUpdate
  | ToolCallUpdate;

export interface SessionUpdateParams {
  sessionId: string;
  update: AcpSessionUpdate;
}

/** Why a `session/prompt` stopped. */
export type AcpStopReason = "end_turn" | "cancelled" | "refusal" | "max_tokens";

export interface AcpPromptResult {
  stopReason: AcpStopReason;
}

// ── Builders (client → agent) ──────────────────────────────────────────

let nextId = 1;
/** Monotonic JSON-RPC request id. Reset only for tests via `resetIdCounter`. */
export function allocId(): number {
  return nextId++;
}

/** TEST-ONLY: make id allocation deterministic across cases. */
export function resetIdCounter(start = 1): void {
  nextId = start;
}

export function jsonRpcRequest(
  id: JsonRpcId,
  method: string,
  params?: unknown,
): JsonRpcRequest {
  const req: JsonRpcRequest = { jsonrpc: "2.0", id, method };
  if (params !== undefined) req.params = params;
  return req;
}

export function jsonRpcNotification(
  method: string,
  params?: unknown,
): JsonRpcRequest {
  const req: JsonRpcRequest = { jsonrpc: "2.0", method };
  if (params !== undefined) req.params = params;
  return req;
}

/** Build the `prompt` content-block array for a plain text user turn. */
export function textPrompt(text: string): AcpContentBlock[] {
  return [{ type: "text", text }];
}
