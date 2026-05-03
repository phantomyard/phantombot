/**
 * Unit tests for markdownToTelegramHtml — the markdown → Telegram HTML
 * subset converter. Covers each formatting transform plus the gnarly
 * edge cases (mid-word underscores, code spans containing format
 * delimiters, nested bold/italic, HTML escaping in literals and links).
 */

import { describe, expect, test } from "bun:test";
import { markdownToTelegramHtml } from "../src/channels/telegramFormat.ts";

describe("markdownToTelegramHtml — basics", () => {
  test("empty input → empty string", () => {
    expect(markdownToTelegramHtml("")).toBe("");
  });

  test("plain text passes through unchanged", () => {
    expect(markdownToTelegramHtml("hello world, no formatting here.")).toBe(
      "hello world, no formatting here.",
    );
  });

  test("escapes < > & in literal text", () => {
    expect(markdownToTelegramHtml("a < b && c > d")).toBe(
      "a &lt; b &amp;&amp; c &gt; d",
    );
  });
});

describe("markdownToTelegramHtml — bold / italic / strikethrough", () => {
  test("**bold** → <b>", () => {
    expect(markdownToTelegramHtml("hello **world**")).toBe(
      "hello <b>world</b>",
    );
  });

  test("__bold__ → <b>", () => {
    expect(markdownToTelegramHtml("hello __world__")).toBe(
      "hello <b>world</b>",
    );
  });

  test("*italic* → <i>", () => {
    expect(markdownToTelegramHtml("hello *world*")).toBe(
      "hello <i>world</i>",
    );
  });

  test("_italic_ → <i> at word boundary", () => {
    expect(markdownToTelegramHtml("hello _world_ ok")).toBe(
      "hello <i>world</i> ok",
    );
  });

  test("mid-word _ does NOT italicize identifiers", () => {
    // The classic regression: battery_alarm should stay literal.
    expect(markdownToTelegramHtml("`battery_alarm` and `battery_fault`")).toBe(
      "<code>battery_alarm</code> and <code>battery_fault</code>",
    );
    expect(markdownToTelegramHtml("look at battery_alarm here")).toBe(
      "look at battery_alarm here",
    );
  });

  test("~~strike~~ → <s>", () => {
    expect(markdownToTelegramHtml("~~gone~~")).toBe("<s>gone</s>");
  });

  test("multiple inline transforms in one line", () => {
    expect(markdownToTelegramHtml("**bold** and *italic* and `code`")).toBe(
      "<b>bold</b> and <i>italic</i> and <code>code</code>",
    );
  });
});

describe("markdownToTelegramHtml — code", () => {
  test("inline code escapes HTML", () => {
    expect(markdownToTelegramHtml("`<script>alert(1)</script>`")).toBe(
      "<code>&lt;script&gt;alert(1)&lt;/script&gt;</code>",
    );
  });

  test("inline code is NOT processed for bold/italic", () => {
    expect(markdownToTelegramHtml("`**not bold**`")).toBe(
      "<code>**not bold**</code>",
    );
  });

  test("fenced code block without language", () => {
    expect(markdownToTelegramHtml("```\nfoo\nbar\n```")).toBe(
      "<pre>foo\nbar</pre>",
    );
  });

  test("fenced code block with language", () => {
    expect(markdownToTelegramHtml("```python\nprint(1)\n```")).toBe(
      '<pre><code class="language-python">print(1)</code></pre>',
    );
  });

  test("fenced code block escapes HTML inside", () => {
    expect(markdownToTelegramHtml("```\n<div>a & b</div>\n```")).toBe(
      "<pre>&lt;div&gt;a &amp; b&lt;/div&gt;</pre>",
    );
  });

  test("fenced block doesn't break on inner backticks-in-text", () => {
    expect(
      markdownToTelegramHtml("```\nuse `xyz` directly\n```"),
    ).toBe("<pre>use `xyz` directly</pre>");
  });
});

describe("markdownToTelegramHtml — links", () => {
  test("[text](url)", () => {
    expect(markdownToTelegramHtml("[Power Forum](https://example.com/x)")).toBe(
      '<a href="https://example.com/x">Power Forum</a>',
    );
  });

  test("link href is HTML-attribute-escaped", () => {
    expect(
      markdownToTelegramHtml('[x](https://e.com/?q=a&b="c")'),
    ).toBe('<a href="https://e.com/?q=a&amp;b=&quot;c&quot;">x</a>');
  });

  test("link with bold label", () => {
    expect(markdownToTelegramHtml("[**bold**](https://e.com)")).toBe(
      '<a href="https://e.com"><b>bold</b></a>',
    );
  });

  test("link inside surrounding prose", () => {
    expect(
      markdownToTelegramHtml("see [docs](https://e.com) for details"),
    ).toBe('see <a href="https://e.com">docs</a> for details');
  });
});

