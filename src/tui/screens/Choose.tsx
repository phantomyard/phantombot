/**
 * The list-picker screen.
 *
 * The identity row asked "which prompt file?" through a `@clack` select, which
 * meant the one question standing between the user and `$EDITOR` was drawn
 * outside the app with no header, no footer and no `esc`. It is a list of
 * things to move a cursor over — precisely what every other screen in this app
 * already is — so it is a screen, with the same `↑↓ / ↵ / esc`.
 *
 * `esc` resolves `undefined`, and the caller treats that as "did nothing":
 * cancelling a picker must never fall through to acting on whatever the cursor
 * happened to be sitting on.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

import { Frame } from "../components/Frame.tsx";
import { Selectable } from "../components/Selectable.tsx";
import { badge, theme } from "../theme.ts";

export interface ChooseOption {
  value: string;
  label: string;
  hint?: string;
}

export interface ChooseRequest {
  title: string;
  options: readonly ChooseOption[];
  /** Value the cursor starts on — the setting's CURRENT value, when there is one. */
  initial?: string;
  /**
   * A sentence under the title explaining what the choice MEANS — what the
   * primary brain does, what a fallback is for. The flow's whole job is to
   * make the consequence legible before the pick, not after.
   */
  description?: string;
}

export function ChooseScreen(props: {
  request: ChooseRequest;
  onAnswer: (value: string | undefined) => void;
}): React.ReactElement {
  const { title, options, initial, description } = props.request;
  // Starting the cursor on the current value is what makes ↵ mean "leave it as
  // it is": a picker that always opens on row one turns every pass through a
  // long wizard into a chance to silently change a setting nobody asked about.
  const [index, setIndex] = useState(() => {
    const at = options.findIndex((o) => o.value === initial);
    return at >= 0 ? at : 0;
  });

  useInput((_char, key) => {
    if (key.escape) return props.onAnswer(undefined);
    if (key.upArrow) return setIndex((i) => Math.max(0, i - 1));
    if (key.downArrow)
      return setIndex((i) => Math.min(options.length - 1, i + 1));
    if (key.return) {
      const picked = options[index];
      // An empty list has nothing to answer with, and answering `""` would
      // read downstream as a real choice.
      if (picked) props.onAnswer(picked.value);
    }
  });

  return (
    <Frame
      title={["configure", "choose"]}
      footer={[
        { icon: badge.select, key: "↑↓", label: "Select" },
        { icon: badge.continue, key: "↵", label: "Continue" },
        { icon: badge.back, key: "esc", label: "Back" },
      ]}
    >
      <Box>
        <Text bold>{title}</Text>
      </Box>
      {description ? (
        <Box>
          <Text color={theme.dim}>{description}</Text>
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {options.map((option, i) => (
          <Selectable
            key={option.value}
            selected={i === index}
            onPress={() => props.onAnswer(option.value)}
          >
            <Box>
              <Box marginRight={1}>
                <Text backgroundColor={i === index ? theme.accent : undefined}>
                  {" "}
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
        ))}
      </Box>
    </Frame>
  );
}
