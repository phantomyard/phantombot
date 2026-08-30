/**
 * Screen 3 — the SETTINGS screen for one phantom, reached with `^s` from chat.
 *
 * One invisible, squared table — three aligned columns on every row:
 *
 *   name        one-liner on what the setting is for            state badge
 *
 * The first cut hung detail lines under each row and showed WHERE every value
 * came from (`env > config.toml > state.json`); that read like diagnostics,
 * not settings, and it made the screen a wall of dim text. Now the middle
 * column is literally what `/status` prints — the SAME probe results the
 * slash command produces, gathered through `gatherStatus`, so the TUI and
 * /status can never disagree — and where a value came from is Doctor's job,
 * not the settings list's.
 *
 * The badge column speaks three states: red `required` (missing but
 * mandatory), yellow `optional` (not configured but nothing is wrong), green
 * `✓ …` (configured and healthy).
 *
 * The table is framed in the Dashboard's exact design language — a `Rule`
 * above and below a dim header row (`setting · configured · state`) and a
 * third rule under the rows — and the Doctor menu row is gone: the bottom
 * telemetry block carries the persona's full /status reading, the way the
 * Dashboard renders HOST.
 *
 * Scoped to ONE persona on purpose. `^s` from a conversation means "the
 * settings of the phantom I am talking to" — it does not mean a host-wide list,
 * which is what `^p` is for.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

import { Frame, Rule } from "../components/Frame.tsx";
import { MenuItem } from "../components/Menu.tsx";
import { badge, glyph, theme } from "../theme.ts";
import { scrollWindow } from "../scroll.ts";
import { useTerminalSize, viewportRows } from "../terminal.ts";
import { frameChromeColumns, frameChromeRows } from "../chrome.ts";
import type { PersonaSnapshot } from "../snapshot.ts";
import type { StatusRows } from "../status.ts";

/** Fixed geometry of a settings row, in terminal columns. */
const BAR_COLS = 4; // TWO selection bars: Selectable's outer glyph cell and
// MenuItem's inner bar cell, each 1 char + 1 margin. The second one is easy
// to miss and exactly the two columns by which every wrap estimate drifted.
const ICON_COLS = 2; // icon + its margin
const LABEL_COLS = 16; // the name column, as in MenuItem
const BADGE_COLS = 14; // marginLeft + the fixed badge column

/** Terminal columns left for the description cell on one line. */
function descriptionWidth(columns: number): number {
  return Math.max(20, columns - BAR_COLS - ICON_COLS - LABEL_COLS - BADGE_COLS);
}

/**
 * How many rows a description occupies, given the live BODY width — terminal
 * columns minus what the frame consumes (`frameChromeColumns`), which the
 * caller subtracts before calling. A greedy word-wrap count, not a character
 * division: Ink wraps on WORD boundaries, so `ceil(len / width)` undershoots
 * whenever words do not pack evenly — and an undershoot means the scroll
 * window reserves too little and the next row paints on top of this one's
 * tail (the original shearing bug, seen again live at 60 columns before this
 * counter replaced the division). Long words with no break point are
 * hard-split, same as Ink does.
 */
function descriptionLines(desc: string, columns: number): number {
  const width = descriptionWidth(columns);
  let lines = 1;
  let col = 0;
  for (const word of desc.split(/\s+/).filter(Boolean)) {
    let piece = word;
    while (piece.length > width) {
      if (col > 0) {
        lines += 1;
        col = 0;
      }
      lines += 1;
      piece = piece.slice(width);
    }
    if (col === 0) col = piece.length;
    else if (col + 1 + piece.length <= width) col += 1 + piece.length;
    else {
      lines += 1;
      col = piece.length;
    }
  }
  return lines;
}

/** Screens this one leads to. */
export type Target = "memory" | "voice";

/**
 * Everything the cursor can land on, in screen order.
 *
 * One flat list rather than a section-per-list, because a settings screen with
 * several independently-focusable panes needs a focus model, and a focus model
 * is the thing users get lost in. Up and down walk the whole screen.
 */
export type Row =
  | "identity"
  | "brain"
  | "channels"
  | "memory"
  | "voice"
  | "autostart"
  | "default"
  | "release";

const ROWS: Row[] = [
  "identity",
  "brain",
  "channels",
  "memory",
  "voice",
  "autostart",
  "default",
  "release",
];

