/**
 * Chat-session bridge tests (pure core, no `vscode`).
 *
 * Covers the three load-bearing pieces of the first-class agent integration:
 *  - session identity ⇆ URI round-trip,
 *  - `session/load` replay → ordered role-tagged history turns,
 *  - request (text + dragged/pasted attachments) → ACP content blocks.
 */

import { describe, expect, test } from "bun:test";

import {
  cwdFromResourcePath,
  EDITOR_OPEN_COMMAND,
  imageMimeFromPath,
  isImageMime,
  makeReplayCollector,
  mintSessionId,
  pickOpenSessionCommand,
  promptBlocksFromRequest,
  resolveSessionCandidates,
  sessionResourcePath,
  SESSIONS_VIEWER_FALLBACK,
  shouldAutoOpenSession,
  SIDEBAR_OPEN_COMMAND,
  type SessionAttachment,
} from "../src/sessionBridge.ts";
import type { AcpSessionUpdate } from "../src/protocol.ts";

const userChunk = (text: string): AcpSessionUpdate => ({
  sessionUpdate: "user_message_chunk",
  content: { type: "text", text },
});
const agentChunk = (text: string): AcpSessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
});

describe("session identity ⇆ URI", () => {
  test("round-trips a POSIX cwd losslessly", () => {
    const cwd = "/home/andrew/Projects/phantomyard/phantombot";
    expect(cwdFromResourcePath(sessionResourcePath(cwd))).toBe(cwd);
  });

  test("normalises Windows backslashes into the URI path", () => {
    const path = sessionResourcePath("C:\\Users\\andrew\\proj");
    expect(path).toBe("C:/Users/andrew/proj");
  });

  test("mints unique opaque session tokens", () => {
    const a = mintSessionId();
    const b = mintSessionId();
    expect(a).toMatch(/^acp_[0-9a-f]{24}$/);
    expect(a).not.toBe(b);
  });
});

describe("makeReplayCollector — history rehydration", () => {
  test("accumulates alternating turns in order, role-tagged", () => {
    const { handlers, turns } = makeReplayCollector();
    handlers.onUpdate?.(userChunk("hello there"));
    handlers.onUpdate?.(agentChunk("hi! how can I help?"));
    handlers.onUpdate?.(userChunk("what's 2+2"));
    handlers.onUpdate?.(agentChunk("4"));

    expect(turns).toEqual([
      { role: "user", text: "hello there" },
      { role: "assistant", text: "hi! how can I help?" },
      { role: "user", text: "what's 2+2" },
      { role: "assistant", text: "4" },
    ]);
  });

  test("coalesces consecutive same-role chunks (defensive against streamed turns)", () => {
    const { handlers, turns } = makeReplayCollector();
    handlers.onUpdate?.(agentChunk("part one"));
    handlers.onUpdate?.(agentChunk("part two"));
    expect(turns).toEqual([{ role: "assistant", text: "part one\n\npart two" }]);
  });

  test("ignores tool_call updates and empty text", () => {
    const { handlers, turns } = makeReplayCollector();
    handlers.onUpdate?.({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "searching",
      status: "in_progress",
    });
    handlers.onUpdate?.(userChunk(""));
    expect(turns).toEqual([]);
  });
});

describe("promptBlocksFromRequest — text + attachments → ACP blocks", () => {
  test("plain text becomes a single text block", () => {
    expect(promptBlocksFromRequest("fix the bug")).toEqual([
      { type: "text", text: "fix the bug" },
    ]);
  });

  test("dragged photo becomes an image block; text preserved and ordered first", () => {
    const atts: SessionAttachment[] = [
      { kind: "image", mimeType: "image/png", base64: "AAAA" },
    ];
    expect(promptBlocksFromRequest("what is this?", atts)).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ]);
  });

  test("image-only turn (no typed text) is valid — emits just the image block", () => {
    const atts: SessionAttachment[] = [
      { kind: "image", mimeType: "image/jpeg", base64: "ZZZZ" },
    ];
    expect(promptBlocksFromRequest("   ", atts)).toEqual([
      { type: "image", data: "ZZZZ", mimeType: "image/jpeg" },
    ]);
  });

  test("dragged file becomes a resource_link block", () => {
    const atts: SessionAttachment[] = [
      { kind: "file", uri: "file:///proj/readme.md", name: "readme.md" },
    ];
    expect(promptBlocksFromRequest("summarise", atts)).toEqual([
      { type: "text", text: "summarise" },
      { type: "resource_link", uri: "file:///proj/readme.md", name: "readme.md" },
    ]);
  });

  test("empty everything yields no blocks", () => {
    expect(promptBlocksFromRequest("", [])).toEqual([]);
  });
});

