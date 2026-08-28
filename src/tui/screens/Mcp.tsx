/**
 * Screen 6 — MCP servers.
 *
 * Adding or removing a server re-fetches the tool list and shows the NEW COUNT
 * as proof it worked, rather than reporting a config write and leaving the user
 * to discover at the next turn whether the server actually answers.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

import { Frame } from "../components/Frame.tsx";
import { Selectable } from "../components/Selectable.tsx";
import { glyph, theme } from "../theme.ts";

export interface McpServerRow {
  name: string;
  transport: string;
  auth?: string;
  tools?: number;
  ok: boolean;
  detail?: string;
}

export function McpScreen(props: {
  personaName: string;
  servers: McpServerRow[];
  onTest: (name: string) => void;
  onBack: () => void;
}): React.ReactElement {
  const [cursor, setCursor] = useState(0);
  const current = props.servers[cursor];

  useInput((char, key) => {
    if (key.escape || key.leftArrow) return props.onBack();
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow)
      setCursor((c) => Math.min(props.servers.length - 1, c + 1));
    else if (char === "t" && current) props.onTest(current.name);
  });

  return (
    <Frame
      title={["phantombot", props.personaName, "mcp"]}
      footer={[
        { key: "t", label: "test" },
        { key: "left", label: "back" },
      ]}
    >
      <Box>
        <Box width="28%">
          <Text color={theme.dim}>server</Text>
        </Box>
        <Box width="18%">
          <Text color={theme.dim}>transport</Text>
        </Box>
        <Box width="16%">
          <Text color={theme.dim}>tools</Text>
        </Box>
        <Box flexGrow={1}>
          <Text color={theme.dim}>status</Text>
        </Box>
      </Box>
      {props.servers.length === 0 ? (
        <Text color={theme.dim}>
          No MCP servers registered. `phantombot mcp help` walks through adding
          one.
        </Text>
      ) : (
        props.servers.map((server, i) => (
          <Selectable
            key={server.name}
            selected={i === cursor}
            onPress={() => props.onTest(server.name)}
          >
            <Box width="28%">
              <Text>{server.name}</Text>
            </Box>
            <Box width="18%">
              <Text color={theme.dim}>{server.transport}</Text>
            </Box>
            <Box width="16%">
              <Text color={theme.dim}>{server.tools ?? "—"}</Text>
            </Box>
            <Box flexGrow={1}>
              <Text color={server.ok ? theme.ok : theme.warn}>
                {`${server.ok ? glyph.up : glyph.warn} ${server.detail ?? (server.ok ? "ok" : "unreachable")}`}
              </Text>
            </Box>
          </Selectable>
        ))
      )}
    </Frame>
  );
}
