import { describe, expect, test } from "bun:test";

import {
  clampView,
  editorApplyKeys,
  editorBackspace,
  editorDelete,
  editorFromText,
  editorInsert,
  editorInsertNewline,
  editorIsDirty,
  editorMove,
  editorText,
  editorViewport,
} from "../src/tui/editorBuffer.ts";

describe("loading text", () => {
  test("an empty file is one empty line, not zero", () => {
    const b = editorFromText("");
    expect(b.lines).toEqual([""]);
  });

  test("crlf and tabs are normalised on load", () => {
    const b = editorFromText("a\r\nb\tc");
    expect(b.lines).toEqual(["a", "b  c"]);
  });
});

describe("inserting", () => {
  test("typing inserts at the cursor", () => {
    const b = editorInsert(editorFromText("hello"), "X");
    expect(editorText(b)).toBe("Xhello");
    expect(b.col).toBe(1);
  });

  test("a pasted chunk with newlines is characters, not commands", () => {
    const b = editorInsert(editorFromText("ab"), "tok\r\nen1\nmore");
    expect(editorText(b)).toBe("tok\nen1\nmoreab");
    expect(b.row).toBe(2);
  });

  test("newline splits at the cursor", () => {
    const b = editorInsertNewline(editorMove(editorFromText("abcd"), "right", 1));
    expect(editorText(b)).toBe("a\nbcd");
    expect(b.row).toBe(1);
    expect(b.col).toBe(0);
  });
});

describe("backspace and delete", () => {
  test("backspace at the seam joins with the previous line", () => {
    let b = editorFromText("ab\ncd");
    b = editorMove(b, "down");
    b = editorBackspace(b);
    expect(editorText(b)).toBe("abcd");
    expect(b.col).toBe(2);
  });

  test("backspace at origin is a no-op", () => {
    const b = editorBackspace(editorFromText("x"));
    expect(editorText(b)).toBe("x");
  });

  test("delete at end of line joins the next line", () => {
    let b = editorFromText("ab\ncd");
    b = editorMove(b, "end");
    b = editorDelete(b);
    expect(editorText(b)).toBe("abcd");
  });
});

describe("movement", () => {
  test("left at origin of line 2 lands at end of line 1", () => {
    const b = editorMove(editorFromText("ab\ncd"), "down");
    const l = editorMove(b, "left");
    expect(l.row).toBe(0);
    expect(l.col).toBe(2);
  });

  test("up and down hold a goal column across shorter lines", () => {
    let b = editorFromText("long line here\nx\nanother longer line");
    b = editorMove(b, "end"); // (0,14), goal 14
    b = editorMove(b, "down", 1); // clamped to "x"
    expect(b.col).toBe(1);
    b = editorMove(b, "down", 1); // goal held → col 14 on the long line
    expect(b.col).toBe(14);
    b = editorMove(b, "up", 1); // goal STILL held → clamped to "x" again
    expect(b.col).toBe(1);
    b = editorMove(b, "up", 1); // back where the goal pointed
    expect(b.col).toBe(14);
  });

  test("home and end", () => {
    let b = editorFromText("abcd");
    b = editorMove(b, "end");
    expect(b.col).toBe(4);
    b = editorMove(b, "home");
    expect(b.col).toBe(0);
  });

  test("page keys move by the given page size", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n");
    let b = editorFromText(lines);
    b = editorMove(b, "pageDown", 20);
    expect(b.row).toBe(20);
    b = editorMove(b, "pageUp", 20);
    expect(b.row).toBe(0);
  });

  test("editorApplyKeys maps ink flags and ignores everything else", () => {
    expect(editorApplyKeys({ upArrow: true })).toBe("up");
    expect(editorApplyKeys({ pageDown: true })).toBe("pageDown");
    expect(editorApplyKeys({})).toBeUndefined();
  });
});

describe("dirtiness", () => {
  test("untouched buffer is clean, any edit is dirty", () => {
    const b = editorFromText("same");
    expect(editorIsDirty(b, "same")).toBe(false);
    expect(editorIsDirty(editorInsert(b, "!"), "same")).toBe(true);
  });

  test("a file with tabs or CRLF line endings is NOT dirty on open", () => {
    // The loader normalises tabs → two spaces and CRLF/CR → LF; the dirty
    // baseline must apply the same normalisation, or every tab- or CRLF-
    // containing file opens "dirty" with zero keystrokes (and esc pops the
    // discard menu for edits that do not exist).
    expect(editorIsDirty(editorFromText("a\r\nb\n"), "a\r\nb\r\n")).toBe(false);
    expect(editorIsDirty(editorFromText("a  b"), "a\tb")).toBe(false);
    // A real edit is still dirty.
    expect(editorIsDirty(editorInsert(editorFromText("a\r\nb"), "!"), "a\r\nb")).toBe(true);
  });
});

describe("viewport", () => {
  test("the cursor row is always inside the window", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n");
    let b = editorFromText(lines);
    for (let i = 0; i < 45; i++) b = editorMove(b, "down", 1);
    const v = editorViewport(b, 0, 0, 20, 80);
    expect(v.firstRow).toBeLessThanOrEqual(b.row);
    expect(v.firstRow + 20).toBeGreaterThan(b.row);
  });

  test("long lines scroll horizontally to keep the cursor visible", () => {
    const b = editorFromText("a".repeat(200));
    const moved = editorMove(b, "end");
    const v = editorViewport(moved, 0, 0, 10, 80);
    expect(v.firstCol).toBeGreaterThan(0);
    expect(v.firstCol + 80).toBeGreaterThanOrEqual(moved.col + 1);
  });

  test("clampView edge-follows in both directions", () => {
    expect(clampView(25, 0, 20)).toBe(6);
    expect(clampView(2, 10, 20)).toBe(2);
    expect(clampView(10, 5, 20)).toBe(5);
  });
});
