/**
 * Screen 3 — the SETTINGS screen for one phantom, reached with `^s` from chat.
 *
 * One invisible, squared table — three aligned columns on every row:
 *
 *   name        what is configured (live /status readings)     state badge
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
 * third rule under the rows — and the Doctor menu row is gone: its checks
 * render as a DOCTOR telemetry block under the bottom rule, the same way the
 * Dashboard renders HOST. The checks run when the screen opens and `a`
 * re-runs them; `d` still opens the full Doctor screen for the whole report.
 *
 * Scoped to ONE persona on purpose. `^s` from a conversation means "the
 * settings of the phantom I am talking to" — it does not mean a host-wide list,
 * which is what `^p` is for.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

import { Frame, Rule } from "../components/Frame.tsx";
import { MenuItem } from "../components/Menu.tsx";
import { badge, glyph, humanBytes, theme } from "../theme.ts";
import { scrollWindow } from "../scroll.ts";
import { useTerminalSize, viewportRows } from "../terminal.ts";
import { frameChromeColumns, frameChromeRows } from "../chrome.ts";
import type { PersonaSnapshot } from "../snapshot.ts";
import type { StatusRows } from "../status.ts";
import type { DoctorReport } from "../../cli/doctor.ts";

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
  | "default";

const ROWS: Row[] = [
  "identity",
  "brain",
  "channels",
  "memory",
  "voice",
  "autostart",
  "default",
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
  /**
   * The doctor's latest report, for the telemetry block under the table.
   * The App gathers it when the screen opens; `a` re-runs via
   * `onRunDoctor`, `d` opens the full Doctor screen via `onFullDoctor`.
   */
  doctor?: DoctorReport;
  doctorRunning?: boolean;
  onRunDoctor: () => void;
  onFullDoctor: () => void;
  onOpen: (target: Target) => void;
  onEditIdentity: () => void;
  onChangeBrain: () => void;
  onChangeChannels: () => void;
  onToggleAutostart: () => void;
  onMakeDefault: () => void;
  onBack: () => void;
  onLogs: () => void;
}): React.ReactElement {
  const [cursor, setCursor] = useState(0);
  const p = props.persona;
  const row = ROWS[cursor]!;

  const press = (id: Row) => {
    if (id === "identity") return props.onEditIdentity();
    if (id === "brain") return props.onChangeBrain();
    if (id === "channels") return props.onChangeChannels();
    if (id === "autostart") return props.onToggleAutostart();
    if (id === "default") return props.onMakeDefault();
    return props.onOpen(id);
  };

  useInput((char, key) => {
    if (key.escape || key.leftArrow) return props.onBack();
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(ROWS.length - 1, c + 1));
    else if (key.return) press(row);
    else if (char === "a") props.onRunDoctor();
    else if (char === "d") props.onFullDoctor();
    else if (char === "L") props.onLogs();
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

  const identityMarks = p.identity.files
    .map((f) => `${f.name} ${f.present ? glyph.ok : glyph.bad}`)
    .join("   ");
  // Only SOUL.md / IDENTITY.md are load-bearing (loader.ts: at least one must
  // exist, else PersonaNotFoundError). AGENTS.md is an optional tools-hints
  // file (first match wins vs tools.md) — its absence must not trip the badge.
  const identityMissing = p.identity.files.some(
    (f) => !f.present && (f.name === "SOUL.md" || f.name === "IDENTITY.md"),
  );

  const chainLine = line("chain");
  const modelsLine = line("models");
  const brainDesc =
    status === undefined
      ? "…"
      : [chainLine, modelsLine ? `models: ${modelsLine}` : undefined]
          .filter((s): s is string => Boolean(s))
          .join(" · ") || "none configured";

  const channelParts = [line("telegram"), line("acp")].filter(
    (s): s is string => Boolean(s),
  );
  const channelsDesc =
    status === undefined
      ? "…"
      : channelParts.length > 0
        ? channelParts.join(" · ")
        : "none configured";

  // Chrome around the scrolling region: border (2), title (1), title gap (1),
  // the two "more" markers (2), footer (1), the framed header (three rules +
  // the header row = 4), and the DOCTOR telemetry block (margin 1 + heading 1
  // + up to four check lines = 6). A constant, like the chat screen's:
  // measuring would mean reading the layout back out of Yoga mid-render, and
  // one row conservative costs a blank line while one row optimistic tears the
  // frame.
  const size = useTerminalSize();
  const budget = viewportRows(size, 15 + frameChromeRows());

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

  const blocks: Array<{ id: Row; height: number; node: React.ReactNode }> = [
    {
      id: "identity",
      height: h(identityMarks),
      node: (
        <MenuItem
          icon="◐"
          label="Identity"
          description={identityMarks}
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
      height: h(brainDesc),
      node: (
        <MenuItem
          icon="◉"
          label="Brain"
          description={brainDesc}
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
      height: h(channelsDesc),
      node: (
        <MenuItem
          icon="◎"
          label="Chat Channels"
          description={channelsDesc}
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
      height: h(line("memory") ?? "…"),
      node: (
        <MenuItem
          icon="◆"
          label="Memory"
          description={status === undefined ? "…" : (line("memory") ?? "not configured")}
          {...probeBadge(line("memory"), "healthy")}
          selected={row === "memory"}
          onPress={() => press("memory")}
          {...tableProps}
        />
      ),
    },
    {
      id: "voice",
      height: h(line("voice") ?? "…"),
      node: (
        <MenuItem
          icon="◈"
          label="Voice"
          description={status === undefined ? "…" : (line("voice") ?? "not configured")}
          {...probeBadge(line("voice"), "configured")}
          selected={row === "voice"}
          onPress={() => press("voice")}
          {...tableProps}
        />
      ),
    },
    {
      id: "autostart",
      height: 1,
      node: (
        <MenuItem
          icon="⏻"
          label="Autostart"
          description="starts with the daemon"
          badge={
            p.autostart || p.isDefault ? `${glyph.ok} on` : "optional"
          }
          badgeColor={p.autostart || p.isDefault ? theme.ok : theme.warn}
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
            p.isDefault
              ? "owns /update and /restart"
              : "not the host default"
          }
          badge={p.isDefault ? `${glyph.ok} yes` : "optional"}
          badgeColor={p.isDefault ? theme.ok : theme.warn}
          selected={row === "default"}
          onPress={() => press("default")}
          {...tableProps}
        />
      ),
    },
  ];

  // `blocks` is in ROWS order, so the cursor indexes both.
  const view = scrollWindow(
    blocks.map((b) => b.height),
    budget,
    cursor,
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
        { icon: badge.run, key: "a", label: "Doctor" },
        { icon: badge.logs, key: "L", label: "Logs" },
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
          <Text color={theme.dim}>configured</Text>
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
      <DoctorBlock report={props.doctor} running={Boolean(props.doctorRunning)} />
    </Frame>
  );
}

/** One doctor check, in the Dashboard's HOST-block style: mark, label, dim
 * detail — fixed columns, truncated detail, never a wrapped telemetry line. */
function DoctorLine(props: {
  ok: boolean | "warn";
  label: string;
  detail?: string;
}): React.ReactElement {
  const colour =
    props.ok === true ? theme.ok : props.ok === "warn" ? theme.warn : theme.bad;
  const mark =
    props.ok === true ? glyph.ok : props.ok === "warn" ? glyph.warn : glyph.bad;
  return (
    <Box>
      <Box width={2} flexShrink={0}>
        <Text color={colour}>{mark}</Text>
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

/** The doctor as telemetry, where the Dashboard puts HOST: an accent heading
 * and label/value lines under the bottom rule. No menu row, no separate
 * screen for the at-a-glance state — the checks gather off the render path
 * when the screen opens (App) and `a` re-runs them. */
function DoctorBlock(props: {
  report?: DoctorReport;
  running: boolean;
}): React.ReactElement {
  const r = props.report;
  return (
    <Box marginTop={1} flexDirection="column">
      <Box>
        <Text color={theme.accent} bold>
          DOCTOR
        </Text>
        <Box flexGrow={1} />
        <Text color={theme.dim}>
          {props.running ? "running checks…" : "a run again"}
        </Text>
      </Box>
      {!r ? (
        <Text color={theme.dim}>
          {props.running ? "running checks..." : "no report yet — press a"}
        </Text>
      ) : (
        <>
          <DoctorLine
            ok={r.telegram.healthy}
            label="telegram"
            detail={`${r.telegram.listeners} listener(s)`}
          />
          <DoctorLine
            ok={r.memory_db.healthy}
            label="memory db"
            detail={humanBytes(r.memory_db.bytes)}
          />
          <DoctorLine
            ok={
              r.nightly.health === "ok"
                ? true
                : r.nightly.health === "error"
                  ? false
                  : "warn"
            }
            label="nightly"
            detail={r.nightly.detail}
          />
          {r.nightly.backlog > 0 ? (
            <DoctorLine
              ok="warn"
              label="backlog"
              detail={`${r.nightly.backlog} day(s) pending${r.nightly.oldest_pending ? `, oldest ${r.nightly.oldest_pending}` : ""}`}
            />
          ) : null}
        </>
      )}
    </Box>
  );
}
