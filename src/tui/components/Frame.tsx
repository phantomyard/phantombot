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

export interface FooterKey {
  /** What to press: "↵", "^s", "esc". */
  key: string;
  label: string;
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
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box
        flexDirection="column"
        flexGrow={1}
        borderStyle="round"
        borderColor={theme.accent}
        paddingX={1}
      >
        <Box>
          <Text color={theme.accent} bold>
            {props.title.join(" ▸ ")}
          </Text>
          <Box flexGrow={1} />
          {props.status ? <Text color={theme.dim}>{props.status}</Text> : null}
        </Box>
        {/* CLIP, never overflow. A screen whose content is taller than the
            window otherwise draws straight through the bottom border: rows
            overwrite each other and the border comes out as `╰─ ─ ─✚─Doctor─`.
            This is the backstop — screens that can grow (a long transcript, a
            long settings list) also window their own content so the part you
            need stays on screen, see `scroll.ts`. */}
        <Box
          flexDirection="column"
          flexGrow={1}
          marginTop={1}
          overflow="hidden"
        >
          {props.children}
        </Box>
      </Box>
      {props.footer && props.footer.length > 0 ? (
        <Box paddingX={2}>
          {props.footer.map((f) => (
            <Box key={f.key + f.label} marginRight={2}>
              <Text color={theme.accent}>{f.key}</Text>
              <Text color={theme.dim}> {f.label}</Text>
            </Box>
          ))}
        </Box>
      ) : null}
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
