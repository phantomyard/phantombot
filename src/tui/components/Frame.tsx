/**
 * The window frame: a titled border, a body, and a footer of key hints.
 *
 * ## Never draw the frame by hand
 *
 * Hand-built box-drawing borders are exactly what deforms. They encode a fixed
 * column count, so the border shears on any resize, any double-width glyph
 * (emoji, CJK), any wrapped label, and any font that renders `─` at a different
 * advance. The rule this whole app follows is that **no component may know the
 * terminal width**: borders come from `borderStyle` on a flex box, widths are
 * expressed as `flexGrow`/percentages, and over-long values are truncated by
 * the layout engine rather than by string arithmetic.
 *
 * `process.stdout.columns` appears in exactly one place in this codebase — the
 * resize listener in `App.tsx` that asks for a re-render — and nowhere else.
 */

import React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme.ts";
import { frameVariant } from "../chrome.ts";
import { VERSION } from "../../version.ts";

export interface FooterKey {
  /** What to press: "↵", "^s", "esc". */
  key: string;
  label: string;
  /**
   * The action's badge glyph (see `badge` in `theme.ts`). Optional only so a
   * one-off hint can omit it; every standing menu item carries one, because a
   * footer of bare `^t ^c ^s ^p` reads as noise until you have memorised it.
   */
  icon?: string;
  /** Set when this hint is also a click target (mouse is always optional). */
  onPress?: () => void;
}

export function Frame(props: {
  /** Breadcrumb: ["phantombot", "robbie", "memory"]. */
  title: string[];
  /** Right-aligned status text in the title bar. */
  status?: string;
  footer?: FooterKey[];
  children: React.ReactNode;
}): React.ReactElement {
  const boxed = frameVariant() === "boxed";
  // The bare header prints the product name itself, so a breadcrumb that also
  // starts with it would read `phantombot v1.1.316 ▸ phantombot ▸ robbie`.
  const crumbs = props.title.filter((c) => c !== "phantombot");
  const body = (
    /* CLIP, never overflow. A screen whose content is taller than the window
       otherwise draws straight through whatever is below it: rows overwrite
       each other, and with a border on it comes out as `╰─ ─ ─✚─Doctor─`.
       This is the backstop — screens that can grow (a long transcript, a long
       settings list) also window their own content so the part you need stays
       on screen, see `scroll.ts`. */
    <Box flexDirection="column" flexGrow={1} marginTop={1} overflow="hidden">
      {props.children}
    </Box>
  );
  const header = (
    /* A BAR, not a line of text: the background is painted by the layout
       engine across this box's own width, so it stays flush edge to edge on
       any resize. Never fill with spaces — that encodes a column count. */
    <Box width="100%" backgroundColor={theme.bar.bg} paddingX={1}>
      <Text color={theme.bar.accent} bold>
        phantombot
      </Text>
      <Text color={theme.bar.dim}> v{VERSION}</Text>
      {crumbs.length > 0 ? (
        <Text color={theme.bar.fg}>{` \u25b8 ${crumbs.join(" \u25b8 ")}`}</Text>
      ) : null}
      <Box flexGrow={1} />
      {props.status ? <Text color={theme.bar.dim}>{props.status}</Text> : null}
    </Box>
  );
  const footer =
    props.footer && props.footer.length > 0 ? (
      <Box width="100%" backgroundColor={theme.bar.bg} paddingX={1}>
        {props.footer.map((f) => (
          <Box key={f.key + f.label} marginRight={2}>
            {f.icon ? <Text color={theme.bar.dim}>{f.icon} </Text> : null}
            <Text color={theme.bar.accent} bold>
              {f.key}
            </Text>
            <Text color={theme.bar.dim}> {f.label}</Text>
          </Box>
        ))}
      </Box>
    ) : null;

  if (!boxed) {
    return (
      /* The bars run edge to edge, so the padding that keeps the BODY off the
         terminal wall belongs to the body, not to the root. */
      <Box flexDirection="column" flexGrow={1}>
        {header}
        <Box flexDirection="column" flexGrow={1} paddingX={1}>
          {body}
        </Box>
        {footer}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box
        flexDirection="column"
        flexGrow={1}
        borderStyle="round"
        borderColor={theme.accent}
        paddingX={1}
      >
        {header}
        {body}
      </Box>
      {footer}
    </Box>
  );
}

/** A labelled value line: `label   value`, aligned by the layout engine. */
export function Field(props: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}): React.ReactElement {
  return (
    <Box>
      <Box width="20%">
        <Text color={theme.dim}>{props.label}</Text>
      </Box>
      <Box flexGrow={1}>
        <Text>{props.value}</Text>
      </Box>
      {props.hint ? <Text color={theme.dim}>{props.hint}</Text> : null}
    </Box>
  );
}

/**
 * A full-width horizontal rule.
 *
 * Drawn as a box with only its bottom border enabled, never as a run of `─`
 * characters: a hand-built rule encodes a column count and is the exact thing
 * that shears on a resize. The layout engine sizes this one.
 */
export function Rule(): React.ReactElement {
  return (
    <Box
      borderStyle="single"
      borderColor={theme.dim}
      borderTop={false}
      borderLeft={false}
      borderRight={false}
    />
  );
}

/** A section heading inside a screen. */
export function Section(props: { title: string }): React.ReactElement {
  return (
    <Box marginTop={1}>
      <Text color={theme.dim} bold>
        {props.title.toUpperCase()}
      </Text>
    </Box>
  );
}
