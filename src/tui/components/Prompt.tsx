/**
 * A one-line input, optionally masked.
 *
 * `masked` is used for credentials. The typed value lives in this component's
 * state and is handed to the caller once on submit; nothing renders it, and no
 * screen above stores it. The rule for the whole app is that a secret VALUE
 * never reaches a rendered string — only its name and whether it is set.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

import { theme } from "../theme.ts";

export function Prompt(props: {
  label: string;
  hint?: string;
  masked?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [value, setValue] = useState("");

  useInput((char, key) => {
    if (key.escape) return props.onCancel();
    if (key.return) return props.onSubmit(value);
    if (key.backspace || key.delete) return setValue((v) => v.slice(0, -1));
    if (char && !key.ctrl && !key.meta) setValue((v) => v + char);
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
    >
      <Text>{props.label}</Text>
      <Box>
        <Text color={theme.accent}>{"> "}</Text>
        <Text>{props.masked ? "*".repeat(value.length) : value}</Text>
      </Box>
      {props.hint ? <Text color={theme.dim}>{props.hint}</Text> : null}
      <Text color={theme.dim}>enter to save · esc to cancel</Text>
    </Box>
  );
}
