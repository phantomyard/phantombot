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
  /**
   * Let a long description FLOW onto the next line instead of truncating.
   * Off by default: menus describe short hops ("run the checks"), where a
   * wrapped row would break the one-row-per-entry rhythm. The settings
   * table turns it on — its descriptions are live readings that must be
   * readable in full when the window narrows.
   */
  wrap?: boolean;
  /**
   * Fixed width for the badge column, so badges line up as a table column
   * across rows instead of sitting wherever each description ends. Text is
   * right-aligned inside the column. Without it the badge hugs the row end.
   */
  badgeWidth?: number;
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
            comes from `borderStyle`, so nothing here can deform it. Wide
            enough for the longest label in the app ("Discard changes"). */}
        <Box width={16} flexShrink={0}>
          <Text
            bold={selected}
            color={selected ? theme.accent : undefined}
            wrap="truncate"
          >
            {props.label}
          </Text>
        </Box>
        {/* `flexBasis={0}` + `flexGrow={1}`: this cell takes ALL the space
            the fixed columns leave — deterministically. The first cut relied
            on a second flexGrow spacer after it to push the badge right, but
            Yoga splits free space between two growing siblings, so the
            description got roughly HALF its width and wrapped far too early
            in narrow windows (the settings table rendered as overlapping
            rows). One growing child, basis zero: no arithmetic to drift. */}
        <Box flexGrow={1} flexShrink={1} flexBasis={0}>
          <Text color={theme.dim} wrap={props.wrap ? undefined : "truncate"}>
            {props.description ?? ""}
          </Text>
        </Box>
        {props.badge ? (
          <Box
            marginLeft={1}
            flexShrink={0}
            width={props.badgeWidth}
            justifyContent={props.badgeWidth ? "flex-end" : undefined}
          >
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
