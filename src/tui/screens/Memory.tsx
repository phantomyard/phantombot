/**
 * Screen 7 — memory: the screen that explains itself.
 *
 * The live search box is deliberate. Recall quality is the one setting a user
 * cannot judge from its value — `1536` tells you nothing. Typing a real query
 * and seeing what comes back, with both scores, is the only honest preview.
 *
 * `e` opens the embedding change, which runs the re-embed ITSELF (see
 * `actions.ts`). Nothing on this screen leaves the system needing a
 * follow-up command.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

import { Frame, Field, Section } from "../components/Frame.tsx";
import { humanBytes, humanCount, glyph, theme } from "../theme.ts";
import type { PersonaSnapshot } from "../snapshot.ts";

export interface SearchHit {
  path: string;
  ftsScore?: number;
  vecScore?: number;
}

export function MemoryScreen(props: {
  persona: PersonaSnapshot;
  /** Runs the same hybrid search `phantombot memory search` uses. */
  onSearch: (query: string) => Promise<SearchHit[]>;
  onChangeEmbedding: () => void;
  onReindex: () => void;
  onBack: () => void;
}): React.ReactElement {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const m = props.persona.memory;
  const drawers = m.drawerCounts ?? {};

  useInput((char, key) => {
    if (key.escape || key.leftArrow) return props.onBack();
    if (key.ctrl && char === "r") return props.onReindex();
    if (key.return) {
      if (!query.trim()) return;
      setSearching(true);
      void props
        .onSearch(query.trim())
        .then(setHits)
        .finally(() => setSearching(false));
      return;
    }
    if (key.backspace || key.delete) return setQuery((q) => q.slice(0, -1));
    if (char && !key.ctrl && !key.meta) setQuery((q) => q + char);
  });

  // "In sync" is not cosmetic: a stale count means queries are space-scoped to
  // vectors that no longer exist, so recall has silently fallen back to lexical.
  const inSync =
    m.indexedTotal !== undefined &&
    m.indexedInSpace !== undefined &&
    m.indexedInSpace >= m.indexedTotal;

  return (
    <Frame
      title={["phantombot", props.persona.name, "memory"]}
      footer={[
        { key: "type", label: "search" },
        { key: "e", label: "embeddings", onPress: props.onChangeEmbedding },
        { key: "ctrl-r", label: "reindex" },
        { key: "left", label: "back" },
      ]}
    >
      <Section title="store" />
      <Field
        label="journal"
        value={`${humanCount(m.journalRows)} rows`}
        hint={m.oldestJournalDay ? `oldest ${m.oldestJournalDay}` : ""}
      />
      <Field
        label="drawers"
        value={
          Object.entries(drawers)
            .map(([kind, n]) => `${kind} ${n}`)
            .join(" · ") || "empty"
        }
      />
      <Field
        label="kb"
        value={`${humanCount(m.kbNotes)} notes · ${humanCount(m.kbLinks)} links`}
      />
      <Field label="database" value={humanBytes(m.dbBytes)} hint={m.dbPath} />

      <Section title="recall" />
      <Field
        label="lexical"
        value="OKF field-weighted BM25 + link-graph"
        hint="always on"
      />
      <Field
        label="semantic"
        value={
          m.embedding
            ? `${m.embedding.provider} · ${m.embedding.model} · ${m.embedding.dimensions}`
            : "off — lexical only"
        }
      />
      {m.embedding ? (
        <Field label="space" value={m.embedding.fingerprint} />
      ) : null}
      <Field
        label="indexed"
        value={
          <Text color={inSync ? theme.ok : theme.warn}>
            {`${humanCount(m.indexedInSpace)} / ${humanCount(m.indexedTotal)} ${
              inSync ? `${glyph.ok} in sync` : `${glyph.warn} stale — re-embed`
            }`}
          </Text>
        }
      />

      <Box
        marginTop={1}
        borderStyle="round"
        borderColor={theme.dim}
        paddingX={1}
        flexDirection="column"
      >
        <Box>
          <Text color={theme.dim}>search </Text>
          <Text>{query}</Text>
          {searching ? <Text color={theme.dim}>{"  ..."}</Text> : null}
        </Box>
        {hits.map((hit, i) => (
          <Box key={hit.path}>
            <Box width="8%">
              <Text color={theme.dim}>{i + 1}</Text>
            </Box>
            <Box flexGrow={1}>
              <Text wrap="truncate">{hit.path}</Text>
            </Box>
            <Text color={theme.dim}>
              {`fts ${hit.ftsScore?.toFixed(1) ?? "—"}  vec ${hit.vecScore?.toFixed(2) ?? "—"}`}
            </Text>
          </Box>
        ))}
      </Box>
    </Frame>
  );
}
