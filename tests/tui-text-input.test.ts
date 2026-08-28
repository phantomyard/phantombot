/**
 * A chunk with a newline in it is a submit, not a character (issue #471).
 *
 * Found by a flaky regression test: under load the terminal delivered
 * `"alice"` and `"\r"` as ONE chunk, Ink reported no `key.return`, and the
 * wizard appended the newline to the persona name — it would have created a
 * persona whose directory name contained a line break.
 */

import { describe, expect, test } from "bun:test";

import { applyTextChunk } from "../src/tui/textInput.ts";

describe("applyTextChunk", () => {
  test("plain typing just appends", () => {
    expect(applyTextChunk("ali", "c")).toEqual({ text: "alic" });
  });

  test("a batched newline submits what came before it", () => {
    expect(applyTextChunk("ali", "ce\r")).toEqual({ text: "", submit: "alice" });
  });

  test("a bare newline submits the field as it stands", () => {
    expect(applyTextChunk("alice", "\r")).toEqual({ text: "", submit: "alice" });
  });

  test("text after the newline stays in the box", () => {
    expect(applyTextChunk("", "alice\nand then some")).toEqual({
      text: "and then some",
      submit: "alice",
    });
  });

  test("every newline flavour counts", () => {
    for (const nl of ["\r", "\n", "\r\n"]) {
      expect(applyTextChunk("a", `b${nl}`)).toEqual({ text: "", submit: "ab" });
    }
  });

  test("an empty field with a newline submits nothing", () => {
    expect(applyTextChunk("  ", "\r")).toEqual({ text: "" });
  });
});