export function PersonaDetailScreen(props: {
  persona: PersonaSnapshot;
  /**
   * The live `/status` reading for this persona, as the Doctor screen's
   * status block shows it. Descriptions quote it verbatim; while it is
   * still gathering (the probes hit the network, 5s deadline) the cells
   * read `…` and fill in when it lands.
   */
  status?: StatusRows;
  onOpen: (target: Target) => void;
  onEditIdentity: () => void;
  onChangeBrain: () => void;
  onChangeChannels: () => void;
  onToggleAutostart: () => void;
  onMakeDefault: () => void;
  /** The host's current release ring — shown on the Release Channel row. */
  releaseChannel: string;
  onToggleRelease: () => void;
  /** False on a single-phantom host: the default row is informational there. */
  canSetDefault: boolean;
  /** False when running as a persona agent: the release ring is host-only. */
  canSetRelease: boolean;
  onBack: () => void;
}): React.ReactElement {
  const [cursor, setCursor] = useState(0);
  const p = props.persona;
  const row = ROWS[cursor]!;

  const press = (id: Row) => {
    if (id === "identity") return props.onEditIdentity();
    if (id === "brain") return props.onChangeBrain();
    if (id === "channels") return props.onChangeChannels();
    if (id === "autostart") return props.onToggleAutostart();
    if (id === "default") {
      if (props.canSetDefault) return props.onMakeDefault();
      return; // greyed out — a lone phantom IS the default, nothing to do
    }
    if (id === "release") {
      if (props.canSetRelease) return props.onToggleRelease();
      return; // greyed out — a persona agent may not move the host's ring
    }
    return props.onOpen(id);
  };

  useInput((_char, key) => {
    if (key.escape || key.leftArrow) return props.onBack();
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(ROWS.length - 1, c + 1));
    else if (key.return) press(row);
  });

  // The live /status reading, as a key→value lookup. `undefined` status means
  // "still gathering" (the probes reach the network, 5s deadline) — cells read
  // `…` until it lands. A gathered map MISSING a key means /status omitted the
  // line, which by /status's own rule means "not configured", never "broken".
  const status = props.status === undefined ? undefined : new Map(props.status);
  const line = (key: string): string | undefined => status?.get(key);

  // Probe lines carry their own verdict words ("gemini embeddings OK",
  // "telegram ERR (401 Unauthorized)"). The badge reads those words rather
  // than re-probing anything — one reader, no second opinion to drift.
  const probeBadge = (
    value: string | undefined,
    okLabel: string,
  ): { badge: string; badgeColor: string } => {
    if (status === undefined) return { badge: "…", badgeColor: theme.dim };
    // /status prints "none" for a voice provider explicitly set to none —
    // same "not set up" meaning as an omitted line, so same yellow badge.
    if (value === undefined || value === "none")
      return { badge: "optional", badgeColor: theme.warn };
    if (value.includes("no key"))
      return { badge: `${glyph.warn} no key`, badgeColor: theme.warn };
    if (value.includes("ERR"))
      return { badge: `${glyph.bad} error`, badgeColor: theme.bad };
    if (value.includes("WARN"))
      return { badge: `${glyph.warn} warning`, badgeColor: theme.warn };
    return { badge: `${glyph.ok} ${okLabel}`, badgeColor: theme.ok };
  };

  // Only SOUL.md / IDENTITY.md are load-bearing (loader.ts: at least one must
  // exist, else PersonaNotFoundError). AGENTS.md is an optional tools-hints
  // file (first match wins vs tools.md) — its absence must not trip the badge.
  const identityMissing = p.identity.files.some(
    (f) => !f.present && (f.name === "SOUL.md" || f.name === "IDENTITY.md"),
  );

  // The badge reads the same /status lines the STATUS block prints — one
  // reader, no second opinion to drift — while the DESCRIPTION column is a
  // static one-liner on what the setting is for, not live probe output.
  const channelParts = [line("telegram"), line("acp")].filter(
    (s): s is string => Boolean(s),
  );

  // Chrome around the scrolling region: border (2), title (1), title gap (1),
  // the two "more" markers (2), footer (1), the framed header (three rules +
  // the header row = 4), the rule under the rows (1), and the STATUS telemetry
  // block (margin 1 + heading 1 + one line per /status row + the blank row
  // under it = N + 3). A constant, like the chat screen's: measuring would
  // mean reading the layout back out of Yoga mid-render, and one row
  // conservative costs a blank line while one row optimistic tears the frame.
  // While /status is still gathering the block is one line ("gathering…").
  const statusLines = props.status?.length ?? 1;
  const size = useTerminalSize();
  const budget = viewportRows(size, 12 + statusLines + frameChromeRows());

  // Row height follows the live window width: a wrapped description is a
  // two-row cell, and the scroll window must reserve what the paint will
  // actually use or rows collide (the original shearing regression).
  const bodyColumns = size.columns - frameChromeColumns();
  const h = (desc: string) => descriptionLines(desc, bodyColumns);

  // One squared table geometry for every row: wrapping description cell,
  // fixed right-aligned badge column, no per-row hint (the footer owns ↵ —
  // a reversed hint after the badge would shove the selected row's badge
  // out of column and break the table).
  const tableProps = { wrap: true, badgeWidth: 13 } as const;

  const mainBlocks: Array<{ id: Row; height: number; node: React.ReactNode }> = [
    {
      id: "identity",
      height: h("the persona files that define who this phantom is"),
      node: (
        <MenuItem
          icon="◐"
          label="Identity"
          description="the persona files that define who this phantom is"
          badge={identityMissing ? "required" : `${glyph.ok} configured`}
          badgeColor={identityMissing ? theme.bad : theme.ok}
          selected={row === "identity"}
          onPress={() => press("identity")}
          {...tableProps}
        />
      ),
    },
    {
      id: "brain",
      height: h("which model and harness power this phantom"),
      node: (
        <MenuItem
          icon="◉"
          label="Brain"
          description="which model and harness power this phantom"
          badge={
            status === undefined
              ? "…"
              : p.resolvedHarness
                ? `${glyph.ok} configured`
                : "required"
          }
          badgeColor={
            status === undefined ? theme.dim : p.resolvedHarness ? theme.ok : theme.bad
          }
          selected={row === "brain"}
          onPress={() => press("brain")}
          {...tableProps}
        />
      ),
    },
    {
      id: "channels",
      height: h("the chat surfaces this phantom answers on"),
      node: (
        <MenuItem
          icon="◎"
          label="Chat Channels"
          description="the chat surfaces this phantom answers on"
          // Same source as the description (the /status lines), so the badge
          // and the text can never disagree — p.channels is a different
          // reader and testbot proved they drift (green badge over "none
          // configured").
          badge={
            status === undefined
              ? "…"
              : channelParts.some((s) => s.includes("ERR"))
                ? `${glyph.bad} error`
                : channelParts.length > 0
                  ? `${glyph.ok} configured`
                  : "optional"
          }
          badgeColor={
            status === undefined
              ? theme.dim
              : channelParts.some((s) => s.includes("ERR"))
                ? theme.bad
                : channelParts.length > 0
                  ? theme.ok
                  : theme.warn
          }
          selected={row === "channels"}
          onPress={() => press("channels")}
          {...tableProps}
        />
      ),
    },
    {
      id: "memory",
      height: h("the long-term memory database"),
      node: (
        <MenuItem
          icon="◆"
          label="Memory"
          description="the long-term memory database"
          {...probeBadge(line("memory"), "healthy")}
          selected={row === "memory"}
          onPress={() => press("memory")}
          {...tableProps}
        />
      ),
    },
    {
      id: "voice",
      height: h("spoken replies, text-to-speech"),
      node: (
        <MenuItem
          icon="◈"
          label="Voice"
          description="spoken replies, text-to-speech"
          {...probeBadge(line("voice"), "configured")}
          selected={row === "voice"}
          onPress={() => press("voice")}
          {...tableProps}
        />
      ),
    },
  ];

  // The informational group — toggles, not health checks. They carry the
  // VALUE where the badges sit (on|off, yes|no, stable|preview, dim, no
  // glyph, no colour) and sit under their own rule, separated from the
  // required/optional rows above.
  const infoBlocks: Array<{
    id: Row;
    height: number;
    node: React.ReactNode;
  }> = [
    {
      id: "autostart",
      height: 1,
      node: (
        <MenuItem
          icon="⏻"
          label="Autostart"
          description="start this phantom with the daemon"
          badge={p.autostart ? "on" : "off"}
          selected={row === "autostart"}
          onPress={() => press("autostart")}
          {...tableProps}
        />
      ),
    },
    {
      id: "default",
      height: 1,
      node: (
        <MenuItem
          icon="★"
          label="Default"
          description={
            props.canSetDefault
              ? "the host default; owns /update and /restart"
              : "the only phantom on this host, so it is the default"
          }
          badge={p.isDefault ? "yes" : "no"}
          badgeColor={props.canSetDefault ? undefined : theme.dim}
          selected={row === "default"}
          onPress={() => press("default")}
          {...tableProps}
        />
      ),
    },
    {
      id: "release",
      height: 1,
      node: (
        <MenuItem
          icon="⇅"
          label="Release Channel"
          description={
            props.canSetRelease
              ? "update ring this HOST follows; stable lags, preview tracks main"
              : "host-only setting; run the TUI as the host operator to change it"
          }
          badge={props.releaseChannel}
          badgeColor={props.canSetRelease ? undefined : theme.dim}
          selected={row === "release"}
          onPress={() => press("release")}
          {...tableProps}
        />
      ),
    },
  ];

  // Both groups render through one scroll window; the rule between them is a
  // fixed one-row separator. The cursor indexes ROWS, which skips the
  // separator — shift anything at or past autostart down by one so the
  // window always reveals the row the cursor is actually on.
  const blocks = [
    ...mainBlocks,
    { id: "sep" as const, height: 1, node: <Rule /> },
    ...infoBlocks,
  ];
  const cursorBlock =
    cursor >= ROWS.indexOf("autostart") ? cursor + 1 : cursor;

  const view = scrollWindow(
    blocks.map((b) => b.height),
    budget,
    cursorBlock,
  );

  return (
    <Frame
      title={["phantombot", p.name]}
      status={
        p.completeness.complete
          ? `${glyph.up} ready`
          : `${glyph.warn} setup unfinished`
      }
      footer={[
        { icon: badge.move, key: "↑↓", label: "Move" },
        { icon: badge.edit, key: "↵", label: "Edit" },
        { icon: badge.back, key: "esc", label: "Back" },
      ]}
    >
      {/* The framed header — the phantoms table's exact skeleton: a rule, a
          dim lowercase header row sitting over the columns, a rule. The
          lead-in matches a row's gutters (Selectable's pointer + MenuItem's
          bar + the icon cell) so the labels sit over their columns. */}
      <Rule />
      <Box>
        <Box width={6}>
          <Text> </Text>
        </Box>
        <Box width={16} flexShrink={0}>
          <Text color={theme.dim}>setting</Text>
        </Box>
        <Box flexGrow={1} flexBasis={0}>
          <Text color={theme.dim}>description</Text>
        </Box>
        <Box marginLeft={1} flexShrink={0} width={13} justifyContent="flex-end">
          <Text color={theme.dim}>state</Text>
        </Box>
      </Box>
      <Rule />
      <Text color={theme.dim}>
        {view.above > 0 ? `▲ ${view.above} more above` : " "}
      </Text>
      {blocks.slice(view.start, view.end).map((block) => (
        <Box key={block.id} flexDirection="column">
          {block.node}
        </Box>
      ))}
      <Box flexGrow={1} />
      <Text color={theme.dim}>
        {view.below > 0 ? `▼ ${view.below} more below` : " "}
      </Text>
      <Rule />
      <StatusBlock status={props.status} />
      {/* One blank row between the STATUS telemetry and the footer — the same
          breathing room the footer gets on every other screen. */}
      <Box height={1} />
    </Frame>
  );
}

