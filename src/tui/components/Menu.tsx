/**
 * Dressed list rows.
 *
 * The first cut of this app drew a menu as a caret and a word — legible, but it
 * read as debug output rather than as an application, and a selected row was
 * distinguishable from an unselected one only by a single leading glyph. That
 * is too weak a signal in a window full of dim text.
 *
 * A row here has four parts, all optional except the label: a selection BAR
 * that fills on the current row, an icon, a description that explains what the
 * row leads to, and a right-aligned badge carrying the row's state (`ready`,
 * `off`, a count). Selection is shown three ways at once — the bar, a bold
 * label, and a reversed key hint — because colour alone is unreliable across
 * terminal themes and unavailable to a colour-blind user.
 *
 * Still no geometry: widths are percentages and `flexGrow`, and the bar is a
 * padded `Box`, never a run of hand-counted `─` characters. See the border rule
 * in `Frame.tsx`.
 */

import React from "react";
import { Box, Text } from "ink";

import { Selectable } from "./Selectable.tsx";
import { theme } from "../theme.ts";

export interface MenuItemProps {
  label: string;
  description?: string;
  /** Right-aligned state: "ready", "3 secrets", "off". */
  badge?: string;
  badgeColor?: string;
  /** A single glyph in front of the label. */
  icon?: string;
  selected?: boolean;
  /** Shown reversed on the selected row: the key that activates it. */
  activateHint?: string;
  onPress?: () => void;
}

export function MenuItem(props: MenuItemProps): React.ReactElement {
  const selected = Boolean(props.selected);
  return (
    <Selectable selected={selected} onPress={props.onPress}>
      {/* `width="100%"` so the row actually spans its container: without it the
          row shrinks to its content and a right-aligned badge lands wherever
          the description happened to end. */}
      <Box width="100%">
        {/* The selection bar: one padded cell, filled only when current. */}
        <Box marginRight={1}>
          <Text backgroundColor={selected ? theme.accent : undefined}> </Text>
        </Box>
        {props.icon ? (
          <Box marginRight={1} flexShrink={0}>
            <Text color={selected ? theme.accent : theme.dim}>
              {props.icon}
            </Text>
          </Box>
        ) : null}
        {/* A fixed label column, not a percentage: at 22% of a narrow window
            "Channels" wrapped onto a second line and the row sheared. This is
            a flex child's width, not a hand-drawn border — the frame still
            comes from `borderStyle`, so nothing here can deform it. */}
        <Box width={14} flexShrink={0}>
          <Text
            bold={selected}
            color={selected ? theme.accent : undefined}
            wrap="truncate"
          >
            {props.label}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text color={theme.dim} wrap="truncate">
            {props.description ?? ""}
          </Text>
        </Box>
        {/* An explicit spacer: a `flexGrow` box whose child is short does not
            claim the slack on its own, so without this the badge sat glued to
            the end of the description instead of on the right edge. */}
        <Box flexGrow={1} />
        {props.badge ? (
          <Box marginLeft={1} flexShrink={0}>
            <Text color={props.badgeColor ?? theme.dim}>{props.badge}</Text>
          </Box>
        ) : null}
        {/* `flexShrink={0}`: the hint and badge are FIXED, the description is
            what gives. Without it "↵ edit in $EDITOR" wrapped onto a second
            line and the row became two rows tall — which then disagrees with
            the height the scroll window reserved for it. */}
        {selected && props.activateHint ? (
          <Box marginLeft={1} flexShrink={0}>
            <Text backgroundColor={theme.accent} color="black">
              {` ${props.activateHint} `}
            </Text>
          </Box>
        ) : null}
      </Box>
    </Selectable>
  );
}

/** A heading above a group of rows, with an optional right-hand count. */
export function MenuSection(props: {
  title: string;
  hint?: string;
}): React.ReactElement {
  return (
    <Box marginTop={1}>
      <Text color={theme.accent} bold>
        {props.title.toUpperCase()}
      </Text>
      <Box flexGrow={1} />
      {props.hint ? <Text color={theme.dim}>{props.hint}</Text> : null}
    </Box>
  );
}