describe("markdownToTelegramHtml — block-level", () => {
  test("# heading → <b>", () => {
    expect(markdownToTelegramHtml("# Hello")).toBe("<b>Hello</b>");
  });

  test("###### heading → <b>", () => {
    expect(markdownToTelegramHtml("###### Tiny")).toBe("<b>Tiny</b>");
  });

  test("# inside a sentence is NOT a heading", () => {
    expect(markdownToTelegramHtml("issue #123 was opened")).toBe(
      "issue #123 was opened",
    );
  });

  test("blockquotes collapse consecutive `> ` lines", () => {
    expect(markdownToTelegramHtml("> first\n> second\nplain")).toBe(
      "<blockquote>first\nsecond</blockquote>\nplain",
    );
  });

  test("horizontal rule → dropped", () => {
    expect(markdownToTelegramHtml("a\n---\nb")).toBe("a\n\nb");
  });

  test("list markers stay as plain text (Telegram has no list tags)", () => {
    expect(
      markdownToTelegramHtml("- one\n- two\n- three"),
    ).toBe("- one\n- two\n- three");
  });

  test("bold inside a list item works", () => {
    expect(
      markdownToTelegramHtml("- **Voltage:** 52.85 V\n- **SOC:** 61%"),
    ).toBe("- <b>Voltage:</b> 52.85 V\n- <b>SOC:</b> 61%");
  });
});

describe("markdownToTelegramHtml — tables", () => {
  test("simple pipe table → <pre>", () => {
    const md = [
      "| Name | Value |",
      "|------|-------|",
      "| SOC  | 61%   |",
      "| Temp | 27°C  |",
    ].join("\n");
    const html = markdownToTelegramHtml(md);
    expect(html).toBe(
      "<pre>| Name | Value |\n|------|-------|\n| SOC  | 61%   |\n| Temp | 27°C  |</pre>",
    );
  });

  test("table with leading/trailing whitespace on rows", () => {
    const md = [
      "  | A | B |  ",
      "  |---|---|  ",
      "  | 1 | 2 |  ",
    ].join("\n");
    const html = markdownToTelegramHtml(md);
    expect(html).toContain("<pre>");
    expect(html).toContain("| A | B |");
  });

  test("table with alignment colons in separator", () => {
    const md = [
      "| Left | Center | Right |",
      "|:-----|:------:|------:|",
      "| a    | b      | c     |",
    ].join("\n");
    const html = markdownToTelegramHtml(md);
    expect(html).toContain("<pre>");
    expect(html).toContain("|:-----|:------:|------:|");
  });

  test("two tables separated by text", () => {
    const md = [
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "Some text in between.",
      "",
      "| X | Y |",
      "|---|---|",
      "| 3 | 4 |",
    ].join("\n");
    const html = markdownToTelegramHtml(md);
    expect(html).toContain("Some text in between.");
    // Two <pre> blocks.
    const preCount = (html.match(/<pre>/g) ?? []).length;
    expect(preCount).toBe(2);
  });

  test("bold markers inside table cells are preserved literally", () => {
    // Inside <pre> everything is literal — no formatting tags.
    const md = [
      "| Key | Value |",
      "|-----|-------|",
      "| **SOC** | 61% |",
    ].join("\n");
    const html = markdownToTelegramHtml(md);
    expect(html).toContain("| **SOC** | 61% |");
    expect(html).not.toContain("<b>SOC</b>");
  });

  test("table cells with < > & are HTML-escaped inside <pre>", () => {
    const md = [
      "| Op | Result |",
      "|----|--------|",
      "| a < b | true |",
      "| a & b | false |",
    ].join("\n");
    const html = markdownToTelegramHtml(md);
    expect(html).toContain("a &lt; b");
    expect(html).toContain("a &amp; b");
  });

  test("single pipe in a line is NOT treated as a table", () => {
    // A line with just `a | b` (no leading pipe) is prose, not a table row.
    const md = "Voltage: 52 V | Current: 10 A";
    const html = markdownToTelegramHtml(md);
    // Should NOT be in <pre>.
    expect(html).not.toContain("<pre>");
  });

  test("isolated | with no separator row is NOT a table", () => {
    const md = "| just a pipe character in prose |";
    const html = markdownToTelegramHtml(md);
    expect(html).not.toContain("<pre>");
  });
});

describe("markdownToTelegramHtml — realistic LLM reply (Robbie's screenshot)", () => {
  test("the actual Deye fault reply renders cleanly", () => {
    const md = [
      "**F56 = `DC_VoltLow_Fault`** — inverter thinks battery DC voltage dropped too low.",
      "",
      "**But your battery looks fine:**",
      "- Voltage: **52.85 V** (healthy for 48 V LiFePO4)",
      "- `battery_alarm` and `battery_fault` sensors both **OK**",
    ].join("\n");
    const html = markdownToTelegramHtml(md);
    // Bold rendering on the F56 prefix.
    expect(html).toContain("<b>F56 = <code>DC_VoltLow_Fault</code></b>");
    // Code spans intact, no italic mangling of underscores.
    expect(html).toContain("<code>battery_alarm</code>");
    expect(html).toContain("<code>battery_fault</code>");
    // Bold with embedded value.
    expect(html).toContain("<b>52.85 V</b>");
    // List bullets pass through unchanged (Telegram has no list tags).
    expect(html).toContain("- ");
    // No literal markdown delimiters left.
    expect(html).not.toContain("**");
  });
});
