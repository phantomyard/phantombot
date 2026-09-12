/**
 * Screen 5 — doctor, inline rather than a wall of scrollback.
 *
 * Renders the report `runDoctor` already produces. It does not reimplement a
 * single check: the CLI and this screen must never be able to disagree about
 * the health of the same box.
 *
 * The checks themselves are built by `doctorChecklist` — a pure function of
 * the report, so what is on screen is testable without rendering anything.
 * This file owns only the paint: section headings, one line per check, the
 * hint line under the ones that are not green, and the scroll window.
 *
 * Before this, four of the report's checks were rendered and the rest were
 * dropped, so the screen could show all-green while doctor's own exit code
 * said the box was broken.
 */

import React from "react";
import { Box, Text, useInput } from "ink";

import { Frame, Rule } from "../components/Frame.tsx";
import { badge, glyph, theme } from "../theme.ts";
import type { DoctorReport } from "../../cli/doctor.ts";
import type { StatusRows } from "../status.ts";
import {
  checklistVerdict,
  doctorChecklist,
  type CheckState,
  type ChecklistItem,
} from "../doctorChecklist.ts";
import { useTerminalSize, viewportRows } from "../terminal.ts";
import { frameChromeRows } from "../chrome.ts";

const LABEL_COLS = 22;

function colourOf(state: CheckState): string {
  return state === "ok" ? theme.ok : state === "warn" ? theme.warn : theme.bad;
}

function markOf(state: CheckState): string {
  return state === "ok" ? glyph.ok : state === "warn" ? glyph.warn : glyph.bad;
}

/** One check: mark, label, detail. The hint, when there is one, is its own row. */
function Check(props: { item: ChecklistItem }): React.ReactElement {
  const { item } = props;
  return (
    <Box>
      <Box width={2} flexShrink={0}>
        <Text color={colourOf(item.state)}>{markOf(item.state)}</Text>
      </Box>
      <Box width={LABEL_COLS} flexShrink={0}>
        <Text wrap="truncate">{item.label}</Text>
      </Box>
      <Box flexGrow={1} flexBasis={0}>
        <Text color={theme.dim} wrap="truncate">
          {item.detail ?? ""}
        </Text>
      </Box>
    </Box>
  );
}

/**
 * The "what to do" row. Only rendered for a check that is not green, and
 * coloured like its check rather than dim: a hint the eye skips is a hint that
 * may as well not be there.
 */
function Hint(props: { item: ChecklistItem }): React.ReactElement {
  return (
    <Box>
      <Box width={2} flexShrink={0}>
        <Text> </Text>
      </Box>
      <Box flexGrow={1} flexBasis={0}>
        <Text color={colourOf(props.item.state)} wrap="truncate">
          {`→ ${props.item.hint ?? ""}`}
        </Text>
      </Box>
    </Box>
  );
}

export function DoctorScreen(props: {
  report?: DoctorReport;
  /** The `/status` reading — live subsystem probes, gathered alongside. */
  status?: StatusRows;
  running: boolean;
  onRerun: () => void;
  onBack: () => void;
}): React.ReactElement {
  const [offset, setOffset] = React.useState(0);
  useInput((char, key) => {
    if (key.escape || key.leftArrow) return props.onBack();
    if (char === "a") return props.onRerun();
    if (key.downArrow) setOffset((o) => o + 1);
    else if (key.upArrow) setOffset((o) => Math.max(0, o - 1));
  });

  const r = props.report;
  const sections = r ? doctorChecklist(r) : [];
  const verdict = checklistVerdict(sections);

  // One flat row list so the whole report scrolls as a unit. A per-section
  // focus model is the thing users get lost in (see PersonaDetail).
  const rows: React.ReactNode[] = [];
  for (const section of sections) {
    rows.push(
      <Text key={`h-${section.title}`} color={theme.accent} bold>
        {section.title}
      </Text>,
    );
    for (const item of section.items) {
      rows.push(<Check key={`${section.title}-${item.label}`} item={item} />);
      // A hint is BY CONSTRUCTION only present on a check that is not green
      // (`doctorChecklist` owns that, and a test pins it), so there is no
      // second condition here. Re-checking the state would read as though a
      // green check might carry one — and the honest place for that rule is
      // the builder, where it can be asserted once for every check rather
      // than defended in the paint.
      if (item.hint)
        rows.push(
          <Hint key={`${section.title}-${item.label}-hint`} item={item} />,
        );
    }
  }
  if (props.status && props.status.length > 0) {
    rows.push(
      <Text key="h-status" color={theme.accent} bold>
        STATUS
      </Text>,
    );
    for (const [label, value] of props.status)
      rows.push(
        <Box key={`s-${label}`}>
          <Box width={2} flexShrink={0}>
            <Text> </Text>
          </Box>
          <Box width={LABEL_COLS} flexShrink={0}>
            <Text color={theme.dim}>{label}</Text>
          </Box>
          <Box flexGrow={1} flexBasis={0}>
            <Text wrap="truncate">{value}</Text>
          </Box>
        </Box>,
      );
  }

  // Chrome: the two "more" markers (2) and the rule under the header (1), on
  // top of what the frame itself consumes. Every row above is exactly one
  // terminal line (all of them truncate rather than wrap), so the window can
  // count rows instead of measuring them.
  // Not `scrollWindow`: that grows a window outward from a CURSOR through
  // variable-height blocks, and this list has neither — every row is exactly
  // one line and the user drives a scroll offset, so the window is a slice.
  // Clamping the offset here (rather than in the key handler) is what keeps
  // it correct when the terminal is resized or a re-run shortens the report.
  const size = useTerminalSize();
  const budget = Math.max(3, viewportRows(size, 3 + frameChromeRows()));
  const start = Math.min(offset, Math.max(0, rows.length - budget));
  const view = {
    start,
    end: Math.min(rows.length, start + budget),
    above: start,
    below: Math.max(0, rows.length - start - budget),
  };

  return (
    <Frame
      title={["phantombot", "doctor"]}
      status={
        props.running
          ? "running..."
          : !r
            ? undefined
            : verdict === "ok"
              ? `${glyph.up} healthy`
              : verdict === "warn"
                ? `${glyph.warn} check the yellow lines`
                : `${glyph.bad} needs attention`
      }
      footer={[
        { icon: badge.scroll, key: "↑↓", label: "Scroll" },
        { icon: badge.run, key: "a", label: "Run again", onPress: props.onRerun },
        { icon: badge.back, key: "esc", label: "Back" },
      ]}
    >
      {!r ? (
        <Text color={theme.dim}>
          {props.running ? "running checks..." : "no report yet — press a"}
        </Text>
      ) : (
        <Box flexDirection="column">
          <Text color={theme.dim} bold>
            {r.persona.toUpperCase()}
          </Text>
          <Rule />
          <Text color={theme.dim}>
            {view.above > 0 ? `▲ ${view.above} more above` : " "}
          </Text>
          {rows.slice(view.start, view.end)}
          <Box flexGrow={1} />
          <Text color={theme.dim}>
            {view.below > 0 ? `▼ ${view.below} more below` : " "}
          </Text>
        </Box>
      )}
    </Frame>
  );
}
