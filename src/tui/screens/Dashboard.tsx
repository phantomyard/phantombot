/**
 * Screen 2 — the dashboard, behind `^s`.
 *
 * NOT the landing screen. You arrive here from chat, and `esc` puts you back in
 * the same conversation at the same point. Everything that is not *talking to*
 * a phantom starts here.
 *
 * The reason this screen exists at all: today, settings are only ever ASKED,
 * never SHOWN. There is no surface anywhere that displays what a persona's
 * harness, channels, embeddings or autostart state currently ARE — to find out
 * you re-enter the wizard that sets them and read the default off the prompt.
 * A dashboard fixes that by construction: state is rendered, not remembered.
 *
 * Every column comes from something that already exists — the persona
 * directory listing, `autostart_personas`, `default_persona`, the resolved
 * harness, configured channels.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

import { Frame } from "../components/Frame.tsx";
import { Selectable } from "../components/Selectable.tsx";
import { glyph, humanBytes, theme } from "../theme.ts";
import type { HostSnapshot, PersonaSnapshot } from "../snapshot.ts";

function Cell(props: {
  width: string;
  children: React.ReactNode;
  dim?: boolean;
}): React.ReactElement {
  // Width as a PERCENTAGE, never a column count: the layout engine truncates
  // over-long values, so nothing here shears on a resize or a wide glyph.
  return (
    <Box width={props.width}>
      <Text color={props.dim ? theme.dim : undefined} wrap="truncate">
        {props.children}
      </Text>
    </Box>
  );
}

function PersonaRow(props: {
  persona: PersonaSnapshot;
  selected: boolean;
  onPress: () => void;
}): React.ReactElement {
  const p = props.persona;
  const complete = p.completeness.complete;
  return (
    <Selectable selected={props.selected} onPress={props.onPress}>
      <Cell width="16%">{p.name}</Cell>
      <Cell width="12%">
        <Text color={complete ? theme.ok : theme.warn}>
          {complete ? `${glyph.up} ready` : `${glyph.warn} setup`}
        </Text>
      </Cell>
      <Cell width="16%" dim>
        {p.resolvedHarness?.id ?? p.chain[0] ?? "—"}
      </Cell>
      <Cell width="24%" dim>
        {p.channels.join(", ")}
      </Cell>
      <Cell width="10%" dim>
        {p.autostart || p.isDefault ? glyph.ok : glyph.bad}
      </Cell>
      <Cell width="12%" dim>
        {humanBytes(p.memory.dbBytes)}
      </Cell>
      <Cell width="10%">
        <Text color={theme.accent}>{p.isDefault ? "default" : ""}</Text>
      </Cell>
    </Selectable>
  );
}

export function DashboardScreen(props: {
  host: HostSnapshot;
  onOpen: (persona: string) => void;
  onChat: (persona: string) => void;
  onNew: () => void;
  onDoctor: () => void;
  onKeys: (persona: string) => void;
  onMcp: (persona: string) => void;
  onRestart: () => void;
  onBack: () => void;
}): React.ReactElement {
  const [cursor, setCursor] = useState(0);
  const personas = props.host.personas;
  const current = personas[cursor];

  useInput((char, key) => {
    if (key.escape) return props.onBack();
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow)
      setCursor((c) => Math.min(personas.length - 1, c + 1));
    else if (key.return && current) props.onOpen(current.name);
    else if (char === "c" && current) props.onChat(current.name);
    else if (char === "n") props.onNew();
    else if (char === "d") props.onDoctor();
    else if (char === "k" && current) props.onKeys(current.name);
    else if (char === "m" && current) props.onMcp(current.name);
    else if (char === "r") props.onRestart();
  });

  return (
    <Frame
      title={["phantombot", "settings"]}
      status={`${props.host.version} · ${props.host.updateChannel}`}
      footer={[
        { key: "↵", label: "open" },
        { key: "c", label: "chat" },
        { key: "n", label: "new" },
        { key: "r", label: "restart" },
        { key: "d", label: "doctor" },
        { key: "k", label: "keys" },
        { key: "m", label: "mcp" },
        { key: "esc", label: "back to chat" },
      ]}
    >
      <Text color={theme.dim} bold>
        PHANTOMS
      </Text>
      <Box>
        <Cell width="16%" dim>
          name
        </Cell>
        <Cell width="12%" dim>
          status
        </Cell>
        <Cell width="16%" dim>
          brain
        </Cell>
        <Cell width="24%" dim>
          channels
        </Cell>
        <Cell width="10%" dim>
          boot
        </Cell>
        <Cell width="12%" dim>
          memory
        </Cell>
        <Cell width="10%" dim>
          {" "}
        </Cell>
      </Box>
      {personas.length === 0 ? (
        <Text color={theme.dim}>
          No phantoms yet — press n to make one.
        </Text>
      ) : (
        personas.map((persona, i) => (
          <PersonaRow
            key={persona.name}
            persona={persona}
            selected={i === cursor}
            onPress={() => props.onOpen(persona.name)}
          />
        ))
      )}

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.dim} bold>
          HOST
        </Text>
        <Box>
          <Cell width="24%" dim>
            channel
          </Cell>
          <Cell width="26%">{props.host.updateChannel}</Cell>
          <Cell width="16%" dim>
            version
          </Cell>
          <Cell width="34%">{props.host.version}</Cell>
        </Box>
        <Box>
          <Cell width="24%" dim>
            personas dir
          </Cell>
          <Cell width="76%">{props.host.personasDir}</Cell>
        </Box>
      </Box>
    </Frame>
  );
}
