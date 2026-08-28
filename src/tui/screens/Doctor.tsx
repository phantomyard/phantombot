/**
 * Screen 5 — doctor, inline rather than a wall of scrollback.
 *
 * Renders the report `runDoctor` already produces. It does not reimplement a
 * single check: the CLI and this screen must never be able to disagree about
 * the health of the same box.
 */

import React from "react";
import { Box, Text, useInput } from "ink";

import { Frame } from "../components/Frame.tsx";
import { glyph, humanBytes, theme } from "../theme.ts";
import type { DoctorReport } from "../../cli/doctor.ts";

function Check(props: {
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
      <Box width="6%">
        <Text color={colour}>{mark}</Text>
      </Box>
      <Box width="34%">
        <Text>{props.label}</Text>
      </Box>
      <Box flexGrow={1}>
        <Text color={theme.dim} wrap="truncate">
          {props.detail ?? ""}
        </Text>
      </Box>
    </Box>
  );
}

export function DoctorScreen(props: {
  report?: DoctorReport;
  running: boolean;
  onRerun: () => void;
  onBack: () => void;
}): React.ReactElement {
  useInput((char, key) => {
    if (key.escape || key.leftArrow) return props.onBack();
    if (char === "a") props.onRerun();
  });

  const r = props.report;
  return (
    <Frame
      title={["phantombot", "doctor"]}
      status={props.running ? "running..." : undefined}
      footer={[
        { key: "a", label: "run again", onPress: props.onRerun },
        { key: "left", label: "back" },
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
          <Check
            ok={r.telegram.healthy}
            label="telegram reachable"
            detail={`${r.telegram.listeners} listener(s)`}
          />
          <Check
            ok={r.memory_db.healthy}
            label="memory db"
            detail={`${humanBytes(r.memory_db.bytes)} · ${r.memory_db.restore_points.length} restore points`}
          />
          <Check
            ok={
              r.nightly.health === "ok"
                ? true
                : r.nightly.health === "error"
                  ? false
                  : "warn"
            }
            label="nightly sweep"
            detail={r.nightly.detail}
          />
          {r.nightly.backlog > 0 ? (
            <Check
              ok="warn"
              label="nightly backlog"
              detail={`${r.nightly.backlog} day(s) pending${r.nightly.oldest_pending ? `, oldest ${r.nightly.oldest_pending}` : ""}`}
            />
          ) : null}
        </Box>
      )}
    </Frame>
  );
}
