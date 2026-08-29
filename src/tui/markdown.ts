/**
 * Markdown, as ROWS (phantombot#481).
 *
 * The harness writes markdown — that is what every other surface renders and
 * what the model is trained to produce. Telegram and phantomchat both format
 * it; the TUI transcript did not, so a reply containing a table, a fenced
 * command or a bulleted list arrived as literal `**`, `|` and backticks. This
 * module is the missing half.
 *
 * ## Why it emits lines and spans instead of a string
 *
 * `transcript.ts` is a flat list of ROWS and the screen draws exactly those
 * rows — that is what makes one row of scroll one row on screen, and what
 * keeps clipping ahead of layout so the frame cannot be pushed off the bottom.
 * ANSI-decorated strings would break both: escape sequences are not glyphs, so
 * a wrapped line would be measured wrong and Yoga would be handed rows it
 * could not count. So a rendered line is `Span[]` — text plus attributes — and
 * Ink applies the attributes.
 *
 * ## Width is a hard input, not a hope
 *
 * Ink/Yoga COMPRESSES an over-wide child rather than clipping it, so anything
 * wider than the window silently deforms neighbouring boxes. Every block here
 * therefore takes the available width and either word-wraps (prose, list
 * items, quotes) or truncates with an ellipsis (code rows, table cells) — the
 * choice is made per block, never left to the layout engine. Because the whole
 * module is a pure function of (text, width), a resize or the width-drop
 * `forceRepaint` path simply re-renders at the new width; there is no cached
 * layout to invalidate.
 *
 * Deliberately not a CommonMark implementation: it is a terminal transcript,
 * so this covers what a chat reply actually contains — headings, fenced code,
 * pipe tables, lists, quotes, rules, and inline bold/italic/code/links.
 */

import stringWidth from "string-width";

/** One run of text with uniform attributes. */
export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /** Inline code or a fenced-code row: rendered in the code tone. */
  code?: boolean;
  underline?: boolean;
  /** Semantic colour, resolved to a theme colour by the screen. */
  tone?: "dim" | "accent" | "ok";
}

/** One drawable row: spans plus the left indent, in columns. */
export interface RichLine {
  spans: Span[];
  indent: number;
}

const BULLET = "•";
const ELLIPSIS = "…";

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Visible width in TERMINAL COLUMNS — not UTF-16 code units.
 *
 * `String.length` is wrong in both directions for real transcript text: a CJK
 * ideograph or an emoji occupies two columns for one unit, and a combining
 * mark occupies none. Measuring with `.length` would let a "fitted" row be
 * twice the window wide, which is precisely the deformation this module
 * exists to prevent, so every measurement here goes through `string-width` —
 * the same measure Ink itself uses to lay rows out.
 */
export function textWidth(text: string): number {
  return stringWidth(text, { countAnsiEscapeCodes: false });
}

/** The grapheme clusters of a string: the smallest unit safe to cut between. */
function graphemes(text: string): string[] {
  const out: string[] = [];
  for (const { segment } of SEGMENTER.segment(text)) out.push(segment);
  return out;
}

/**
 * The longest prefix of `text` that fits `width` columns, cut only between
 * grapheme clusters so a surrogate pair or a base+combining-mark pair is never
 * split down the middle.
 */
function sliceToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  if (textWidth(text) <= width) return text;
  let used = 0;
  let out = "";
  for (const g of graphemes(text)) {
    const w = textWidth(g);
    if (used + w > width) break;
    out += g;
    used += w;
  }
  return out;
}

/** The visible width of a span run, in terminal columns. */
function widthOf(spans: readonly Span[]): number {
  let n = 0;
  for (const s of spans) n += textWidth(s.text);
  return n;
}

/** Truncate a run of spans to `width`, marking the cut with an ellipsis. */
function truncateSpans(spans: readonly Span[], width: number): Span[] {
  if (width <= 0) return [];
  if (widthOf(spans) <= width) return [...spans];
  const out: Span[] = [];
  // The ellipsis itself costs a column, so the content budget is one short.
  let left = width - 1;
  for (const span of spans) {
    if (left <= 0) break;
    const text = sliceToWidth(span.text, left);
    if (!text) continue;
    left -= textWidth(text);
    out.push({ ...span, text });
  }
  out.push({ text: ELLIPSIS, tone: "dim" });
  return out;
}

