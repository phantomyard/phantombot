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

import { Frame, Rule } from "../components/Frame.tsx";
import { scrollWindow } from "../scroll.ts";
import { useTerminalSize, viewportRows } from "../terminal.ts";
import { frameChromeRows } from "../chrome.ts";
import { Selectable } from "../components/Selectable.tsx";
import { badge, glyph, humanBytes, theme } from "../theme.ts";
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
      {/* The selection bar — the same three-way signal the menus use: a filled
          gutter, a bold name, and the row's own colour. */}
      <Box marginRight={1}>
        <Text backgroundColor={props.selected ? theme.accent : undefined}> </Text>
      </Box>
      <Box width="16%">
        <Text
          bold={props.selected}
          color={props.selected ? theme.accent : undefined}
          wrap="truncate"
        >
          {p.name}
        </Text>
      </Box>
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
  // Two verbs, because a row is two different things depending on why you came
  // here: someone to TALK to, or something to CONFIGURE. `↵` takes the common
  // one (and doubles as the persona switcher the chat screen has no key for);
  // `c` takes the other. Neither reads the cursor implicitly — both are handed
  // the row they act on.
  onChat: (persona: string) => void;
  onConfigure: (persona: string) => void;
  onNew: () => void;
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
    else if (key.return && current) props.onChat(current.name);
    else if (char === "c" && current) props.onConfigure(current.name);
    else if (char === "n") props.onNew();
  });

  // A host with more phantoms than rows must show FEWER, not squeezed ones —
  // Yoga compresses overflow and prints rows on top of each other. See
  // `scroll.ts`. Chrome: border 2, title 2, PHANTOMS heading 1, header row 1,
  // three rules 3, overflow marker 1, HOST block 5, footer 1.
  const size = useTerminalSize();
  const view = scrollWindow(
    personas.map(() => 1),
    viewportRows(size, 14 + frameChromeRows()),
    cursor,
  );

  return (
    <Frame
      title={["phantombot", "settings"]}
      // The header already prints the version — repeating it here gave
      // `phantombot v1.1.316 ▸ settings ... 1.1.316 · stable`.
      status={[
        `channel: ${props.host.updateChannel}`,
        // The SERVICE's state, not this process's — see HostSnapshot.
        props.host.serviceActive === undefined
          ? undefined
          : props.host.serviceActive
            ? `${glyph.up} running`
            : `${glyph.down} stopped`,
      ]
        .filter(Boolean)
        .join(" · ")}
      footer={[
        { icon: badge.chat, key: "↵", label: "Chat" },
        { icon: badge.settings, key: "c", label: "Configure" },
        { icon: badge.new, key: "n", label: "New" },
        { icon: badge.back, key: "esc", label: "Back" },
      ]}
    >
      <Box>
        <Text color={theme.accent} bold>
          PHANTOMS
        </Text>
        <Box flexGrow={1} />
        <Text color={theme.dim}>
          {`${props.host.personas.length} on this host`}
        </Text>
      </Box>
      <Rule />
      <Box>
        {/* Lead-in matching a row's two gutters — `Selectable`'s pointer and
            the selection bar — so the header sits over its own columns. */}
        <Box width={4}>
          <Text> </Text>
        </Box>
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
      <Rule />
      {personas.length === 0 ? (
        <Text color={theme.dim}>
          No phantoms yet — press n to make one.
        </Text>
      ) : (
        personas.slice(view.start, view.end).map((persona) => (
          <PersonaRow
            key={persona.name}
            persona={persona}
            selected={personas.indexOf(persona) === cursor}
            onPress={() => props.onChat(persona.name)}
          />
        ))
      )}
      {view.below > 0 || view.above > 0 ? (
        <Text color={theme.dim}>
          {`${view.above > 0 ? `▲ ${view.above} above  ` : ""}${view.below > 0 ? `▼ ${view.below} below` : ""}`}
        </Text>
      ) : null}
      <Rule />

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.accent} bold>
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
            service
          </Cell>
          <Cell width="26%">
            <Text
              color={
                props.host.serviceActive === undefined
                  ? theme.dim
                  : props.host.serviceActive
                    ? theme.ok
                    : theme.warn
              }
            >
              {props.host.serviceActive === undefined
                ? "unknown"
                : props.host.serviceActive
                  ? `${glyph.up} running`
                  : `${glyph.down} stopped`}
            </Text>
          </Cell>
          <Cell width="16%" dim>
            default
          </Cell>
          <Cell width="34%">{props.host.defaultPersona}</Cell>
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
