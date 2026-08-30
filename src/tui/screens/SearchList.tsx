/**
 * The searchable list-picker screen.
 *
 * Pi's provider catalogue is long and OpenRouter's model list is longer — a
 * plain Choose screen over hundreds of rows both lags the renderer and buries
 * the row the user wants. This screen puts a search box on top, filters as you
 * type, and renders at most a 50-row window around the cursor, so a thousand
 * options cost the same as fifty.
 *
 * Typing IS the search: there is no separate focus state to manage. Pasting a
 * long model id lands as one chunk and filters in one go (chunk semantics, not
 * per-character). When the query matches nothing, the list degrades to a
 * free-text row — the degenerate case the CLI's pickers fell back to — so a
 * model id can still be entered by hand when `pi --list-models` came back
 * empty.
 *
 * `esc` resolves `undefined`, like every picker in this app: cancelling never
 * falls through to whatever the cursor was sitting on.
 */

import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";

import { Frame } from "../components/Frame.tsx";
import { Selectable } from "../components/Selectable.tsx";
import { badge, theme } from "../theme.ts";
import type { ChooseOption } from "./Choose.tsx";

export interface SearchListRequest {
  title: string;
  /**
   * What the current list is FOR — "Selecting the VISION model". Always
   * visible, so a three-slot flow can never leave the user guessing which
   * question they are on.
   */
  banner?: string;
  options: readonly ChooseOption[];
  /** Value the cursor starts on — the setting's current value, when there is one. */
  initial?: string;
}

/** How many rows may render at once. A window, not a virtual list: the rows
    above and below the cursor stay on screen, scrolling shifts the window. */
const WINDOW = 50;

export function SearchListScreen(props: {
  request: SearchListRequest;
  onAnswer: (value: string | undefined) => void;
}): React.ReactElement {
  const { title, banner, options, initial } = props.request;
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);

  // All-matching-words substring filter, case-insensitive, over label + value
  // + hint. Words rather than the whole query, so "openrouter claude" finds
  // `openrouter/~anthropic/claude-...` without needing exact adjacency.
  const filtered = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return options;
    return options.filter((o) => {
      const hay = `${o.label} ${o.value} ${o.hint ?? ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [options, query]);

  // The cursor tracks the FILTERED list; a shrinking list clamps it.
  const at = Math.min(index, Math.max(0, filtered.length - 1));
  const lo = Math.max(0, Math.min(at - Math.floor(WINDOW / 2), filtered.length - WINDOW));
  const rows = filtered.slice(Math.max(0, lo), Math.max(0, lo) + WINDOW);
  // Nothing matches AND the user has typed something: offer the query itself
  // as the answer — the free-text fallback the CLI pickers had.
  const freeText = query.trim().length > 0 && filtered.length === 0;

  useInput((chunk, key) => {
    if (key.escape) return props.onAnswer(undefined);
    if (key.upArrow) return setIndex(Math.max(0, at - 1));
    if (key.downArrow)
      return setIndex(Math.min(filtered.length - 1, at + 1));
    if (key.backspace || key.delete)
      return setQuery((q) => q.slice(0, -1));
    if (key.return) {
      if (freeText) return props.onAnswer(query.trim());
      const picked = filtered[at];
      if (picked) props.onAnswer(picked.value);
      return;
    }
    // Any other printable chunk — a letter, or a whole pasted model id — is
    // search text. A newline inside a chunk is whitespace here, not a submit:
    // this box filters, it does not answer.
    if (chunk && !key.ctrl && !key.meta) {
      const text = chunk.replace(/\r\n|\r|\n/g, " ");
      if (text) {
        setQuery((q) => q + text);
        setIndex(0);
      }
    }
  });

  return (
    <Frame
      title={["configure", "search"]}
      status={`${filtered.length}/${options.length}`}
      footer={[
        { icon: badge.select, key: "type", label: "Search" },
        { icon: badge.select, key: "↑↓", label: "Select" },
        { icon: badge.continue, key: "↵", label: "Continue" },
        { icon: badge.back, key: "esc", label: "Back" },
      ]}
    >
      <Box>
        <Text bold>{title}</Text>
      </Box>
      {banner ? (
        <Box>
          <Text color={theme.accent}>{banner}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={theme.dim}>Search: </Text>
        <Text bold>{query}</Text>
        <Text color={theme.dim}>▊</Text>
      </Box>
      <Box flexDirection="column" marginTop={1} overflow="hidden">
        {freeText ? (
          <Selectable selected onPress={() => props.onAnswer(query.trim())}>
            <Text>
              use "{query.trim()}" as typed — no list entry matches
            </Text>
          </Selectable>
        ) : (
          rows.map((option, i) => {
            const selected = Math.max(0, lo) + i === at;
            return (
              <Selectable
                key={`${option.value}-${Math.max(0, lo) + i}`}
                selected={selected}
                onPress={() => props.onAnswer(option.value)}
              >
                <Box>
                  <Text
                    bold={selected}
                    color={selected ? theme.accent : undefined}
                  >
                    {option.label}
                  </Text>
                  {option.value === initial ? (
                    <Text color={theme.dim}> ·current</Text>
                  ) : null}
                  {option.hint ? (
                    <Box marginLeft={1}>
                      <Text color={theme.dim}>{option.hint}</Text>
                    </Box>
                  ) : null}
                </Box>
              </Selectable>
            );
          })
        )}
      </Box>
    </Frame>
  );
}
