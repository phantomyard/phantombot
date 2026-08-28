/**
 * Screen 4 — the vault: names only, never values.
 *
 * The TUI never renders a secret. This screen lists NAMES, whether each is set,
 * and what uses it; setting one prompts in a masked field whose contents are
 * written straight to the vault and never held anywhere a render can reach.
 *
 * The `used by` column is the point of the screen: it turns "a list of strings"
 * into "which of your configured things is missing its credential", which is
 * how a phantom silently half-works today.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

import { Frame } from "../components/Frame.tsx";
import { Selectable } from "../components/Selectable.tsx";
import { badge, glyph, theme } from "../theme.ts";
import type { PersonaSnapshot } from "../snapshot.ts";

/**
 * Which secret does each configured thing need? Used to show a REQUIRED but
 * absent credential as a warning row rather than as silence.
 */
export function expectedSecrets(
  persona: PersonaSnapshot,
): Array<{ name: string; usedBy: string }> {
  const out: Array<{ name: string; usedBy: string }> = [];
  if (persona.channels.includes("telegram")) {
    out.push({ name: "TELEGRAM_BOT_TOKEN", usedBy: "channel: telegram" });
  }
  if (persona.chain.includes("pi")) {
    out.push({ name: "ANTHROPIC_API_KEY", usedBy: "harness: pi" });
  }
  const provider = persona.memory.embedding?.provider;
  if (provider === "gemini") {
    out.push({ name: "GEMINI_API_KEY", usedBy: "embeddings" });
  } else if (provider === "openai-compatible") {
    out.push({ name: "OPENAI_API_KEY", usedBy: "embeddings" });
  }
  if (persona.voiceProvider === "elevenlabs") {
    out.push({ name: "ELEVENLABS_API_KEY", usedBy: "voice" });
  } else if (persona.voiceProvider === "openai") {
    out.push({ name: "OPENAI_API_KEY", usedBy: "voice" });
  }
  return out;
}

export interface KeyRow {
  name: string;
  set: boolean;
  usedBy: string;
}

/** Merge what is stored with what is expected, so gaps are visible. */
export function keyRows(persona: PersonaSnapshot): KeyRow[] {
  const stored = new Set(persona.secretNames ?? []);
  const expected = expectedSecrets(persona);
  const byName = new Map<string, KeyRow>();
  for (const name of stored) {
    byName.set(name, { name, set: true, usedBy: "" });
  }
  for (const e of expected) {
    const existing = byName.get(e.name);
    if (existing) existing.usedBy = e.usedBy;
    else byName.set(e.name, { name: e.name, set: false, usedBy: e.usedBy });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function KeysScreen(props: {
  persona: PersonaSnapshot;
  onSet: (name: string) => void;
  onUnset: (name: string) => void;
  onBack: () => void;
}): React.ReactElement {
  const rows = keyRows(props.persona);
  const [cursor, setCursor] = useState(0);
  const missing = rows.filter((r) => !r.set);

  useInput((char, key) => {
    if (key.escape || key.leftArrow) return props.onBack();
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(rows.length - 1, c + 1));
    else if (key.return && rows[cursor]) props.onSet(rows[cursor]!.name);
    else if (char === "x" && rows[cursor]) props.onUnset(rows[cursor]!.name);
  });

  return (
    <Frame
      title={["phantombot", props.persona.name, "vault"]}
      footer={[
        { icon: badge.edit, key: "↵", label: "Set" },
        { icon: badge.unset, key: "x", label: "Unset" },
        { icon: badge.back, key: "esc", label: "Back" },
      ]}
    >
      <Box>
        <Box width="46%">
          <Text color={theme.dim}>name</Text>
        </Box>
        <Box width="14%">
          <Text color={theme.dim}>set</Text>
        </Box>
        <Box flexGrow={1}>
          <Text color={theme.dim}>used by</Text>
        </Box>
      </Box>
      {rows.map((row, i) => (
        <Selectable
          key={row.name}
          selected={i === cursor}
          onPress={() => props.onSet(row.name)}
        >
          <Box width="46%">
            <Text>{row.name}</Text>
          </Box>
          <Box width="14%">
            <Text color={row.set ? theme.ok : theme.warn}>
              {row.set ? glyph.ok : glyph.bad}
            </Text>
          </Box>
          <Box flexGrow={1}>
            <Text color={theme.dim}>{row.usedBy}</Text>
          </Box>
        </Selectable>
      ))}
      {missing.length > 0 ? (
        <Box marginTop={1}>
          <Text color={theme.warn}>
            {`${glyph.warn}  ${missing.map((m) => m.name).join(", ")} — configured but not set. That feature will be skipped.`}
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={theme.dim}>
          Values are never displayed. Setting one prompts in a masked field.
        </Text>
      </Box>
    </Frame>
  );
}
