/**
 * The single-value input screen.
 *
 * The last typed answer in the app — setting a credential — still dropped out
 * to a `@clack` panel: renderer suspended, alternate screen left, question
 * drawn on the user's normal terminal with no header, no footer and no `esc`.
 * That is the break in the design language the confirm screen already closed
 * for yes/no questions, so a typed value closes it the same way: a SCREEN,
 * with the app's own chrome and the app's own keys.
 *
 * `masked` is for credentials. The value is never rendered back — only its
 * length, as dots — because a settings screen that echoes a secret puts it in
 * the scrollback the user reached for the vault to avoid.
 *
 * Cancel is a first-class answer, exactly as it was under clack: `esc`
 * resolves `undefined`, NEVER the empty string. `""` would be written to the
 * vault and erase a credential the user only meant to look at.
 */

import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";

import { Frame } from "../components/Frame.tsx";
import { badge, theme } from "../theme.ts";
import { applyTextChunk } from "../textInput.ts";

export interface AskRequest {
  title: string;
  hint?: string;
  masked?: boolean;
  initial?: string;
  /**
   * When true, an empty box IS an answer — it resolves `""`.
   *
   * The harness flow needs this: "blank = keep the current key" and "blank =
   * no model override" are real answers there, and refusing them would leave
   * the user with no way past the question except typing something they do not
   * mean. Off by default, because for a credential `""` erases what it names.
   */
  allowEmpty?: boolean;
}

export function AskScreen(props: {
  request: AskRequest;
  onAnswer: (value: string | undefined) => void;
}): React.ReactElement {
  const { title, hint, masked, initial, allowEmpty } = props.request;
  const [value, setValue] = useState(initial ?? "");
  // Written synchronously on every keystroke: several chunks can arrive before
  // React re-renders, and a closure-read `value` is one render stale — the
  // same bug that once named a persona after only its last few letters.
  const ref = useRef(value);

  const submit = (text: string) => {
    const trimmed = text.trim();
    // An empty box is not an answer — unless the caller said it is. Treating
    // it as one by default would clear the very setting the user opened this
    // screen to fill in.
    if (!trimmed && !allowEmpty) return;
    props.onAnswer(trimmed);
  };

  useInput((char, key) => {
    if (key.escape) return props.onAnswer(undefined);
    if (key.return) return submit(ref.current);
    if (key.backspace || key.delete) {
      ref.current = ref.current.slice(0, -1);
      setValue(ref.current);
      return;
    }
    if (char && !key.ctrl && !key.meta) {
      const applied = applyTextChunk(ref.current, char);
      ref.current = applied.submit ?? applied.text;
      setValue(ref.current);
      if (applied.submit) submit(applied.submit);
    }
  });

  const shown = masked ? "•".repeat(value.length) : value;

  return (
    <Frame
      title={["configure", masked ? "secret" : "value"]}
      footer={[
        { icon: badge.save, key: "↵", label: "Save" },
        { icon: badge.back, key: "esc", label: "Back" },
      ]}
    >
      {hint ? (
        <Box>
          <Text color={theme.dim}>{hint}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text bold>{title}</Text>
      </Box>
      <Box>
        <Text color={theme.accent}>{"› "}</Text>
        <Text>{shown}</Text>
        <Text color={theme.accent}>▌</Text>
      </Box>
    </Frame>
  );
}
