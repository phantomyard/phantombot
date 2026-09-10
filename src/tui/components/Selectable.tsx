/**
 * A keyboard-selectable row.
 *
 * Rows are reachable with ↑↓ and ↵ only. The terminal keeps the mouse: no
 * mouse reporting is ever enabled, so native selection, copy and paste behave
 * exactly as they do over plain shell output.
 */

import React from "react";
import { Box, Text } from "ink";

import { glyph, theme } from "../theme.ts";

export function Selectable(props: {
  selected?: boolean;
  onPress?: () => void;
  fullWidth?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const selected = Boolean(props.selected);
  return (
    <Box
      backgroundColor={selected ? "blackBright" : undefined}
      alignSelf={props.fullWidth ? undefined : "flex-start"}
      paddingRight={props.fullWidth ? undefined : 1}
    >
      <Box marginRight={1}>
        <Text color={selected ? theme.accent : "gray"} bold={selected}>
          {selected ? glyph.selected : " "}
        </Text>
      </Box>
      <Box flexGrow={1}>{props.children}</Box>
    </Box>
  );
}
