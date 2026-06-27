/**
 * Chat-participant bridge: VS Code chat request → ACP prompt → response stream.
 *
 * The UI surface is VS Code's native Chat panel via the Chat Participant API
 * (`vscode.chat.createChatParticipant`, exposed as `@phantombot`). We do NOT
 * build a webview — VS Code gives us scrollback, history and theming for free.
 * This module is the thin bridge: it takes one chat request, drives a
 * `session/prompt` over the embedded ACP client, and maps the streamed
 * `session/update` chunks back into the panel's response stream.
 *
 * To keep the bridge unit-testable WITHOUT a `vscode` dependency, the core
 * mapping (`bridgePromptToStream`) is written against minimal structural
 * interfaces (`ResponseStream`, `PromptRequest`) that VS Code's real
 * `ChatResponseStream` / `ChatRequest` satisfy at the call site in
 * extension.ts. The bridge therefore runs under `bun test` over a fake stream +
 * a fake ACP client, exactly as the server tests drive runAcpServer over a
 * PassThrough.
 */

import type { AcpClient } from "./acpClient.ts";
import type { AcpStopReason } from "./protocol.ts";

/** The slice of `vscode.ChatResponseStream` the bridge writes to. */
export interface ResponseStream {
  /** Append assistant markdown text to the panel. */
  markdown(value: string): void;
  /** Optional: render a progress note (a presentational tool indicator). */
  progress?(value: string): void;
}

/** The slice of `vscode.ChatRequest` the bridge reads. */
export interface PromptRequest {
  /** The user's typed prompt (already stripped of the @participant mention). */
  prompt: string;
}

/** The slice of `vscode.CancellationToken` the bridge observes. */
export interface CancellationLike {
  isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface BridgeOptions {
  client: AcpClient;
  sessionId: string;
  request: PromptRequest;
  stream: ResponseStream;
  token?: CancellationLike;
}

export interface BridgeResult {
  stopReason: AcpStopReason;
}

/**
 * Drive one chat turn through the ACP client and into the response stream.
 *
 * - Text chunks (`agent_message_chunk`) are appended as markdown — VS Code
 *   renders incrementally, so this is the live streaming surface.
 * - Tool-call chunks become progress notes when the stream supports them.
 * - Cancellation from the panel fires `session/cancel`; the agent settles the
 *   prompt with `stopReason: "cancelled"`, which we return.
 *
 * Errors from the client (e.g. the subprocess died) propagate to the caller so
 * extension.ts can render a precise message into the panel — never a silent
 * hang.
 */
export async function bridgePromptToStream(
  opts: BridgeOptions,
): Promise<BridgeResult> {
  const { client, sessionId, request, stream, token } = opts;

  let cancelSub: { dispose(): void } | undefined;
  if (token) {
    if (token.isCancellationRequested) {
      client.cancel(sessionId);
    } else {
      cancelSub = token.onCancellationRequested(() => {
        client.cancel(sessionId);
      });
    }
  }

  try {
    const stopReason = await client.prompt(sessionId, request.prompt, {
      onText: (text) => stream.markdown(text),
      onToolCall: (title) => stream.progress?.(title),
    });
    return { stopReason };
  } finally {
    cancelSub?.dispose();
  }
}
