/**
 * Pure, vscode-free core for the phantombot **chat session** integration.
 *
 * This is the engine room behind registering phantombot as a first-class agent
 * in VS Code's native chat *sessions* surface (the dedicated panel, no
 * `@mention`) — the same slot Copilot CLI and Claude Code occupy. The thin
 * `vscode`-importing glue lives in `sessionProvider.ts`; everything decision-
 * making lives HERE so it runs under `bun test` with zero `vscode` dependency,
 * exactly like `participant.ts` / `lmBridge.ts`.
 *
 * Two responsibilities:
 *
 *  1. **Session identity ⇆ URI.** A phantombot conversation is keyed on the
 *     workspace cwd server-side (`acp:sha256(cwd)`, see src/connectors/acp/
 *     session.ts). We surface ONE durable session per workspace folder, encoding
 *     the cwd in the session resource URI under our own scheme so the content
 *     provider can recover it.
 *
 *  2. **History replay → turns.** `session/load` streams the persisted
 *     transcript back as user/agent message chunks (phantombot is the single
 *     source of truth). `makeReplayCollector()` accumulates those into ordered
 *     role-tagged turns the glue maps onto VS Code's `ChatRequestTurn2` /
 *     `ChatResponseTurn2`.
 *
 *  3. **Request → prompt blocks.** `promptBlocksFromRequest()` turns the typed
 *     text plus any dragged/pasted attachments (images, files) into the ACP
 *     content-block array the agent consumes — so photos and files Just Work.
 */

import { randomBytes } from "node:crypto";

import type { PromptHandlers } from "./acpClient.ts";
import type { AcpContentBlock, AcpSessionUpdate } from "./protocol.ts";

/** URI scheme owned by the phantombot chat-session provider. */
export const SESSION_SCHEME = "phantombot";

/** chatSessionType declared in package.json `contributes.chatSessions`. */
export const SESSION_TYPE = "phantombot";

/**
 * Encode a workspace cwd into the `path` of a session resource URI.
 *
 * The cwd is already an absolute fs path (`/home/me/proj` or `C:\proj`); we keep
 * it verbatim as the URI path so the mapping is a lossless round-trip. The glue
 * builds the final `Uri` as `{ scheme: SESSION_SCHEME, path }`.
 */
export function sessionResourcePath(cwd: string): string {
  // Normalise Windows backslashes to forward slashes for a clean URI path while
  // keeping the drive letter; cwdFromResourcePath reverses it.
  return cwd.replace(/\\/g, "/");
}

/** Recover the workspace cwd from a session resource URI path. */
export function cwdFromResourcePath(path: string): string {
  return path;
}

/** A single replayed history turn, role-tagged. */
export interface ReplayTurn {
  role: "user" | "assistant";
  text: string;
}

/**
 * Build a {@link PromptHandlers} sink that accumulates `session/load` replay
 * chunks into ordered {@link ReplayTurn}s.
 *
 * The server emits ONE `user_message_chunk` / `agent_message_chunk` per stored
 * turn (each carrying the full turn text — see handleSessionLoad), so we append
 * one turn per chunk. Consecutive chunks of the SAME role are coalesced
 * defensively in case a future server streams a turn in pieces.
 */
export function makeReplayCollector(): {
  handlers: PromptHandlers;
  turns: ReplayTurn[];
} {
  const turns: ReplayTurn[] = [];

  const push = (role: "user" | "assistant", text: string): void => {
    if (!text) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) {
      last.text += text;
      return;
    }
    turns.push({ role, text });
  };

  const handlers: PromptHandlers = {
    onUpdate(update: AcpSessionUpdate) {
      if (update.sessionUpdate === "agent_message_chunk") {
        if (update.content?.type === "text") push("assistant", update.content.text);
      } else if (update.sessionUpdate === "user_message_chunk") {
        if (update.content?.type === "text") push("user", update.content.text);
      }
      // tool_call updates carry no transcript text — ignore for history.
    },
  };

  return { handlers, turns };
}

/** A dragged/pasted attachment, already resolved to bytes/uri by the glue. */
export type SessionAttachment =
  | { kind: "image"; mimeType: string; base64: string }
  | { kind: "file"; uri: string; name?: string };

/**
 * Build the ACP content-block array for one user turn.
 *
 * - Typed text becomes a single `text` block (omitted when empty — an
 *   image-only or file-only turn is valid; the agent reads the attachments).
 * - Each image attachment becomes an `image` block (base64 + mime).
 * - Each file attachment becomes a `resource_link` block; the agent surfaces it
 *   as reference context (see flattenPromptBlocks server-side).
 *
 * Returns `[]` only when there is genuinely nothing to send.
 */
export function promptBlocksFromRequest(
  text: string,
  attachments: readonly SessionAttachment[] = [],
): AcpContentBlock[] {
  const blocks: AcpContentBlock[] = [];

  const trimmed = text.trim();
  if (trimmed.length > 0) {
    blocks.push({ type: "text", text });
  }

  for (const att of attachments) {
    if (att.kind === "image") {
      blocks.push({ type: "image", data: att.base64, mimeType: att.mimeType });
    } else {
      blocks.push({ type: "resource_link", uri: att.uri, name: att.name });
    }
  }

  return blocks;
}

/** Mint an opaque ACP session token (client side). The server re-derives the
 * stable conversation key from cwd regardless, so any unique token works. */
export function mintSessionId(): string {
  return `acp_${randomBytes(12).toString("hex")}`;
}

/** True when a guessed mime type denotes an image we can inline. */
export function isImageMime(mime: string | undefined): boolean {
  return typeof mime === "string" && mime.startsWith("image/");
}

/** Best-effort mime type from a file path's extension (images only — others
 * are sent as file references, mime irrelevant). */
export function imageMimeFromPath(path: string): string | undefined {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  const ext = m?.[1]?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    case "svg":
      return "image/svg+xml";
    default:
      return undefined;
  }
}
