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

/** `2m 41s`. */
export function humanDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}
