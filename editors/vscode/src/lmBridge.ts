/**
 * Language-Model-Chat-Provider bridge (pure core).
 *
 * VS Code's Language Model Chat Provider API (stable since 1.104) lets us expose
 * phantombot as a first-class, selectable "model" in the native Chat view — no
 * `@phantombot` mention, and VS Code paints the conversation history for us. But
 * the API is built for STATELESS models: on every turn VS Code hands the
 * provider the ENTIRE transcript (`messages`) plus whatever context it wants to
 * staple on (replayed history, injected file context, tool preambles).
 *
 * phantombot is NOT stateless — it keeps its own memory server-side, keyed on
 * the workspace cwd (the ACP session resumes the same conversation). So if we
 * forwarded VS Code's whole `messages` blob down the ACP pipe, the agent would
 * see every prior turn twice: once from its own memory, once replayed by VS
 * Code. That's the doubling we must avoid.
 *
 * The rule this module enforces: forward ONLY the latest user turn (the new
 * thing the user just typed/attached). Everything else — prior messages,
 * injected context, assistant history — goes down the drain. phantombot's
 * server-side memory stays the single source of truth; VS Code's transcript is
 * decorative scrollback only.
 *
 * This file is pure (no `vscode`, no I/O beyond `Buffer`/`TextDecoder`) so the
 * doubling-prevention + attachment handling is unit-tested under `bun test`
 * against structural fakes, exactly like participant.ts.
 */

import type { AcpClient } from "./acpClient.ts";
import type { CancellationLike } from "./participant.ts";
import type {
  AcpContentBlock,
  AcpImageBlock,
  AcpStopReason,
} from "./protocol.ts";

/** VS Code's `LanguageModelChatMessageRole` numeric values (1 = User, 2 = Assistant). */
export const LM_ROLE_USER = 1;
export const LM_ROLE_ASSISTANT = 2;

/** Structural slice of `vscode.LanguageModelChatRequestMessage`. */
export interface LmMessageLike {
  readonly role: number;
  readonly content: ReadonlyArray<unknown>;
}

/** `LanguageModelTextPart` has `{ value: string }` and no `mimeType`. */
function isTextPart(p: unknown): p is { value: string } {
  return (
    !!p &&
    typeof (p as { value?: unknown }).value === "string" &&
    typeof (p as { mimeType?: unknown }).mimeType !== "string"
  );
}

/** `LanguageModelDataPart` has `{ mimeType: string, data: Uint8Array }`. */
function isDataPart(p: unknown): p is { mimeType: string; data: Uint8Array } {
  return (
    !!p &&
    typeof (p as { mimeType?: unknown }).mimeType === "string" &&
    (p as { data?: unknown }).data != null
  );
}

function toBase64(data: Uint8Array): string {
  // Buffer is a node global in the VS Code extension host.
  return Buffer.from(data).toString("base64");
}

function decodeUtf8(data: Uint8Array): string {
  try {
    return new TextDecoder("utf-8").decode(data);
  } catch {
    return "";
  }
}

/**
 * Reduce VS Code's full transcript to the single ACP prompt for the latest user
 * turn. Drops ALL history and any non-user/non-current parts.
 *
 * From the latest USER message we keep:
 *   - text parts          → joined into one text content block
 *   - image data parts    → ACP `image` blocks (base64), so pasted/dragged
 *                           photos reach the agent
 *   - non-image data parts (dragged text files, json) → decoded utf-8 and folded
 *                           into the text block, so file contents reach the agent
 * Tool-call / tool-result parts are ignored (phantombot owns tools server-side).
 *
 * Returns `[]` when there is no user message or it carried nothing usable; the
 * caller treats that as a no-op turn.
 */
export function latestUserPrompt(
  messages: readonly LmMessageLike[],
): AcpContentBlock[] {
  let latest: LmMessageLike | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === LM_ROLE_USER) {
      latest = m;
      break;
    }
  }
  if (!latest) return [];

  const texts: string[] = [];
  const images: AcpImageBlock[] = [];

  for (const part of latest.content) {
    if (isTextPart(part)) {
      if (part.value) texts.push(part.value);
    } else if (isDataPart(part)) {
      if (part.mimeType.startsWith("image/")) {
        images.push({
          type: "image",
          data: toBase64(part.data),
          mimeType: part.mimeType,
        });
      } else {
        const decoded = decodeUtf8(part.data).trim();
        if (decoded) texts.push(decoded);
      }
    }
    // tool-call / tool-result / unknown parts: dropped on the floor.
  }

  const blocks: AcpContentBlock[] = [];
  const text = texts.join("\n\n").trim();
  if (text) blocks.push({ type: "text", text });
  blocks.push(...images);
  return blocks;
}

/** A minimal `vscode.Progress`-like sink for streamed response parts. */
export interface LmProgressLike<TPart> {
  report(part: TPart): void;
}

export interface DriveLmResponseOptions<TPart> {
  client: AcpClient;
  sessionId: string;
  /** The latest-user-turn blocks (already reduced via {@link latestUserPrompt}). */
  blocks: AcpContentBlock[];
  progress: LmProgressLike<TPart>;
  /** Factory for a text response part (VS Code: `new LanguageModelTextPart(s)`). */
  makeTextPart(text: string): TPart;
  token?: CancellationLike;
}

/**
 * Drive one chat turn through the ACP client and stream assistant text into the
 * provider's `progress`. Mirrors participant.bridgePromptToStream but emits
 * `LanguageModelResponsePart`s instead of writing to a ChatResponseStream.
 *
 * Tool-call indicators are intentionally NOT emitted here: everything reported
 * to `progress` lands in VS Code's persisted transcript, and phantombot already
 * narrates its work in text, so we keep the scrollback clean.
 *
 * Errors (e.g. the subprocess died) propagate to the caller so the provider can
 * surface a precise message and drop the dead connection — never a silent hang.
 */
export async function driveLmResponse<TPart>(
  opts: DriveLmResponseOptions<TPart>,
): Promise<AcpStopReason> {
  const { client, sessionId, blocks, progress, makeTextPart, token } = opts;

  let cancelSub: { dispose(): void } | undefined;
  if (token) {
    if (token.isCancellationRequested) {
      client.cancel(sessionId);
    } else {
      cancelSub = token.onCancellationRequested(() => client.cancel(sessionId));
    }
  }

  try {
    return await client.prompt(sessionId, blocks, {
      onText: (text) => progress.report(makeTextPart(text)),
    });
  } finally {
    cancelSub?.dispose();
  }
}

/**
 * Rough token estimate for `provideTokenCount`. VS Code only needs this to
 * budget context windows; phantombot manages its own context server-side, so a
 * ~4-chars-per-token heuristic is plenty and avoids bundling a tokenizer.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}
