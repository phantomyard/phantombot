/**
 * Markdown in the transcript (phantombot#481).
 *
 * The assertions are about ROWS and WIDTH, not about a string appearing
 * somewhere: the transcript's whole design is that measurement and drawing are
 * the same flat list, so a renderer that emits a row wider than the window, or
 * a row containing a newline, deforms the frame no matter how pretty the
 * markup is. Those two invariants are pinned first and hardest.
 */

import { describe, expect, test } from "bun:test";

import {
  fitColumns,
  inlineSpans,
  markdownLines,
  wrapSpans,
  type RichLine,
} from "../src/tui/markdown.ts";

const plain = (lines: readonly RichLine[]) =>
  lines.map((l) => " ".repeat(l.indent) + l.spans.map((s) => s.text).join(""));

const widest = (lines: readonly RichLine[]) =>
  Math.max(0, ...lines.map((l) => l.indent + l.spans.reduce((a, s) => a + s.text.length, 0)));

describe("markdownLines", () => {
  test("no row is wider than the width it was given, whatever the block", () => {
    const md = [
      "# A heading that runs on well past the edge of a narrow terminal window",
      "",
      "A paragraph with **bold** and a https://example.com/a/very/long/url/that/cannot/wrap link.",
      "",
      "- a bullet whose text is much longer than the window and therefore has to wrap",
      "",
      "> a quoted line that is also far too long to fit in the space available here",
      "",
      "| col | another column | third |",
      "| --- | --- | --- |",
      "| a value | a much longer value than fits | x |",
      "",
      "```sh",
      "gh pr create --title 'a command line far longer than the terminal is wide'",
      "```",
    ].join("\n");
    for (const width of [24, 40, 60, 80]) {
      expect(widest(markdownLines(md, width))).toBeLessThanOrEqual(width);
    }
  });

  test("a rendered row is exactly one row — spans never carry a newline", () => {
    const lines = markdownLines("one\n\ntwo\n\n```\na\nb\n```", 40);
    for (const line of lines) {
      for (const span of line.spans) expect(span.text).not.toContain("\n");
    }
  });

  test("emphasis becomes attributes, and the markers are gone", () => {
    const [line] = markdownLines("say **loud** and *soft* and `code`", 60);
    expect(plain([line!])[0]).toBe("say loud and soft and code");
    const bold = line!.spans.find((s) => s.bold);
    const italic = line!.spans.find((s) => s.italic);
    const code = line!.spans.find((s) => s.code);
    expect(bold?.text).toBe("loud");
    expect(italic?.text).toBe("soft");
    expect(code?.text).toBe("code");
  });

  test("a star inside inline code does not open emphasis", () => {
    const [line] = markdownLines("run `ls *.ts` now", 60);
    expect(plain([line!])[0]).toBe("run ls *.ts now");
    expect(line!.spans.some((s) => s.italic)).toBe(false);
  });

  test("an unmatched marker is left as literal text", () => {
    expect(plain(markdownLines("2 * 3 = 6 and a lone ` tick", 60))).toEqual([
      "2 * 3 = 6 and a lone ` tick",
    ]);
  });

  test("an escaped marker survives as the character it escaped", () => {
    expect(plain(markdownLines("literally \\*stars\\*", 60))).toEqual([
      "literally *stars*",
    ]);
  });

  test("a link keeps its target, because a terminal cannot be clicked", () => {
    const [line] = markdownLines("see [the docs](https://example.com/d)", 60);
    expect(plain([line!])[0]).toContain("the docs");
    expect(plain([line!])[0]).toContain("https://example.com/d");
  });

  test("lists get a bullet, a hanging indent, and keep their numbering", () => {
    const rows = plain(markdownLines("- alpha\n- beta\n  - nested", 40));
    expect(rows[0]).toBe("• alpha");
    expect(rows[2]).toBe("  • nested");
    expect(plain(markdownLines("1. one\n2. two", 40))).toEqual(["1. one", "2. two"]);
  });

  test("a wrapped list item lines up under its own text, not under the bullet", () => {
    const rows = plain(markdownLines("- alpha beta gamma delta epsilon", 16));
    expect(rows[0]).toBe("• alpha beta");
    expect(rows[1]!.startsWith("  ")).toBe(true);
    expect(rows[1]!.trim()).toBe("gamma delta");
  });

  test("fenced code is truncated, never re-wrapped", () => {
    const rows = plain(
      markdownLines("```\n" + "gh pr create --title x".repeat(4) + "\n```", 30),
    );
    // One row in, one row out: a re-flowed command line looks copy-pasteable
    // and is not.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.endsWith("…")).toBe(true);
  });

  test("the fence markers themselves are not printed", () => {
    expect(plain(markdownLines("```bash\nls\n```", 40))).toEqual([" ls"]);
  });

  test("an unterminated fence still renders its body", () => {
    expect(plain(markdownLines("```\nls -la", 40))).toEqual([" ls -la"]);
  });

  test("a table gets a header, a divider and one row per record", () => {
    const rows = plain(
      markdownLines(
        "| name | count |\n| --- | --- |\n| alpha | 1 |\n| beta | 2 |",
        40,
      ),
    );
    expect(rows).toHaveLength(4);
    expect(rows[1]).toMatch(/─+┼─+/);
    expect(rows[2]).toContain("alpha");
    expect(rows[3]).toContain("beta");
  });

  test("a table too wide to fit truncates cells instead of being compressed", () => {
    const md =
      "| a | b |\n| --- | --- |\n| " +
      "x".repeat(60) +
      " | " +
      "y".repeat(60) +
      " |";
    const rows = markdownLines(md, 30);
    expect(widest(rows)).toBeLessThanOrEqual(30);
    expect(plain(rows)[2]).toContain("…");
  });

  test("headings lose their hashes and keep their words", () => {
    expect(plain(markdownLines("## Release notes", 40))).toEqual(["Release notes"]);
    expect(markdownLines("## Release notes", 40)[0]!.spans[0]!.bold).toBe(true);
  });

  test("a horizontal rule fills the width exactly", () => {
    const [line] = markdownLines("---", 30);
    expect(plain([line!])[0]).toBe("─".repeat(30));
  });

  test("blank lines are preserved as blank rows", () => {
    expect(plain(markdownLines("a\n\nb", 40))).toEqual(["a", "", "b"]);
  });

  test("plain prose is unchanged apart from wrapping", () => {
    expect(plain(markdownLines("just a sentence.", 40))).toEqual(["just a sentence."]);
  });

  test("the same input at the same width always renders the same rows", () => {
    // Purity is what makes the width-drop forceRepaint path safe: there is no
    // cached layout that a resize could leave stale.
    const md = "# h\n\n- a\n- b\n\n| x | y |\n| - | - |\n| 1 | 2 |";
    expect(markdownLines(md, 44)).toEqual(markdownLines(md, 44));
  });
});

describe("wrapSpans", () => {
  test("attributes survive a wrap", () => {
    const rows = wrapSpans(inlineSpans("**alpha beta gamma**"), 12);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.every((s) => s.bold))).toBe(true);
  });

  test("a word longer than the row is hard-split rather than overflowing", () => {
    const rows = wrapSpans([{ text: "x".repeat(25) }], 10);
    expect(rows.map((r) => r[0]!.text.length)).toEqual([10, 10, 5]);
  });
});

describe("fitColumns", () => {
  test("the widest column gives up space first", () => {
    expect(fitColumns([5, 40, 6], 30)).toEqual([5, 19, 6]);
  });

  test("no column is shrunk below three columns of content", () => {
    expect(fitColumns([10, 10], 4)).toEqual([3, 3]);
  });
});
