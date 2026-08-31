/**
 * The re-embed job screen.
 *
 * This is the concrete form of the rule that a settings change is an ACTION:
 * changing the embedding space is too long to block on, so it runs as a VISIBLE
 * job with a progress bar the user can leave and come back to — never as a
 * printed instruction to run `phantombot memory index --reembed` later.
 *
 * The denominator MOVES. `runEmbedJob` chunks files lazily as it walks them, so
 * `total` is the number of chunks discovered so far, not a final figure. The
 * bar is drawn from that honestly rather than from a percentage that would have
 * to walk backwards.
 */

import React from "react";
import { Box, Text } from "ink";

import { Frame } from "../components/Frame.tsx";
import { badge, humanCount, humanDuration, theme } from "../theme.ts";

export interface ReembedState {
  done: number;
  total: number;
  path: string;
  startedAt: number;
  errors: number;
  finished?: boolean;
  error?: string;
}

/** A proportional bar, expressed in cells, drawn by the caller's width. */
export function barCells(
  done: number,
  total: number,
  cells: number,
): { filled: number; empty: number } {
  if (total <= 0) return { filled: 0, empty: cells };
  const filled = Math.max(0, Math.min(cells, Math.round((done / total) * cells)));
  return { filled, empty: cells - filled };
}

export function ReembedScreen(props: {
  space: string;
  state: ReembedState;
}): React.ReactElement {
  const { done, total, startedAt, errors } = props.state;
  const elapsed = Date.now() - startedAt;
  const rate = done > 0 ? elapsed / done : 0;
  const eta = rate > 0 && total > done ? (total - done) * rate : 0;
  // A fixed cell count for the bar is fine: it lives inside a flex box that
  // truncates, so it cannot shear the border the way a hand-drawn frame would.
  const { filled, empty } = barCells(done, total, 40);

  return (
    <Frame
      title={["re-embedding"]}
      status={props.space}
      footer={[
        { icon: badge.background, key: "b", label: "Run in background" },
        {
          icon: badge.cancel,
          key: "^c",
          label: "Cancel (keeps what's done)",
        },
      ]}
    >
      <Box>
        <Text color={theme.accent}>{"█".repeat(filled)}</Text>
        <Text color={theme.dim}>{"░".repeat(empty)}</Text>
        <Text>{`   ${humanCount(done)} / ${humanCount(total)}`}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dim}>
          {`elapsed ${humanDuration(elapsed)}${eta > 0 ? ` · eta ${humanDuration(eta)}` : ""} · ${errors} errors`}
        </Text>
      </Box>
      <Box>
        <Text color={theme.dim} wrap="truncate">
          {props.state.path}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dim}>
          Old vectors are kept until this finishes; recall stays on lexical in
          the meantime.
        </Text>
      </Box>
      {props.state.error ? (
        <Box marginTop={1}>
          <Text color={theme.bad}>{props.state.error}</Text>
        </Box>
      ) : null}
    </Frame>
  );
}
