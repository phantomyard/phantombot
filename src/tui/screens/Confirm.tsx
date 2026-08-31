/**
 * The confirmation screen.
 *
 * Every state-changing setting funnels through `askConfirm` in `App.tsx`, and
 * until now that funnel ended in a `@clack` panel: the renderer was suspended,
 * the alternate screen was left, and the question was drawn on the user's
 * normal terminal with no header, no footer and no `esc`. Five settings —
 * autostart, default persona, unsetting a key, the embedding change and voice
 * — all dropped out of the app to ask one yes/no question, which is the single
 * biggest break in the app's design language and (before `lendStdin`) the
 * place it could wedge.
 *
 * So the question is a SCREEN. It states the consequence first, exactly as the
 * clack panel did — a settings surface that writes config silently is a trap —
 * and it answers with the same keys as everything else: `↵` continues, `esc`
 * goes back. There is no third "cancelled vs no" answer to model, because the
 * caller only ever acted on an explicit yes.
 *
 * `danger` starts the cursor on **No**. Making a phantom the default reassigns
 * `/update` and `/restart`, and control of a box must never move on a
 * mis-tapped Enter.
 *
 * `confirmName` asks for the LOUDEST consent there is: the exact name typed
 * out by hand. Removing a whole phantom must not survive a yes-reflex, so
 * with `confirmName` set the Yes answer stays inert until the typed text
 * matches, and the `y` shortcut is suppressed — typing IS the answer here.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

import { Frame } from "../components/Frame.tsx";
import { Selectable } from "../components/Selectable.tsx";
import { badge, theme } from "../theme.ts";
import type { Consequence } from "../actions.ts";

export interface ConfirmRequest {
  title: string;
  consequence: Consequence;
  danger?: boolean;
  /** When set, "Yes" requires typing exactly this string. */
  confirmName?: string;
}

const CHOICES = [
  { value: true, label: "Yes, apply it" },
  { value: false, label: "No, leave it as it is" },
] as const;

export function ConfirmScreen(props: {
  request: ConfirmRequest;
  onAnswer: (yes: boolean) => void;
}): React.ReactElement {
  const { title, consequence, danger, confirmName } = props.request;
  // `danger` starts on "No": the reflex Enter must decline, not hand over the box.
  const [index, setIndex] = useState(danger ? 1 : 0);
  const [typed, setTyped] = useState("");
  // The gate is exact — a typo is not consent. Case-sensitive on purpose: a
  // persona name is a directory name, and a directory name is exact.
  const confirmed = confirmName === undefined || typed === confirmName;

  useInput((char, key) => {
    // esc is the same answer as "No" — but it is spelled the way every other
    // screen spells "take me back", so leaving is never a guess.
    if (key.escape) return props.onAnswer(false);
    if (key.upArrow || key.leftArrow) return setIndex(0);
    if (key.downArrow || key.rightArrow) return setIndex(1);
    // With a typed-name gate, printable keys go INTO the name — `y` can no
    // longer shortcut, or a persona called "yes" could be accepted by accident.
    if (confirmName !== undefined) {
      if (key.delete || char === "\u0008" || char === "\u007f") {
        setTyped((t) => t.slice(0, -1));
        return;
      }
      if (
        char &&
        char.length === 1 &&
        char >= " " &&
        !key.ctrl &&
        !key.meta &&
        !key.return
      ) {
        setTyped((t) => (t + char).slice(0, 64));
        return;
      }
    }
    // `y`/`n` answer outright: this is a yes/no question, and someone who
    // knows the answer should not have to move a cursor to give it.
    if (confirmName === undefined && (char === "y" || char === "Y"))
      return props.onAnswer(true);
    if (char === "n" || char === "N") return props.onAnswer(false);
    if (key.return) {
      // Yes with an unmet name gate is inert: the cursor sits on No anyway,
      // so only a deliberate selection plus a correct name gets through.
      if (CHOICES[index]!.value && !confirmed) return;
      return props.onAnswer(CHOICES[index]!.value);
    }
  });

  const notes = [
    consequence.restarts ? "The service restarts as part of this." : undefined,
    consequence.longRunning
      ? "This takes a while; progress is shown as it runs."
      : undefined,
  ].filter(Boolean) as string[];

  return (
    <Frame
      title={["confirm"]}
      status={danger ? "irreversible" : undefined}
      footer={[
        { icon: badge.select, key: "↑↓", label: "Select" },
        { icon: badge.continue, key: "↵", label: "Continue" },
        { icon: badge.back, key: "esc", label: "Back" },
      ]}
    >
      <Box>
        <Text bold color={danger ? theme.warn : undefined}>
          {title}
        </Text>
      </Box>
      {consequence.summary ? (
        <Box marginTop={1}>
          <Text color={theme.accent}>{consequence.summary}</Text>
        </Box>
      ) : null}
      {consequence.detail ? (
        <Box marginTop={1}>
          <Text color={theme.dim}>{consequence.detail}</Text>
        </Box>
      ) : null}
      {notes.map((note) => (
        <Box key={note}>
          <Text color={theme.dim}>{note}</Text>
        </Box>
      ))}
      {confirmName !== undefined ? (
        <Box marginTop={1}>
          <Text>
            <Text color={theme.warn}>type </Text>
            <Text bold color={theme.warn}>
              {confirmName}
            </Text>
            <Text color={theme.warn}> to confirm: </Text>
            <Text bold>{typed}</Text>
            <Text bold color={confirmed ? theme.ok : theme.accent}>
              ▌
            </Text>
          </Text>
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {CHOICES.map((choice, i) => (
          <Selectable
            key={choice.label}
            selected={i === index}
            onPress={() => props.onAnswer(choice.value)}
          >
            <Box>
              <Box marginRight={1}>
                <Text
                  backgroundColor={i === index ? theme.accent : undefined}
                >
                  {" "}
                </Text>
              </Box>
              <Text bold={i === index} color={i === index ? theme.accent : undefined}>
                {choice.label}
              </Text>
            </Box>
          </Selectable>
        ))}
      </Box>
    </Frame>
  );
}
