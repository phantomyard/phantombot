/**
 * The consequence panel.
 *
 * Every editable field in this TUI declares its side effect BEFORE the user
 * commits to it — this is where that declaration is shown. A settings screen
 * that only writes config is a trap: the user believes they changed something
 * and they only half did.
 *
 * `danger` moves the pre-selected answer to "no". That is not decoration: the
 * default-persona change reassigns who owns `/update` and `/restart`, and
 * control of a box must never move on a mis-tapped Enter.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

import { theme } from "../theme.ts";
import type { Consequence } from "../actions.ts";

export function Confirm(props: {
  title: string;
  consequence: Consequence;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): React.ReactElement {
  const [yes, setYes] = useState(!props.danger);

  useInput((char, key) => {
    if (key.escape) return props.onCancel();
    if (key.leftArrow || key.rightArrow) return setYes((v) => !v);
    if (char === "y") return props.onConfirm();
    if (char === "n") return props.onCancel();
    if (key.return) return yes ? props.onConfirm() : props.onCancel();
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={props.danger ? theme.warn : theme.accent}
      paddingX={1}
    >
      <Text bold>{props.title}</Text>
      <Box marginTop={1}>
        <Text color={theme.accent}>{props.consequence.summary}</Text>
      </Box>
      <Text color={theme.dim}>{props.consequence.detail}</Text>
      {props.consequence.restarts ? (
        <Text color={theme.dim}>The service restarts as part of this.</Text>
      ) : null}
      <Box marginTop={1}>
        <Text color={yes ? theme.accent : theme.dim}>
          {yes ? "[ yes ]" : "  yes  "}
        </Text>
        <Text color={!yes ? theme.accent : theme.dim}>
          {!yes ? "  [ no ]" : "   no  "}
        </Text>
      </Box>
    </Box>
  );
}