/**
 * Word-wrap a run of spans to `width`, preserving attributes across the break.
 *
 * A word longer than the line (a URL, a hash) is hard-split rather than
 * allowed to overflow — an overflowing row is the one failure this module
 * exists to prevent.
 */
export function wrapSpans(spans: readonly Span[], width: number): Span[][] {
  const limit = Math.max(1, width);
  const rows: Span[][] = [];
  let row: Span[] = [];
  let used = 0;

  const push = (span: Span, text: string) => {
    const last = row[row.length - 1];
    if (last && sameStyle(last, span)) last.text += text;
    else row.push({ ...span, text });
    used += textWidth(text);
  };
  const breakRow = () => {
    rows.push(row);
    row = [];
    used = 0;
  };

  for (const span of spans) {
    // Keep the separators: a run is split into words AND the gaps between
    // them, so "a  b" survives and a wrap point is always at a real space.
    for (const piece of span.text.split(/(\s+)/)) {
      if (!piece) continue;
      if (/^\s+$/.test(piece)) {
        // Trailing whitespace never starts a row — it would look like a stray
        // indent after the break.
        if (used > 0 && used < limit) push(span, sliceToWidth(piece, limit - used));
        continue;
      }
      let word = piece;
      while (word.length > 0) {
        const room = limit - used;
        if (textWidth(word) <= room) {
          push(span, word);
          break;
        }
        if (used > 0) {
          breakRow();
          continue;
        }
        // Longer than a whole row: hard-split it, between graphemes.
        // A single cluster wider than the whole row (a two-column glyph in a
        // one-column box) is emitted anyway — nothing narrower exists, and
        // taking it is what guarantees the loop makes progress.
        const head = sliceToWidth(word, limit) || (graphemes(word)[0] ?? word);
        push(span, head);
        word = word.slice(head.length);
        breakRow();
      }
    }
  }
  rows.push(row);
  // Drop trailing spaces left at a break.
  for (const r of rows) {
    const last = r[r.length - 1];
    if (last) last.text = last.text.replace(/\s+$/, "");
  }
  return rows.filter((r, i) => i === 0 || r.length > 0 || rows.length === 1);
}

function sameStyle(a: Span, b: Span): boolean {
  return (
    !!a.bold === !!b.bold &&
    !!a.italic === !!b.italic &&
    !!a.code === !!b.code &&
    !!a.underline === !!b.underline &&
    a.tone === b.tone
  );
}

/**
 * Inline markup inside one logical line.
 *
 * Precedence is code → link → bold → italic, which is what stops the `*` in a
 * `` `a * b` `` snippet from opening emphasis. Anything unmatched (a lone `*`,
 * an unclosed backtick) is left as literal text rather than eating the rest of
 * the paragraph.
 */
export function inlineSpans(text: string, base: Span = { text: "" }): Span[] {
  const out: Span[] = [];
  let rest = text;
  const emit = (t: string, extra: Partial<Span> = {}) => {
    if (t) out.push({ ...base, ...extra, text: t });
  };

  while (rest.length > 0) {
    const match = nextMarker(rest);
    if (!match) {
      emit(unescape(rest));
      break;
    }
    emit(unescape(rest.slice(0, match.index)));
    rest = match.rest;
    out.push(...match.spans.map((s) => ({ ...base, ...s })));
  }
  return out.filter((s) => s.text.length > 0);
}