describe("resolveSessionCandidates", () => {
  test("one item per open workspace folder", () => {
    const folders = [
      { cwd: "/home/me/proj-a", name: "proj-a" },
      { cwd: "/home/me/proj-b", name: "proj-b" },
    ];
    expect(resolveSessionCandidates(folders, "/fallback")).toEqual(folders);
  });

  test("folderless window falls back to a single cwd-bound item", () => {
    expect(resolveSessionCandidates([], "/home/me")).toEqual([
      { cwd: "/home/me", name: "phantombot" },
    ]);
  });

  test("fallback name is customisable", () => {
    expect(resolveSessionCandidates([], "/home/me", "home")).toEqual([
      { cwd: "/home/me", name: "home" },
    ]);
  });
});

describe("shouldAutoOpenSession", () => {
  test('"always" opens regardless of prior state', () => {
    expect(shouldAutoOpenSession("always", false)).toBe(true);
    expect(shouldAutoOpenSession("always", true)).toBe(true);
  });

  test('"never" never opens', () => {
    expect(shouldAutoOpenSession("never", true)).toBe(false);
    expect(shouldAutoOpenSession("never", false)).toBe(false);
  });

  test('"ifPreviouslyOpened" tracks the remembered state', () => {
    expect(shouldAutoOpenSession("ifPreviouslyOpened", true)).toBe(true);
    expect(shouldAutoOpenSession("ifPreviouslyOpened", false)).toBe(false);
  });

  test("unknown setting falls back to the sticky default policy", () => {
    expect(shouldAutoOpenSession("bogus" as never, true)).toBe(true);
    expect(shouldAutoOpenSession("bogus" as never, false)).toBe(false);
  });
});

describe("pickOpenSessionCommand", () => {
  test("prefers the sidebar session command when present", () => {
    expect(
      pickOpenSessionCommand([
        SESSIONS_VIEWER_FALLBACK,
        EDITOR_OPEN_COMMAND,
        SIDEBAR_OPEN_COMMAND,
      ]),
    ).toBe(SIDEBAR_OPEN_COMMAND);
  });

  test("falls back to the editor session command when sidebar is absent", () => {
    expect(
      pickOpenSessionCommand([SESSIONS_VIEWER_FALLBACK, EDITOR_OPEN_COMMAND]),
    ).toBe(EDITOR_OPEN_COMMAND);
  });

  test("falls back to the sessions viewer when no per-type command exists", () => {
    expect(pickOpenSessionCommand([SESSIONS_VIEWER_FALLBACK])).toBe(
      SESSIONS_VIEWER_FALLBACK,
    );
  });

  test("returns undefined when nothing usable is registered (early startup)", () => {
    expect(pickOpenSessionCommand([])).toBeUndefined();
    expect(
      pickOpenSessionCommand(["some.other.command", "workbench.action.files.save"]),
    ).toBeUndefined();
  });

  test("accepts a Set as well as an array", () => {
    expect(pickOpenSessionCommand(new Set([SIDEBAR_OPEN_COMMAND]))).toBe(
      SIDEBAR_OPEN_COMMAND,
    );
  });

  test("the per-type ids are scoped to the phantombot session type", () => {
    expect(SIDEBAR_OPEN_COMMAND).toBe(
      "workbench.action.chat.openNewSessionSidebar.phantombot",
    );
    expect(EDITOR_OPEN_COMMAND).toBe(
      "workbench.action.chat.openNewSessionEditor.phantombot",
    );
  });
});

describe("image mime helpers", () => {
  test("isImageMime", () => {
    expect(isImageMime("image/png")).toBe(true);
    expect(isImageMime("text/plain")).toBe(false);
    expect(isImageMime(undefined)).toBe(false);
  });

  test("imageMimeFromPath maps common extensions, undefined otherwise", () => {
    expect(imageMimeFromPath("/a/b.png")).toBe("image/png");
    expect(imageMimeFromPath("/a/b.JPEG")).toBe("image/jpeg");
    expect(imageMimeFromPath("/a/b.webp")).toBe("image/webp");
    expect(imageMimeFromPath("/a/b.ts")).toBeUndefined();
    expect(imageMimeFromPath("/a/noext")).toBeUndefined();
  });
});
