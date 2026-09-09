/**
 * The three persona questions' guidance blocks, shared by the New Persona
 * create flow (CreatePersona.tsx) and the first-run wizard (Wizard.tsx).
 *
 * One source of truth so both flows look and read identically: body prose in
 * the foreground colour, examples inside a rounded quote-box, secondary
 * rules/footnotes dim. Italics mark text the user will *write*; bold marks
 * the persona's name wherever it appears composed into a sentence.
 */

import React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme.ts";

/** A rounded quote-box — the app's standard example/preview block. */
export function ExampleBox(props: {
  /** Caption on the box's first line, e.g. "✦ Examples" */
  label?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={2}
      paddingY={0}
      flexDirection="column"
      marginTop={1}
      marginBottom={1}
      alignSelf="flex-start"
    >
      {props.label ? (
        <Box marginBottom={0}>
          <Text color={theme.accent} bold>
            {props.label}
          </Text>
        </Box>
      ) : null}
      {props.children}
    </Box>
  );
}

const NAME_EXAMPLES = [
  { name: "lena", role: "operations" },
  { name: "study-buddy", role: "learning" },
  { name: "ops-bot", role: "sysadmin" },
];

const IDENTITY_EXAMPLES = [
  "a senior software engineer who cares about correctness and testing",
  "a patient tutor who explains complex technical concepts simply",
  "a concise editor who eliminates ambiguity and wasted words",
];

export function nameDescription(): React.ReactElement {
  return (
    <>
      <Text>
        This is the name your phantom will be called — in chat conversations,
        in the phantoms list, and on disk. Choose something memorable and easy to type.
      </Text>
      <ExampleBox label="✦ Examples">
        <Text>
          <Text bold color={theme.accent}>
            lena
          </Text>
          <Text color={theme.dim}> · </Text>
          <Text bold color={theme.accent}>
            study-buddy
          </Text>
          <Text color={theme.dim}> · </Text>
          <Text bold color={theme.accent}>
            ops-bot
          </Text>
        </Text>
      </ExampleBox>
      {/* The format line lives in the AskScreen hint slot — which renders just
          above the input and doubles as the validation-error line — so it
          appears exactly once, next to where it matters. */}
    </>
  );
}

export function identityDescription(name: string): React.ReactElement {
  return (
    <>
      <Text>
        The defining core sentence that shapes who this phantom is. It opens every
        conversation as{" "}
        <Text bold color={theme.accent}>
          "You are {name || "…"}, ___"
        </Text>{" "}
        and guides how it thinks, writes, and solves problems.
      </Text>
      <ExampleBox label="✦ Examples">
        {IDENTITY_EXAMPLES.map((example) => (
          <Box key={example}>
            <Text color={theme.accent}>▸ </Text>
            <Text italic>{example}</Text>
          </Box>
        ))}
      </ExampleBox>
      <Text color={theme.dim}>
        Leave the default, or edit it to fit. You can change this anytime in Configure.
      </Text>
    </>
  );
}

export function toneDescription(name: string, identity: string): React.ReactElement {
  return (
    <>
      <Text>
        You are configuring <Text bold color={theme.accent}>{name}</Text> (
        <Text italic>{identity}</Text>). How should <Text bold color={theme.accent}>{name}</Text> write and speak?
      </Text>
      <Text color={theme.dim}>You can change the communication tone anytime in Configure.</Text>
    </>
  );
}

export function skillsDescription(name: string): React.ReactElement {
  return (
    <>
      <Text>
        What should <Text bold color={theme.accent}>{name}</Text> be good at?
        These seed the expertise section in IDENTITY.md — the grounding your
        phantom draws upon when answering.
      </Text>
      <Text color={theme.dim}>
        Optional — press space to toggle, ↵ to confirm. Editable anytime in IDENTITY.md.
      </Text>
    </>
  );
}

export function ownerDescription(name: string): React.ReactElement {
  return (
    <>
      <Text>
        What should <Text bold color={theme.accent}>{name}</Text> call you?
        This defines who the phantom serves — it greets you by name, and knows who
        it takes direction from.
      </Text>
      <ExampleBox label="✦ Examples">
        <Box>
          <Text color={theme.accent}>▸ </Text>
          <Text italic>Andrew</Text>
        </Box>
        <Box>
          <Text color={theme.accent}>▸ </Text>
          <Text italic>Kate</Text>
        </Box>
      </ExampleBox>
      <Text color={theme.dim}>
        Optional — leave blank to skip. Editable anytime in IDENTITY.md.
      </Text>
    </>
  );
}