function unescape(text: string): string {
  return text.replace(/\\([\\`*_[\]()#>|~-])/g, "$1");
}

interface Marker {
  index: number;
  spans: Span[];
  rest: string;
}

function nextMarker(text: string): Marker | undefined {
  const patterns: Array<{
    re: RegExp;
    make: (m: RegExpExecArray) => Span[];
  }> = [
    {
      re: /(?<!\\)`([^`]+)`/,
      make: (m) => [{ text: m[1]!, code: true, tone: "ok" }],
    },
    {
      re: /(?<!\\)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/,
      make: (m) => {
        const label = m[1]!.trim();
        const url = m[2]!;
        if (!label || label === url) return [{ text: url, underline: true, tone: "accent" }];
        return [
          { text: label, underline: true, tone: "accent" },
          { text: ` (${url})`, tone: "dim" },
        ];
      },
    },
    {
      re: /(?<!\\)(\*\*|__)(?=\S)([\s\S]*?\S)\1/,
      make: (m) => inlineSpans(m[2]!, { text: "", bold: true }),
    },
    {
      re: /(?<!\\|\w)(\*|_)(?=\S)([^*_]*?\S)\1(?!\w)/,
      make: (m) => inlineSpans(m[2]!, { text: "", italic: true }),
    },
  ];

  let best: Marker | undefined;
  for (const { re, make } of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    if (best && m.index >= best.index) continue;
    best = {
      index: m.index,
      spans: make(m),
      rest: text.slice(m.index + m[0]!.length),
    };
  }
  return best;
}

const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/**
 * Render markdown to drawable rows at a fixed width.
 *
 * Pure: the same (text, width) always gives the same rows, which is what lets
 * the screen re-render on resize without any cached state.
 */
export function markdownLines(text: string, width: number): RichLine[] {
  const cols = Math.max(8, Math.floor(width));
  const src = text.replace(/\r\n?/g, "\n").split("\n");
  const out: RichLine[] = [];
  let i = 0;

  while (i < src.length) {
    const line = src[i]!;

    const fence = FENCE.exec(line);
    if (fence) {
      const closer = fence[1]![0]!;
      i += 1;
      const rows: string[] = [];
      while (i < src.length && !new RegExp(`^\\s{0,3}${closer}{3,}\\s*$`).test(src[i]!)) {
        rows.push(src[i]!);
        i += 1;
      }
      i += 1; // consume the closing fence (or fall off the end)
      // Code is TRUNCATED, never wrapped: a re-flowed command line is a lie —
      // it looks copy-pasteable and is not.
      for (const row of rows) {
        out.push({
          indent: 1,
          spans: truncateSpans([{ text: row.replace(/\t/g, "  "), code: true, tone: "ok" }], cols - 1),
        });
      }
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const spans = inlineSpans(heading[2]!, { text: "", bold: true, tone: "accent" });
      for (const row of wrapSpans(spans, cols)) out.push({ indent: 0, spans: row });
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      out.push({ indent: 0, spans: [{ text: "─".repeat(cols), tone: "dim" }] });
      i += 1;
      continue;
    }

    if (line.includes("|") && TABLE_DIVIDER.test(src[i + 1] ?? "") && !TABLE_DIVIDER.test(line)) {
      const rows: string[][] = [];
      const header = splitRow(line);
      i += 2;
      while (i < src.length && src[i]!.includes("|") && src[i]!.trim() !== "") {
        rows.push(splitRow(src[i]!));
        i += 1;
      }
      out.push(...tableLines(header, rows, cols));
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      const body = inlineSpans(quote[1]!, { text: "", tone: "dim", italic: true });
      const rows = wrapSpans(body, Math.max(4, cols - 2));
      for (const row of rows) {
        out.push({ indent: 0, spans: [{ text: "│ ", tone: "dim" }, ...row] });
      }
      i += 1;
      continue;
    }

    const list = LIST.exec(line);
    if (list) {
      const depth = Math.floor(list[1]!.replace(/\t/g, "  ").length / 2);
      const marker = /^\d/.test(list[2]!) ? list[2]! : BULLET;
      const indent = depth * 2;
      const lead = `${marker} `;
      const body = inlineSpans(list[3]!);
      const rows = wrapSpans(body, Math.max(4, cols - indent - lead.length));
      rows.forEach((row, n) => {
        out.push({
          indent,
          spans:
            n === 0
              ? [{ text: lead, tone: "accent" }, ...row]
              : [{ text: " ".repeat(lead.length) }, ...row],
        });
      });
      i += 1;
      continue;
    }

    if (line.trim() === "") {
      out.push({ indent: 0, spans: [] });
      i += 1;
      continue;
    }

    for (const row of wrapSpans(inlineSpans(line.trim()), cols)) {
      out.push({ indent: 0, spans: row });
    }
    i += 1;
  }

  return out;
}

/** `| a | b |` → `["a", "b"]`, tolerating the pipes being absent at the ends. */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

const CELL_FLOOR = 3;
const GAP = 3; // " │ "

/**
 * How many columns can be shown at all in `cols` terminal columns.
 *
 * Every shown column costs at least `CELL_FLOOR`, and every column after the
 * first also costs a `GAP` separator. Below one column there is nothing to
 * draw, so a viewport narrower than a single floored cell still shows one
 * (truncated) column rather than an empty row.
 */
export function fittableColumns(count: number, cols: number): number {
  const room = Math.max(1, Math.floor((cols + GAP) / (CELL_FLOOR + GAP)));
  return Math.max(1, Math.min(count, room));
}

/**
 * A pipe table, fitted to the terminal.
 *
 * Columns get their natural width when the table fits. When it does not, the
 * WIDEST columns are shrunk first (never below three columns) and cells are
 * truncated with an ellipsis — Yoga would otherwise compress the row and shear
 * the frame, and a silently squashed table reads as a rendering bug.
 *
 * Shrinking alone is not enough: a wide-enough table cannot fit at ANY cell
 * width, because `count * CELL_FLOOR + (count - 1) * GAP` already exceeds the
 * viewport. Those trailing columns are DROPPED rather than allowed to overflow,
 * and the loss is marked with a dim ellipsis column when the slack for one
 * exists — an admitted "there is more to the right" beats a sheared frame.
 */
function tableLines(header: string[], rows: string[][], cols: number): RichLine[] {
  const all = Math.max(header.length, ...rows.map((r) => r.length), 1);
  const count = fittableColumns(all, cols);
  const dropped = all - count;
  const cells = [header, ...rows].map((r) =>
    Array.from({ length: count }, (_, c) => r[c] ?? ""),
  );
  const natural = Array.from({ length: count }, (_, c) =>
    Math.max(CELL_FLOOR, ...cells.map((r) => plainWidth(r[c]!))),
  );
  const gap = GAP;
  // Reserve " …" for the drop marker, but only when it genuinely fits.
  const marker = dropped > 0 && cols - (count * CELL_FLOOR + gap * (count - 1)) >= 2 ? 2 : 0;
  const budget = cols - marker - gap * (count - 1);
  const widths = fitColumns(natural, budget);

  const sep = (): Span => ({ text: " │ ", tone: "dim" });
  const line = (row: string[], bold: boolean): RichLine => {
    const spans: Span[] = [];
    row.slice(0, count).forEach((cell, c) => {
      if (c > 0) spans.push(sep());
      const w = widths[c]!;
      const content = truncateSpans(inlineSpans(cell, { text: "", bold }), w);
      spans.push(...content);
      const pad = w - widthOf(content);
      if (pad > 0) spans.push({ text: " ".repeat(pad) });
    });
    if (marker > 0) spans.push({ text: ` ${ELLIPSIS}`, tone: "dim" });
    return { indent: 0, spans };
  };

  const divider: RichLine = {
    indent: 0,
    spans: [
      {
        text: widths.map((w) => "─".repeat(w)).join("─┼─"),
        tone: "dim",
      },
    ],
  };
  return [line(header, true), divider, ...rows.map((r) => line(padTo(r, count), false))];
}

function padTo(row: string[], count: number): string[] {
  return Array.from({ length: count }, (_, c) => row[c] ?? "");
}

/** Width of a cell once its inline markup is gone. */
function plainWidth(cell: string): number {
  return widthOf(inlineSpans(cell));
}

/** Shrink the widest columns until the row fits the budget. */
export function fitColumns(natural: readonly number[], budget: number): number[] {
  const widths = [...natural];
  let total = widths.reduce((a, b) => a + b, 0);
  while (total > budget) {
    let widest = 0;
    for (let c = 1; c < widths.length; c += 1) {
      if (widths[c]! > widths[widest]!) widest = c;
    }
    if (widths[widest]! <= 3) break;
    widths[widest] = widths[widest]! - 1;
    total -= 1;
  }
  return widths;
}
