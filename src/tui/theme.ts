/**
 * Colours and glyphs, in one place.
 *
 * Deliberately no widths, no column counts and no padding tables: the layout
 * engine owns geometry (see the border rule in `components/Frame.tsx`). This
 * file may only describe how something LOOKS, never where it is.
 */

export const theme = {
  accent: "cyan",
  dim: "gray",
  ok: "green",
  warn: "yellow",
  bad: "red",
  /** Selected-row background. */
  selection: "blueBright",
  /**
   * The header/footer bars.
   *
   * A bar is a filled Box, never a run of spaces: the layout engine paints the
   * background across the box's own width, so it stays flush on any resize.
   * Bar text has its OWN colours and never uses `theme.dim`: the bar is light
   * grey, so the body's light-on-dark palette has no contrast on it. Bar text
   * is DARK — both grey-on-grey and white-on-grey are unreadable here.
   */
  bar: {
    bg: "blackBright",
    fg: "black",
    accent: "blue",
    dim: "black",
  },
} as const;

export const glyph = {
  up: "●",
  down: "○",
  ok: "✓",
  bad: "✗",
  warn: "⚠",
  selected: "▸",
  bullet: "·",
  arrow: "→",
  gear: "⚙",
  play: "▶",
} as const;

/**
 * Footer badges: one glyph per ACTION, not per key.
 *
 * The badge says what the key DOES, so the same action carries the same mark
 * on every screen — `↵ send` and `↵ open` are different things and read
 * differently, while `⚙ settings` is the same thing wherever it appears. Keys
 * differ per screen (`esc` here, `←` there); actions do not. Single-width
 * glyphs only: a double-width emoji advances two columns in some fonts and one
 * in others, which is how a footer row starts shearing.
 */
export const badge = {
  send: "➤",
  history: "⇅",
  scroll: "↕",
  move: "⇅",
  select: "⇅",
  settings: "⚙",
  phantoms: "◈",
  quit: "✖",
  back: "←",
  open: "⏎",
  chat: "✉",
  new: "+",
  logs: "▤",
  search: "⌕",
  run: "▶",
  edit: "✎",
  save: "✓",
  cancel: "✗",
  unset: "✗",
  preview: "♪",
  change: "⇄",
  embeddings: "❋",
  reindex: "↻",
  background: "⇥",
  continue: "→",
  test: "◉",
} as const;

/** `42 MB`, `1.2 GB`, or `—` when the number is unknown. */
export function humanBytes(n: number | undefined): string {
  if (n === undefined) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value < 10 && i > 0 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

/** `1,234`, or `—`. */
export function humanCount(n: number | undefined): string {
  return n === undefined ? "—" : n.toLocaleString();
}

/**
 * An ISO timestamp as `today 08:03`, `yesterday 23:14` or `2026-08-21 03:14`.
 *
 * A settings screen is read at a glance, and a raw
 * `2026-08-28T08:03:01.316Z` makes the reader do timezone arithmetic to answer
 * "did the nightly run?". Unparseable input is returned unchanged rather than
 * rendered as `Invalid Date`.
 */
export function humanWhen(iso: string | undefined, now = new Date()): string {
  if (!iso) return "never";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const day = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (day(at) === day(now)) return `today ${time}`;
  if (day(at) === day(yesterday)) return `yesterday ${time}`;
  return `${at.toISOString().slice(0, 10)} ${time}`;
}

/** `2m 41s`. */
export function humanDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}