/** One telemetry line, in the Dashboard's HOST-block style: mark, label, dim
 * detail — fixed columns, truncated detail, never a wrapped telemetry line. */
function StatusLine(props: {
  label: string;
  detail?: string;
}): React.ReactElement {
  return (
    <Box>
      <Box width={2} flexShrink={0}>
        <Text color={theme.ok}>{glyph.ok}</Text>
      </Box>
      <Box width={14} flexShrink={0}>
        <Text>{props.label}</Text>
      </Box>
      <Box flexGrow={1} flexBasis={0}>
        <Text color={theme.dim} wrap="truncate">
          {props.detail ?? ""}
        </Text>
      </Box>
    </Box>
  );
}

/** The full telemetry, where the Dashboard puts HOST: the persona's complete
 * /status reading — heading, label/value dim pairs under the bottom rule.
 * Status is already gathered for the table's badges. */
function StatusBlock(props: {
  status?: StatusRows;
}): React.ReactElement {
  return (
    <Box marginTop={1} flexDirection="column">
      <Box>
        <Text color={theme.accent} bold>
          STATUS
        </Text>
      </Box>
      {!props.status ? (
        <Text color={theme.dim}>gathering…</Text>
      ) : (
        props.status.map(([label, detail]) => (
          <StatusLine key={label} label={label} detail={detail} />
        ))
      )}
    </Box>
  );
}

