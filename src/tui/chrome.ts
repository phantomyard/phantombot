/**
 * How much window furniture the app draws around a screen.
 *
 * The first cut wrapped every screen in a rounded border with the breadcrumb
 * baked into the top edge. It looks like the mockups, and it costs two rows,
 * two columns and a whole class of shearing bugs — a border is the one thing
 * on screen whose correctness depends on the layout engine agreeing with the
 * font about how wide every glyph is.
 *
 * `bare` is the default: one plain header line, the body, the footer. Nothing
 * is drawn that has to line up with anything else. `boxed` keeps the old
 * border so the two can be compared side by side without a rebuild:
 *
 *     PHANTOMBOT_TUI_FRAME=boxed phantombot
 *
 * Read through a function, never a module-level constant, so a test can set
 * the variable and re-render in the same process.
 */

export type FrameVariant = "bare" | "boxed";

export function frameVariant(
  env: Record<string, string | undefined> = process.env,
): FrameVariant {
  return env.PHANTOMBOT_TUI_FRAME === "boxed" ? "boxed" : "bare";
}

/**
 * Rows the frame itself consumes, on top of whatever a screen budgets for its
 * own header and footer.
 *
 * The box spends two on its top and bottom border; the bare frame spends none,
 * because its header line replaces the border's title row rather than adding
 * to it. Screens add this to their own chrome constant, so dropping the border
 * gives the transcript two more rows instead of leaving a gap.
 */
export function frameChromeRows(
  variant: FrameVariant = frameVariant(),
): number {
  return variant === "boxed" ? 2 : 0;
}
