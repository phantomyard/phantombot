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

/** A workspace folder candidate that backs one chat-session item. */
export interface SessionCandidate {
  cwd: string;
  name: string;
}

/**
 * Resolve the chat-session items to surface in the sessions list.
 *
 * One item per open workspace folder. When none are open (an empty window or a
 * folderless `.code-workspace`), fall back to a single item bound to the active
 * cwd so phantombot is always visible — matching how Claude/Copilot-CLI behave.
 */
export function resolveSessionCandidates(
  folders: SessionCandidate[],
  fallbackCwd: string,
  fallbackName = "phantombot",
): SessionCandidate[] {
  if (folders.length > 0) return folders;
  return [{ cwd: fallbackCwd, name: fallbackName }];
}

/** How the extension behaves on startup re: auto-opening the phantombot session. */
export type OpenOnStartup = "never" | "ifUsedBefore" | "always";

/**
 * Decide whether to auto-open the phantombot chat session when VS Code starts.
 *
 * Pure policy so it's unit-tested without a `vscode` host:
 *  - `"always"`       → open every launch.
 *  - `"never"`        → never auto-open (button / palette only).
 *  - `"ifUsedBefore"` (default) → open once the user has opened phantombot at
 *    least once before — the "sticky" behaviour: pick it once and it keeps
 *    coming back. To stop it, switch this setting to `"never"`.
 *
 * NOTE: this deliberately tracks "ever opened", not "was open at last shutdown".
 * VS Code's chat-session surface opens in the sidebar (a view, not an editor
 * tab), so there's no reliable close/last-window-state signal to honour a true
 * "reopen only if it was open when I quit" policy — promising that would be a
 * lie. "Ever opened" is the honest, robust contract and matches the actual ask
 * ("be there if I picked it before").
 */
export function shouldAutoOpenSession(
  setting: OpenOnStartup,
  usedBefore: boolean,
): boolean {
  switch (setting) {
    case "always":
      return true;
    case "never":
      return false;
    case "ifUsedBefore":
      return usedBefore;
    default:
      // Unknown value (e.g. a future/typo'd setting) → safest is the default policy.
      return usedBefore;
  }
}

/**
 * Per-type chat-session open commands. VS Code auto-registers these for a chat
 * session contribution ONLY when it declares `canDelegate: true` (see
 * ChatSessionsService._enableContribution → _registerCommands). Without that
 * flag the commands never exist and `executeCommand` throws "command not found"
 * — which is exactly why the quick-launch button and sticky auto-open silently
 * did nothing before. The manifest now sets `canDelegate: true`.
 */
export const SIDEBAR_OPEN_COMMAND = `workbench.action.chat.openNewSessionSidebar.${SESSION_TYPE}`;
export const EDITOR_OPEN_COMMAND = `workbench.action.chat.openNewSessionEditor.${SESSION_TYPE}`;
/**
 * Always-present last resort: focuses the agent-sessions viewer panel. It does
 * not open *our* session specifically, but it's a real registered command (the
 * old `workbench.view.sessions.chat.focus` fallback never existed), so the
 * button at least reveals the panel rather than no-opping.
 */
export const SESSIONS_VIEWER_FALLBACK =
  "workbench.action.chat.focusAgentSessionsViewer";

/**
 * Pick the best available command to open/reveal the phantombot session, given
 * the set of commands VS Code currently has registered. Pure so it's unit-tested
 * without a host: prefer the sidebar session command, then the editor variant,
 * then the viewer fallback. Returns `undefined` if none are present (e.g. the
 * per-type commands haven't registered yet during early startup — the caller
 * retries).
 */
export function pickOpenSessionCommand(
  available: Iterable<string>,
): string | undefined {
  const set = available instanceof Set ? available : new Set(available);
  if (set.has(SIDEBAR_OPEN_COMMAND)) return SIDEBAR_OPEN_COMMAND;
  if (set.has(EDITOR_OPEN_COMMAND)) return EDITOR_OPEN_COMMAND;
  if (set.has(SESSIONS_VIEWER_FALLBACK)) return SESSIONS_VIEWER_FALLBACK;
  return undefined;
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
      // Separate with a blank line so two distinct same-role turns never glue
      // into one bubble (defensive — today the server alternates roles).
      last.text += `\n\n${text}`;
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
    blocks.push({ type: "text", text: trimmed });
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
