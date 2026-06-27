/**
 * Menu-launcher command query-building tests — pure, no `vscode`.
 *
 * Covers the three discoverability entry points' shared query builders:
 *   - "Chat with Phantombot"      → openChatQuery()
 *   - "Ask Phantombot about this" → askAboutSelectionQuery()
 */

import { describe, expect, test } from "bun:test";

import {
  PARTICIPANT_MENTION,
  askAboutSelectionQuery,
  openChatQuery,
} from "../src/commands.ts";

describe("openChatQuery", () => {
  test("pre-fills the chat box with the participant mention + trailing space", () => {
    expect(openChatQuery()).toBe(`${PARTICIPANT_MENTION} `);
    expect(openChatQuery().startsWith("@phantombot")).toBe(true);
  });
});

describe("askAboutSelectionQuery", () => {
  test("fences the selection with the document languageId and addresses phantombot", () => {
    const q = askAboutSelectionQuery({
      selectedText: "const x = 1;",
      languageId: "typescript",
      fileName: "foo.ts",
    });
    expect(q.startsWith("@phantombot")).toBe(true);
    expect(q).toContain("foo.ts");
    expect(q).toContain("```typescript");
    expect(q).toContain("const x = 1;");
    // Fence opens and closes.
    expect((q.match(/```/g) ?? []).length).toBe(2);
  });

  test("omits the language tag when languageId is missing", () => {
    const q = askAboutSelectionQuery({ selectedText: "hello" });
    expect(q).toContain("```\nhello\n```");
  });

  test("trims trailing whitespace off the selection but keeps internal newlines", () => {
    const q = askAboutSelectionQuery({
      selectedText: "line1\nline2\n\n  ",
      languageId: "python",
    });
    expect(q).toContain("line1\nline2");
    expect(q).not.toMatch(/line2\n\n\n```/);
  });

  test("empty selection degrades to a plain addressed turn (never a dead no-op)", () => {
    expect(askAboutSelectionQuery({ selectedText: "" })).toBe(openChatQuery());
    expect(askAboutSelectionQuery({ selectedText: "   \n  " })).toBe(
      openChatQuery(),
    );
  });

  test("omits the file clause when fileName is absent", () => {
    const q = askAboutSelectionQuery({ selectedText: "x", languageId: "go" });
    expect(q).toContain("About this code:");
    expect(q).not.toContain("from `");
  });
});
