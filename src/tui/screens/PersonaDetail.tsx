/**
 * Screen 3 — persona detail: settings as VALUES, not questions.
 *
 * This is the screen that does not exist today in any form. Every line is a
 * current reading, and `↵` on a line opens the thing that changes it.
 *
 * The brain block deliberately shows the THREE-LAYER resolution
 * (`state.json harness_bins` > `config.toml [harnesses.<h>] bin` > code
 * default). A stale absolute path cached in state.json survives deleting
 * config.toml and looks exactly like a bad default; showing where the value
 * came from makes that diagnosable on screen instead of by experiment.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

import { Frame, Field, Section } from "../components/Frame.tsx";
import { Selectable } from "../components/Selectable.tsx";
import { glyph, humanBytes, humanCount, theme } from "../theme.ts";
import type { PersonaSnapshot } from "../snapshot.ts";

type Target = "memory" | "voice" | "keys" | "mcp" | "doctor";

/**
 * The boot rows are ACTIONS, not readings. They sit above the settings list in
 * one cursor so a user can never be looking at `autostart: no` with no way to
 * change it from the screen that reports it.
 */
type BootRow = "autostart" | "default";

const TARGETS: Array<{ id: Target; label: string }> = [
  { id: "memory", label: "Memory" },
  { id: "voice", label: "Voice" },
  { id: "keys", label: "Vault" },
  { id: "mcp", label: "MCP" },
  { id: "doctor", label: "Doctor" },
];

const BOOT_ROWS: BootRow[] = ["autostart", "default"];

export function PersonaDetailScreen(props: {
  persona: PersonaSnapshot;
  onOpen: (target: Target) => void;
  onToggleAutostart: () => void;
  onMakeDefault: () => void;
  onBack: () => void;
  onRestart: () => void;
}): React.ReactElement {
  const [cursor, setCursor] = useState(0);
  const p = props.persona;
  const rows = BOOT_ROWS.length + TARGETS.length;

  const press = (index: number) => {
    if (index === 0) return props.onToggleAutostart();
    // Already the default: there is nothing to switch to, and offering the
    // confirm panel for a no-op would state a consequence that cannot happen.
    if (index === 1) return p.isDefault ? undefined : props.onMakeDefault();
    props.onOpen(TARGETS[index - BOOT_ROWS.length]!.id);
  };

  useInput((char, key) => {
    if (key.escape || key.leftArrow) return props.onBack();
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(rows - 1, c + 1));
    else if (key.return) press(cursor);
    else if (char === "r") props.onRestart();
  });

  return (
    <Frame
      title={["phantombot", p.name]}
      status={p.completeness.complete ? `${glyph.up} ready` : `${glyph.warn} incomplete`}
      footer={[
        { key: "↑↓", label: "move" },
        { key: "↵", label: "open" },
        { key: "r", label: "restart" },
        { key: "←", label: "back" },
      ]}
    >
      <Section title="brain" />
      <Field label="chain" value={p.chain.join(" → ") || "none configured"} />
      <Field
        label="binary"
        value={p.resolvedHarness?.path ?? "not found on PATH"}
      />
      <Field
        label="resolved from"
        value="state.json harness_bins > config.toml [harnesses.<h>] bin > default"
      />

      <Section title="channels" />
      <Field label="configured" value={p.channels.join(", ")} />

      <Section title="boot" />
      <Selectable selected={cursor === 0} onPress={() => press(0)}>
        <Field
          label="autostart"
          value={p.autostart || p.isDefault ? `${glyph.ok} yes` : `${glyph.bad} no`}
          hint="host setting · ↵ toggles"
        />
      </Selectable>
      <Selectable selected={cursor === 1} onPress={() => press(1)}>
        <Field
          label="default"
          value={
            p.isDefault
              ? `${glyph.ok} yes — owns /update and /restart`
              : `${glyph.bad} no`
          }
          hint={p.isDefault ? undefined : "↵ hands over /update and /restart"}
        />
      </Selectable>

      <Section title="settings" />
      {TARGETS.map((target, i) => (
        <Selectable
          key={target.id}
          selected={i + BOOT_ROWS.length === cursor}
          onPress={() => press(i + BOOT_ROWS.length)}
        >
          <Box>
            <Box width="20%">
              <Text>{target.label}</Text>
            </Box>
            <Box flexGrow={1}>
              <Text color={theme.dim}>
                {target.id === "memory"
                  ? `journal ${humanCount(p.memory.journalRows)} rows · kb ${humanCount(p.memory.kbNotes)} notes · ${humanBytes(p.memory.dbBytes)}`
                  : target.id === "voice"
                    ? `${p.voiceProvider ?? "none"}${p.voiceProvider === "azure_edge" ? " · speaks only" : ""}`
                    : target.id === "keys"
                      ? `${p.secretNames?.length ?? 0} secrets`
                      : target.id === "mcp"
                        ? "servers and tools"
                        : "run the checks"}
              </Text>
            </Box>
          </Box>
        </Selectable>
      ))}
    </Frame>
  );
}
