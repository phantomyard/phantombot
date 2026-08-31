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
  /** Small dim italic caption on the box's first line, e.g. "e.g." */
  label?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box
      borderStyle="round"
      borderColor={theme.dim}
      paddingX={1}
      flexDirection="column"
      marginTop={1}
      marginBottom={1}
    >
      {props.label ? (
        <Text dimColor italic>
          {props.label}
        </Text>
      ) : null}
      {props.children}
    </Box>
  );
}

const NAME_EXAMPLES = "lena · study-buddy · ops-bot";

const IDENTITY_EXAMPLES = [
  "a senior engineer who cares about correctness",
  "a warm tutor who explains things simply",
  "a blunt editor who cuts every wasted word",
];

export function nameDescription(): React.ReactElement {
  return (
    <>
      <Text>
        This is the name your phantom will be called — in chat, in the
        phantoms list, and on disk. Pick something you'd be happy talking to.
      </Text>
      <ExampleBox label="e.g.">
        <Text bold color={theme.accent}>
          {NAME_EXAMPLES}
        </Text>
      </ExampleBox>
      <Text dimColor>lowercase letters, digits, "-" or "_"</Text>
    </>
  );
}

export function identityDescription(name: string): React.ReactElement {
  return (
    <>
      <Text>
        The one sentence that defines who this phantom is: it opens every
        conversation as{" "}
        <Text bold color={theme.accent}>
          "You are {name || "…"}, ___"
        </Text>{" "}
        and colours everything it says and does.
      </Text>
      <ExampleBox label="e.g.">
        {IDENTITY_EXAMPLES.map((example) => (
          <Text key={example} italic>
            {example}
          </Text>
        ))}
      </ExampleBox>
      <Text dimColor>Leave the default, or edit it to fit. Tweakable any time in Configure.</Text>
    </>
  );
}

export function toneDescription(name: string, identity: string): React.ReactElement {
  return (
    <>
      <Text>
        You are <Text bold color={theme.accent}>{name}</Text>,{" "}
        <Text italic>{identity}</Text>. How should {name} write and speak?
      </Text>
      <Text dimColor>Changeable later in Configure.</Text>
    </>
  );
}

export function skillsDescription(name: string): React.ReactElement {
  return (
    <>
      <Text>
        What should <Text bold color={theme.accent}>{name}</Text> be good at?
        These seed the identity file's expertise section — the grounding the
        phantom draws on when it answers. Pick what fits the role you have in
        mind; skip everything and the one-line identity carries the
        personality on its own.
      </Text>
      <Text dimColor>Optional — space to toggle, ↵ to confirm. Editable later in IDENTITY.md.</Text>
    </>
  );
}

export function ownerDescription(name: string): React.ReactElement {
  return (
    <>
      <Text>
        What should <Text bold color={theme.accent}>{name}</Text> call you?
        This is who the phantom serves — it greets you by name, and knows who
        it takes direction from.
      </Text>
      <ExampleBox label="e.g.">
        <Text italic>Andrew</Text>
        <Text italic>Kate</Text>
      </ExampleBox>
      <Text dimColor>Optional — leave blank to skip. Editable later in IDENTITY.md.</Text>
    </>
  );
}
