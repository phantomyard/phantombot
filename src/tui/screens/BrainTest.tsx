/**
 * The Brain Test screen.
 *
 * Runs a live turn through the configured model harness and presents a checklist
 * progress display with live in-flight status and final result confirmation:
 *
 *   1. While testing:
 *      [⠋] Test in progress....
 *
 *   2. On success:
 *      [✓] Test in progress....
 *      Response: "<detail>"
 *
 *      Test successful, apply? (Y/n)
 *      ▸ Yes, apply configuration
 *        No, discard and keep previous
 *
 *   3. On failure:
 *      [✗] Test in progress....
 *      <error detail>
 *
 *      Test failed, retry? (Y/n)
 *      ▸ Yes, retry setup & test
 *        No, back to Configure
 */

import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";

import { Frame } from "../components/Frame.tsx";
import { Selectable } from "../components/Selectable.tsx";
import { Spinner } from "../components/Spinner.tsx";
import { badge, glyph, theme } from "../theme.ts";

export interface BrainTestRequest {
  persona: string;
  harness: string;
  probe: () => Promise<{ ok: boolean; detail: string }>;
}

export type BrainTestResult =
  | { ok: true; apply: boolean; detail: string }
  | { ok: false; retry: boolean; detail: string };

export function BrainTestScreen(props: {
  request: BrainTestRequest;
  onAnswer: (result: BrainTestResult) => void;
}): React.ReactElement {
  const { persona, harness, probe } = props.request;
  const [stage, setStage] = useState<"testing" | "success" | "failure">("testing");
  const [detail, setDetail] = useState("");
  const [selectedOption, setSelectedOption] = useState<number>(0);

  useEffect(() => {
    let active = true;
    probe().then(
      (res) => {
        if (!active) return;
        if (res.ok) {
          setStage("success");
          setDetail(res.detail || "Model responded successfully.");
        } else {
          setStage("failure");
          setDetail(res.detail || "Probe returned an error with no details.");
        }
      },
      (err) => {
        if (!active) return;
        setStage("failure");
        setDetail(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      active = false;
    };
  }, [probe]);

  useInput((char, key) => {
    if (stage === "testing") {
      if (key.escape) {
        return props.onAnswer({ ok: false, retry: false, detail: "Test cancelled by user" });
      }
      return;
    }

    if (stage === "success") {
      if (char === "y" || char === "Y") {
        return props.onAnswer({ ok: true, apply: true, detail });
      }
      if (char === "n" || char === "N" || key.escape) {
        return props.onAnswer({ ok: true, apply: false, detail });
      }
      if (key.upArrow || key.leftArrow) {
        setSelectedOption(0);
        return;
      }
      if (key.downArrow || key.rightArrow) {
        setSelectedOption(1);
        return;
      }
      if (key.return) {
        return props.onAnswer({ ok: true, apply: selectedOption === 0, detail });
      }
    }

    if (stage === "failure") {
      if (char === "y" || char === "Y") {
        return props.onAnswer({ ok: false, retry: true, detail });
      }
      if (char === "n" || char === "N" || key.escape) {
        return props.onAnswer({ ok: false, retry: false, detail });
      }
      if (key.upArrow || key.leftArrow) {
        setSelectedOption(0);
        return;
      }
      if (key.downArrow || key.rightArrow) {
        setSelectedOption(1);
        return;
      }
      if (key.return) {
        return props.onAnswer({ ok: false, retry: selectedOption === 0, detail });
      }
    }
  });

  return (
    <Frame
      title={["brain", persona, "test"]}
      status={
        stage === "testing"
          ? "testing..."
          : stage === "success"
            ? "passed"
            : "failed"
      }
      statusColor={
        stage === "success"
          ? theme.ok
          : stage === "failure"
            ? theme.bad
            : undefined
      }
      footer={
        stage === "testing"
          ? [{ icon: badge.back, key: "esc", label: "Back" }]
          : [
              { icon: badge.select, key: "↑↓", label: "Select" },
              { icon: badge.continue, key: "↵", label: "Confirm" },
              { icon: badge.back, key: "esc", label: "Back" },
            ]
      }
    >
      <Box flexDirection="column">
        <Box marginBottom={1} flexDirection="column">
          <Text bold>
            Testing model configuration for{" "}
            <Text color={theme.accent}>{persona}</Text> ({harness})
          </Text>
          <Text color={theme.dim}>
            Sending one turn through the harness to verify model routing and credentials.
          </Text>
        </Box>

        <Box
          borderStyle="round"
          borderColor={
            stage === "testing"
              ? theme.accent
              : stage === "success"
                ? theme.ok
                : theme.bad
          }
          paddingX={2}
          paddingY={0}
          flexDirection="column"
          marginBottom={1}
          alignSelf="flex-start"
        >
          <Box>
            {stage === "testing" ? (
              <Box marginRight={1}>
                <Spinner color={theme.accent} />
              </Box>
            ) : stage === "success" ? (
              <Box marginRight={1}>
                <Text color={theme.ok} bold>
                  {glyph.ok}
                </Text>
              </Box>
            ) : (
              <Box marginRight={1}>
                <Text color={theme.bad} bold>
                  {glyph.bad}
                </Text>
              </Box>
            )}
            <Text
              bold
              color={
                stage === "success"
                  ? theme.ok
                  : stage === "failure"
                    ? theme.bad
                    : undefined
              }
            >
              Test in progress....
            </Text>
          </Box>

          {stage === "success" && detail ? (
            <Box marginTop={0} paddingLeft={2}>
              <Text color={theme.dim}>Response: </Text>
              <Text italic color={theme.accent}>
                {detail.length > 80 ? `${detail.slice(0, 77)}…` : detail}
              </Text>
            </Box>
          ) : null}

          {stage === "failure" && detail ? (
            <Box marginTop={0} paddingLeft={2}>
              <Text color={theme.warn} wrap="wrap">
                {detail.split("\n")[0]}
              </Text>
            </Box>
          ) : null}
        </Box>

        {stage === "testing" ? (
          <Box marginTop={1}>
            <Text color={theme.dim}>Awaiting response from model provider…</Text>
          </Box>
        ) : null}

        {stage === "success" ? (
          <Box flexDirection="column" marginTop={1}>
            <Box marginBottom={1}>
              <Text bold>
                Test successful, apply? <Text color={theme.accent}>(Y/n)</Text>
              </Text>
            </Box>
            <Selectable selected={selectedOption === 0}>
              <Text bold={selectedOption === 0}>
                Yes, apply configuration
              </Text>
            </Selectable>
            <Selectable selected={selectedOption === 1}>
              <Text color={selectedOption === 1 ? undefined : theme.dim}>
                No, discard and keep previous
              </Text>
            </Selectable>
          </Box>
        ) : null}

        {stage === "failure" ? (
          <Box flexDirection="column" marginTop={1}>
            <Box marginBottom={1}>
              <Text bold color={theme.bad}>
                Test failed, retry? <Text color={theme.accent}>(Y/n)</Text>
              </Text>
            </Box>
            <Selectable selected={selectedOption === 0}>
              <Text bold={selectedOption === 0}>
                Yes, retry setup & test
              </Text>
            </Selectable>
            <Selectable selected={selectedOption === 1}>
              <Text color={selectedOption === 1 ? undefined : theme.dim}>
                No, back to Configure
              </Text>
            </Selectable>
          </Box>
        ) : null}
      </Box>
    </Frame>
  );
}
