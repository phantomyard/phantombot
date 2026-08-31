/**
 * The multi-select screen — Choose's toggle sibling.
 *
 * Same rows, same keys, one addition: space flips a row's checkmark without
 * moving the cursor, and ↵ confirms the whole set. Skippable by design — the
 * persona questions that use it treat "nothing picked" as a valid answer
 * (the identity line carries the personality; skills are seasoning).
 *
 * `esc` resolves `undefined`, mirroring Choose: cancelling a picker must
 * never fall through to acting on whatever happened to be checked.
 */

import React, { useState } from "react";

import { useStableInput } from "../useStableInput.ts";
import { Box, Text } from "ink";

import { Frame } from "../components/Frame.tsx";
import { Selectable } from "../components/Selectable.tsx";
import { badge, theme } from "../theme.ts";

export interface MultiOption {
  value: string;
  label: string;
  hint?: string;
}

export interface MultiChooseRequest {
  title: string;
  options: readonly MultiOption[];
  /** Values checked when the screen opens — the CURRENT selection, if any. */
  initial?: readonly string[];
  /** Explanation block under the title — same contract as Choose. */
  description?: string | React.ReactNode;
}

export function MultiChooseScreen(props: {
  request: MultiChooseRequest;
  onAnswer: (values: string[] | undefined) => void;
}): React.ReactElement {
  const { title, options, initial, description } = props.request;
  const [index, setIndex] = useState(0);
  const [checked, setChecked] = useState<ReadonlySet<string>>(
    () => new Set(initial ?? []),
  );

  useStableInput((_char, key) => {
    if (key.escape) return props.onAnswer(undefined);
    if (key.upArrow) return setIndex((i) => Math.max(0, i - 1));
    if (key.downArrow)
      return setIndex((i) => Math.min(options.length - 1, i + 1));
    if (key.return) {
      // Preserve the options' order, not the toggle order — the readback
      // should match what the user saw on screen.
      props.onAnswer(
        options.filter((o) => checked.has(o.value)).map((o) => o.value),
      );
    }
    if (_char === " ") {
      const picked = options[index];
      if (!picked) return;
      setChecked((prev) => {
        const next = new Set(prev);
        if (next.has(picked.value)) next.delete(picked.value);
        else next.add(picked.value);
        return next;
      });
    }
  });

  return (
    <Frame
      title={["configure", "choose"]}
      footer={[
        { icon: badge.select, key: "↑↓", label: "Move" },
        { icon: badge.select, key: "space", label: "Toggle" },
        { icon: badge.continue, key: "↵", label: "Confirm" },
        { icon: badge.back, key: "esc", label: "Back" },
      ]}
    >
      <Box>
        <Text bold>{title}</Text>
      </Box>
      {description ? (
        <Box flexDirection="column">
          {typeof description === "string" ? (
            <Text color={theme.dim}>{description}</Text>
          ) : (
            description
          )}
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {options.map((option, i) => {
          const on = checked.has(option.value);
          return (
            <Selectable
              key={option.value}
              selected={i === index}
              onPress={() => {
                setIndex(i);
                setChecked((prev) => {
                  const next = new Set(prev);
                  if (next.has(option.value)) next.delete(option.value);
                  else next.add(option.value);
                  return next;
                });
              }}
            >
              <Box>
                <Box marginRight={1}>
                  <Text color={on ? theme.accent : theme.dim}>
                    {on ? "◉" : "○"}
                  </Text>
                </Box>
                <Text bold={i === index} color={i === index ? theme.accent : undefined}>
                  {option.label}
                </Text>
                {option.hint ? (
                  <Box marginLeft={1}>
                    <Text color={theme.dim}>{option.hint}</Text>
                  </Box>
                ) : null}
              </Box>
            </Selectable>
          );
        })}
      </Box>
    </Frame>
  );
}
