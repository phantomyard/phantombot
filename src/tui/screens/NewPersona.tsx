/**
 * The New Persona menu — the front door for everything that adds a phantom.
 *
 * Three routes, the same three the clack import flow offered, now asked on a
 * screen with the app's own chrome:
 *
 *   - **Create** walks the three-question create flow (CreatePersona.tsx):
 *     name, one-line identity, tone — nothing else. Brain, channels, memory
 *     and voice live in the Configure screen the flow lands on, and the new
 *     persona inherits the host chain until Configure says otherwise.
 *   - **Import** copies an OpenClaw- or phantombot-shaped directory into
 *     `personas/` (the `phantombot persona --import` machinery).
 *   - **Restore** brings an archived persona back from `personas-archive/`.
 *
 * The archive count is read when the screen opens, not at App mount: the
 * archive dir is untouched by everything else in the app, so counting it on
 * every snapshot would be a readdir nobody was looking at.
 *
 * Every route ends in the Configure screen for the resulting persona — see
 * App.tsx — because a fresh persona is by definition an unfinished one.
 */

import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";

import { Frame } from "../components/Frame.tsx";
import { Selectable } from "../components/Selectable.tsx";
import { badge, theme } from "../theme.ts";

const ROUTES = ["create", "import", "restore"] as const;

export function NewPersonaScreen(props: {
  personasDir: string;
  onCreate: () => void;
  onImport: () => void;
  onRestore: () => void;
  onBack: () => void;
}): React.ReactElement {
  const [cursor, setCursor] = useState(0);
  const [archiveCount, setArchiveCount] = useState<number | undefined>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { listArchives } = await import("../../lib/personaArchive.ts");
        const archives = await listArchives(props.personasDir);
        if (!cancelled) setArchiveCount(archives.length);
      } catch {
        // An unreadable archive dir is a zero, not a crash — the count is a
        // hint on a menu row, not a fact worth a broken screen for.
        if (!cancelled) setArchiveCount(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.personasDir]);

  useInput((_char, key) => {
    if (key.escape) return props.onBack();
    if (key.upArrow) return setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) return setCursor((c) => Math.min(ROUTES.length - 1, c + 1));
    if (key.return) {
      const route = ROUTES[cursor];
      if (route === "create") props.onCreate();
      else if (route === "import") props.onImport();
      else if (route === "restore") props.onRestore();
    }
  });

  const count = archiveCount === undefined ? "…" : String(archiveCount);

  return (
    <Frame
      title={["phantombot", "new"]}
      footer={[
        { icon: badge.select, key: "↑↓", label: "Select" },
        { icon: badge.open, key: "↵", label: "Continue" },
        { icon: badge.back, key: "esc", label: "Back" },
      ]}
    >
      <Box marginBottom={1}>
        <Text bold>What do you want to do?</Text>
      </Box>
      <Box flexDirection="column">
        <Selectable selected={cursor === 0} onPress={props.onCreate}>
          <Text>Create a new persona</Text>
        </Selectable>
        <Selectable selected={cursor === 1} onPress={props.onImport}>
          <Text>
            Import from a directory{" "}
            <Text color={theme.dim}>(OpenClaw or phantombot-shaped)</Text>
          </Text>
        </Selectable>
        <Selectable selected={cursor === 2} onPress={props.onRestore}>
          <Text>
            Restore an archived persona{" "}
            <Text color={theme.dim}>{`(${count} available)`}</Text>
          </Text>
        </Selectable>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dim}>
          A new or imported phantom opens straight into its Configure screen —
          the brain is what makes it ready.
        </Text>
      </Box>
    </Frame>
  );
}
