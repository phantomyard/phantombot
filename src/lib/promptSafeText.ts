/**
 * Rendering ATTACKER-INFLUENCED strings into a system prompt.
 *
 * -- Why this exists --
 * The overlay blocks built for #391/#405 (the sibling notice, the workspace
 * lock notice, the background-turn digest) all describe what ANOTHER turn did.
 * Every field in them - a checkout path, a conversation id, a free-text
 * `purpose`, a tool call's title, a closing summary - is a string some other
 * turn chose, and a turn's input can come from email, a webhook, a webpage, or
 * a raw `phantombot ask`. Interpolated raw, those strings sit in the SYSTEM
 * prompt of a later, trusted, tool-capable turn, having bypassed the threat
 * judge entirely: the judge screens the untrusted turn's INPUT, and by the time
 * its output is a lock record on disk nothing screens it again.
 *
 * A path is enough. `/tmp/x` followed by a newline and `# OVERRIDE:` ends the
 * list and opens what reads like a new instruction section, because markdown
 * headings and prompt sections are the same syntax.
 *
 * -- What this does, and what it does not --
 * It makes a string INERT AS MARKUP: one line, no control characters, no
 * backticks to close a span the template opened, bounded length. It does NOT
 * make the CONTENT trustworthy - "ignore previous instructions" is still those
 * words, just confined to one line inside a block labelled as data. The defence
 * against the content is the surrounding prose naming the block as data; this
 * function's job is to stop the string ESCAPING that framing. Both halves are
 * needed and neither is sufficient alone.
 *
 * Redaction is a separate concern handled earlier, at collection time (see
 * lib/redact.ts) - this is about structure, not secrets.
 */

/** Longest a single interpolated field may be before it is elided. */
const DEFAULT_MAX_CHARS = 200;

/**
 * Codepoint ranges that let a string break out of the line or span it is in.
 *
 * Written as numbers and compiled at runtime rather than as a literal character
 * class, so the source of a module about invisible characters does not itself
 * contain any.
 *
 *   0000-001F, 007F-009F  C0/C1 controls and DEL. A newline ends the list item;
 *                         a lone CR can hide the rest of the line in some
 *                         renderers.
 *   2028-2029             Unicode line and paragraph separators - newlines by
 *                         another name, and missed by a naive newline filter.
 *   200B-200F             Zero-width characters and directional marks.
 *   202A-202E, 2066-2069  Bidirectional overrides and isolates, which reorder
 *                         or conceal text so the rendered string differs from
 *                         the stored one. Anyone reading the prompt should see
 *                         what is actually there.
 */
const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x2028, 0x2029],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];

function classEscape(code: number): string {
  return "\\u" + code.toString(16).padStart(4, "0");
}

/**
 * Same ranges as `UNSAFE`, minus tab/newline — for `inertBlock`, which keeps
 * line structure instead of flattening it.
 */
const BLOCK_UNSAFE = new RegExp(
  "[" +
    UNSAFE_RANGES.flatMap(([lo, hi]) =>
      // Split the C0 range around TAB (0009) and LF (000A), the two control
      // characters a block is allowed to keep. CR is normalised to LF before
      // this runs, so it is not exempted here.
      lo === 0x0000 && hi === 0x001f
        ? [
            [0x0000, 0x0008],
            [0x000b, 0x001f],
          ]
        : [[lo, hi]],
    )
      .map(([lo, hi]) => `${classEscape(lo!)}-${classEscape(hi!)}`)
      .join("") +
    "]",
  "g",
);

const UNSAFE = new RegExp(
  "[" +
    UNSAFE_RANGES.map(
      ([lo, hi]) => `${classEscape(lo)}-${classEscape(hi)}`,
    ).join("") +
    "]",
  "g",
);

/**
 * One line, no markup escapes, bounded.
 *
 * Backticks become apostrophes rather than being dropped: the templates wrap
 * these values in `code spans`, and a stray backtick closes the span and spills
 * the rest into prose. Substituting keeps the value legible - a path with a
 * backtick reads as `/tmp/it's` - where deleting would silently rewrite it.
 */
export function inertText(
  value: string | undefined,
  maxChars: number = DEFAULT_MAX_CHARS,
): string {
  if (!value) return "";
  const flattened = value
    .replace(UNSAFE, " ")
    .replace(/`/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (flattened.length <= maxChars) return flattened;
  return `${flattened.slice(0, maxChars)}...`;
}

/**
 * `inertText`, with a visible placeholder when the result is empty.
 *
 * A field that sanitises down to nothing - it held only control characters, or
 * was never set - must not render as a blank gap that reads like the template
 * dropped a value. Say so instead.
 */
export function inertField(
  value: string | undefined,
  placeholder: string,
  maxChars?: number,
): string {
  return inertText(value, maxChars) || placeholder;
}

/**
 * Multi-line containment for a whole block of attacker-influenced text.
 *
 * `inertText` flattens to a single line, which is right for a field inside a
 * template sentence and useless for content that IS lines — a daily journal,
 * for one (lib/dailyRecall.ts). The structural escape that matters for a block
 * is the same one: markdown headings and prompt sections share a syntax, so a
 * line reading `# Security perimeter - TRUSTED turn` renders as a genuine
 * looking section of the system prompt. Wrapping the block in a fence does not
 * fix that on its own, because the block can contain a fence.
 *
 * So: keep newlines and tabs, strip every other escape character `inertText`
 * strips, and BACKSLASH-ESCAPE a leading hash run so no line inside the block
 * can open a heading. The result is still legible - `\# Notes` reads as what
 * was written - and it can no longer be mistaken for structure the prompt
 * builder emitted.
 *
 * As with `inertText`, this is confinement, not trust: the surrounding prose
 * naming the block as DATA is the other half, and neither is sufficient alone.
 */
export function inertBlock(value: string | undefined): string {
  if (!value) return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(BLOCK_UNSAFE, " ")
    .split("\n")
    .map((line) =>
      line.replace(
        /^([^\S\n]*)(#{1,6})(\s|$)/,
        (_m, ws: string, hashes: string, tail: string) =>
          `${ws}\\${hashes}${tail}`,
      ),
    )
    .join("\n")
    .trim();
}
