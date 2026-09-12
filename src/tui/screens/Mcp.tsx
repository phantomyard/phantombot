/**
 * Screen 6 — the persona's MCP servers, reached from Configure → MCP Servers.
 *
 * A registry LIST first, health second. The rows come off disk and paint
 * immediately; status starts as a dim `—` and fills in as each probe lands,
 * because the whole point of opening this screen is often to remove the server
 * that hangs — and a screen that blocks on probing it cannot be used to do
 * that.
 *
 * The tool COUNT is what "reachable" means here, not a successful socket: a
 * server that connects and then answers nothing to `tools/list` gives the
 * agent no tools, and calling that green is the failure this screen exists to
 * surface.
 *
 * Deleting shows the selected server's target and the vault keys it
 * references BEFORE the confirm, so "remove github" is a decision made with
 * the command line and the credentials in view rather than from a name alone.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

import { Frame, Rule } from "../components/Frame.tsx";
import { Selectable } from "../components/Selectable.tsx";
import { badge, glyph, theme } from "../theme.ts";

/** Probe state of one row. `unknown` = not probed yet, not "broken". */
export type McpProbeStatus = "unknown" | "probing" | "ok" | "bad";

export interface McpServerRow {
  name: string;
  transport: string;
  auth?: string;
  /** Command line (stdio) or endpoint URL (http) — what the entry points at. */
  target?: string;
  tools?: number;
  status: McpProbeStatus;
  detail?: string;
  /** Vault keys this entry references, for the delete confirm. */
  secrets?: string[];
}

function statusCell(row: McpServerRow): { text: string; colour?: string } {
  if (row.status === "probing") return { text: "probing…", colour: theme.dim };
  if (row.status === "unknown")
    return { text: "— not probed", colour: theme.dim };
  if (row.status === "ok")
    return { text: `${glyph.ok} ${row.detail ?? "reachable"}`, colour: theme.ok };
  return { text: `${glyph.bad} ${row.detail ?? "unreachable"}`, colour: theme.bad };
}

export function McpScreen(props: {
  personaName: string;
  servers: McpServerRow[];
  /** Probe one server and report its tool count. */
  onTest: (name: string) => void;
  /** Probe every registered server. */
  onTestAll: () => void;
  /** Remove one server from the registry (the caller owns the confirm). */
  onDelete: (name: string) => void;
  onBack: () => void;
}): React.ReactElement {
  const [cursor, setCursor] = useState(0);
  // A delete shortens the list, so a cursor parked on the last row would point
  // past the end until the next keypress moved it.
  const index = Math.min(cursor, Math.max(0, props.servers.length - 1));
  const current = props.servers[index];

  useInput((char, key) => {
    if (key.escape || key.leftArrow) return props.onBack();
    if (key.upArrow) setCursor(Math.max(0, index - 1));
    else if (key.downArrow)
      setCursor(Math.min(props.servers.length - 1, index + 1));
    else if (char === "t" && current) props.onTest(current.name);
    else if (char === "a") props.onTestAll();
    else if (char === "d" && current) props.onDelete(current.name);
  });

  return (
    <Frame
      title={["phantombot", props.personaName, "mcp"]}
      footer={[
        { icon: badge.move, key: "↑↓", label: "Move" },
        { icon: badge.test, key: "t", label: "Test" },
        { icon: badge.run, key: "a", label: "Test all" },
        { icon: badge.unset, key: "d", label: "Delete" },
        { icon: badge.back, key: "esc", label: "Back" },
      ]}
    >
      <Rule />
      <Box>
        <Box width={2} flexShrink={0}>
          <Text> </Text>
        </Box>
        <Box width={18} flexShrink={0}>
          <Text color={theme.dim}>server</Text>
        </Box>
        <Box width={10} flexShrink={0}>
          <Text color={theme.dim}>transport</Text>
        </Box>
        <Box width={10} flexShrink={0}>
          <Text color={theme.dim}>auth</Text>
        </Box>
        <Box flexGrow={1} flexBasis={0}>
          <Text color={theme.dim}>status</Text>
        </Box>
      </Box>
      <Rule />
      {props.servers.length === 0 ? (
        <Text color={theme.dim}>
          No MCP servers registered. `phantombot mcp help` walks through adding
          one.
        </Text>
      ) : (
        props.servers.map((server, i) => {
          const cell = statusCell(server);
          return (
            <Selectable
              key={server.name}
              selected={i === index}
              onPress={() => props.onTest(server.name)}
              fullWidth
            >
              <Box width={18} flexShrink={0}>
                <Text
                  bold={i === index}
                  color={i === index ? "whiteBright" : undefined}
                  wrap="truncate"
                >
                  {server.name}
                </Text>
              </Box>
              <Box width={10} flexShrink={0}>
                <Text color={theme.dim}>{server.transport}</Text>
              </Box>
              <Box width={10} flexShrink={0}>
                <Text color={theme.dim}>{server.auth ?? "none"}</Text>
              </Box>
              <Box flexGrow={1} flexBasis={0}>
                <Text color={cell.colour} wrap="truncate">
                  {cell.text}
                </Text>
              </Box>
            </Selectable>
          );
        })
      )}
      <Box flexGrow={1} />
      {current ? (
        <Box flexDirection="column">
          <Rule />
          <Text color={theme.dim} wrap="truncate">
            {current.target ?? ""}
          </Text>
          {current.secrets && current.secrets.length > 0 ? (
            <Text color={theme.dim} wrap="truncate">
              {`vault: ${current.secrets.join(", ")}`}
            </Text>
          ) : null}
        </Box>
      ) : null}
    </Frame>
  );
}
