/**
 * Screen 3 — the SETTINGS screen for one phantom, reached with `^s` from chat.
 *
 * This is the screen that does not exist today in any form. Every line is a
 * current reading, and `↵` on a row opens the thing that changes it. Settings
 * as VALUES, not questions.
 *
 * Scoped to ONE persona on purpose. `^s` from a conversation means "the
 * settings of the phantom I am talking to" — it does not mean a host-wide list,
 * which is what `^p` is for. The first cut wired both keys to the dashboard, so
 * a user pressing the settings key for a specific phantom got a table of every
 * phantom on the box and had to find their way back down to the one they were
 * already in.
 *
 * Each row carries its own detail lines underneath, so the screen answers
 * "what is this set to?" without a single keypress. The brain block
 * deliberately shows the THREE-LAYER resolution (`state.json harness_bins` >
 * `config.toml [harnesses.<h>] bin` > code default): a stale absolute path
 * cached in state.json survives deleting config.toml and looks exactly like a
 * bad default, so showing where the value came from makes that diagnosable on
 * screen instead of by experiment.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

import { Frame } from "../components/Frame.tsx";
import { MenuItem } from "../components/Menu.tsx";
import {
  badge,
  glyph,
  humanBytes,
  humanCount,
  humanWhen,
  theme,
} from "../theme.ts";
import { scrollWindow } from "../scroll.ts";
import { useTerminalSize, viewportRows } from "../terminal.ts";
import { frameChromeRows } from "../chrome.ts";
import { providerHearsVoice } from "../../lib/voice.ts";
import type { ChannelDetail, PersonaSnapshot } from "../snapshot.ts";
import type { VoiceProvider } from "../../lib/voice.ts";

function sourceLabel(
  source: "persona" | "global" | "default" | undefined,
): string {
  if (source === "persona") return "persona override";
  if (source === "global") return "inherited from global config";
  return "built-in default (no key set)";
}

/** Screens this one leads to. */
export type Target = "memory" | "voice" | "doctor";

/**
 * Everything the cursor can land on, in screen order.
 *
 * One flat list rather than a section-per-list, because a settings screen with
 * several independently-focusable panes needs a focus model, and a focus model
 * is the thing users get lost in. Up and down walk the whole screen.
 */
export type Row =
  | "identity"
  | "brain"
  | "channels"
  | "memory"
  | "voice"
  | "autostart"
  | "default"
  | "doctor";

const ROWS: Row[] = [
  "identity",
  "brain",
  "channels",
  "memory",
  "voice",
  "autostart",
  "default",
  "doctor",
];

/**
 * The dim readings belonging to the row above them, as label/value pairs.
 *
 * Pairs rather than pre-padded strings: `"binary".padEnd(13)` is column
 * arithmetic done in a component, and it slips the moment a value contains a
 * double-width glyph. The layout engine owns the alignment here too.
 */
function Detail(props: {
  lines: Array<[string, string] | undefined>;
}): React.ReactElement {
  return (
    <Box flexDirection="column" paddingLeft={6} marginBottom={1}>
      {props.lines
        .filter((line): line is [string, string] => Boolean(line))
        .map(([label, value], i) => (
          <Box key={i}>
            <Box width={13} flexShrink={0}>
              <Text color={theme.dim} wrap="truncate">
                {label}
              </Text>
            </Box>
            <Box flexGrow={1}>
              <Text color={theme.dim} wrap="truncate">
                {value}
              </Text>
            </Box>
          </Box>
        ))}
    </Box>
  );
}

function channelLine(channel: ChannelDetail): [string, string] {
  const mark =
    channel.state === "connected"
      ? glyph.up
      : channel.state === "broken"
        ? glyph.warn
        : glyph.down;
  return [channel.label, `${mark} ${channel.detail}`];
}

export function PersonaDetailScreen(props: {
  persona: PersonaSnapshot;
  onOpen: (target: Target) => void;
  onEditIdentity: () => void;
  onChangeBrain: () => void;
  onChangeChannels: () => void;
  onToggleAutostart: () => void;
  onMakeDefault: () => void;
  onBack: () => void;
  onLogs: () => void;
}): React.ReactElement {
  const [cursor, setCursor] = useState(0);
  const p = props.persona;
  const row = ROWS[cursor]!;

  const press = (id: Row) => {
    if (id === "identity") return props.onEditIdentity();
    if (id === "brain") return props.onChangeBrain();
    if (id === "channels") return props.onChangeChannels();
    if (id === "autostart") return props.onToggleAutostart();
    if (id === "default") return props.onMakeDefault();
    return props.onOpen(id);
  };

  useInput((char, key) => {
    if (key.escape || key.leftArrow) return props.onBack();
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(ROWS.length - 1, c + 1));
    else if (key.return) press(row);
    else if (char === "L") props.onLogs();
  });

  const identityMarks = p.identity.files
    .map((f) => `${f.name} ${f.present ? glyph.ok : glyph.bad}`)
    .join("   ");

  const voiceProvider = (p.voiceProvider ?? "none") as VoiceProvider;
  const hears = p.voiceHears ?? providerHearsVoice(voiceProvider);
  const embedding = p.memory.embedding;
  // Three states, not two. A count we could not read is NOT "out of sync":
  // claiming a re-embed is pending because the index DB was unreadable sends
  // the user to re-embed a corpus that may be perfectly in step.
  const indexState =
    p.memory.indexedInSpace === undefined || p.memory.indexedTotal === undefined
      ? "unknown"
      : p.memory.indexedInSpace === p.memory.indexedTotal
        ? "in sync"
        : "stale";

  // Chrome around the scrolling region: border (2), title (1), title gap (1),
  // the two "more" markers (2), footer (1). A constant, like the chat screen's:
  // measuring would mean reading the layout back out of Yoga mid-render, and
  // one row conservative costs a blank line while one row optimistic tears the
  // frame.
  const size = useTerminalSize();
  const budget = viewportRows(size, 5 + frameChromeRows());

  const blocks: Array<{ id: Row; height: number; node: React.ReactNode }> = [
    {
      id: "identity",
      height: 3,
      node: (
        <>
          <MenuItem
            icon="◐"
            label="Identity"
            description={p.identity.description ?? p.name}
            activateHint="↵ edit"
            selected={row === "identity"}
            onPress={() => press("identity")}
          />
          <Detail lines={[["files", identityMarks]]} />
        </>
      ),
    },
    {
      id: "brain",
      height: 4,
      node: (
        <>
          <MenuItem
            icon="◉"
            label="Brain"
            description={`harness: ${p.chain.join(" → ") || "none configured"} · ${sourceLabel(p.configSources?.brain)}`}
            badge={
              p.resolvedHarness
                ? `${glyph.ok} resolved`
                : `${glyph.bad} missing`
            }
            badgeColor={p.resolvedHarness ? theme.ok : theme.bad}
            activateHint="↵ change"
            selected={row === "brain"}
            onPress={() => press("brain")}
          />
          <Detail
            lines={[
              ["binary", p.resolvedHarness?.path ?? "not found on PATH"],
              [
                "from",
                "env > config.toml [harnesses.<h>] bin > state.json harness_bins > default",
              ],
            ]}
          />
        </>
      ),
    },
    {
      id: "channels",
      height: 3 + p.channelDetails.length,
      node: (
        <>
          <MenuItem
            icon="◎"
            label="Channels"
            description={p.channels.join(", ")}
            activateHint="↵ manage"
            selected={row === "channels"}
            onPress={() => press("channels")}
          />
          <Detail
            lines={[
              ["from", sourceLabel(p.configSources?.channels)],
              ...p.channelDetails.map(channelLine),
            ]}
          />
        </>
      ),
    },
    {
      id: "memory",
      height: 6,
      node: (
        <>
          <MenuItem
            icon="◆"
            label="Memory"
            description={`journal ${humanCount(p.memory.journalRows)} rows · kb ${humanCount(p.memory.kbNotes)} notes · ${humanBytes(p.memory.dbBytes)}`}
            activateHint="↵ manage"
            selected={row === "memory"}
            onPress={() => press("memory")}
          />
          <Detail
            lines={[
              [
                "last nightly",
                p.nightly
                  ? // A healthy sweep says so in three words; only a sweep in
                    // trouble is worth spending the line on its detail.
                    `${humanWhen(p.nightly.lastRun)}  ${
                      p.nightly.status === "ok"
                        ? `${glyph.ok} clean`
                        : `${glyph.warn} ${p.nightly.detail}`
                    }`
                  : "—",
              ],
              [
                "embeddings",
                embedding
                  ? `${embedding.provider} · ${embedding.model} · ${embedding.dimensions}`
                  : "off",
              ],
              ["from", sourceLabel(p.configSources?.embeddings)],
              [
                "indexed",
                `${humanCount(p.memory.indexedInSpace)} / ${humanCount(p.memory.indexedTotal)}  ${
                  indexState === "in sync"
                    ? `${glyph.ok} in sync`
                    : indexState === "stale"
                      ? `${glyph.warn} re-embed pending`
                      : "· count unavailable"
                }`,
              ],
            ]}
          />
        </>
      ),
    },
    {
      id: "voice",
      height: 4,
      node: (
        <>
          <MenuItem
            icon="◈"
            label="Voice"
            description={`${voiceProvider}${p.voiceName ? ` · ${p.voiceName}` : ""}`}
            activateHint="↵ manage"
            selected={row === "voice"}
            onPress={() => press("voice")}
          />
          <Detail
            lines={[
              ["from", sourceLabel(p.configSources?.voice)],
              // The azure_edge trap, stated as a live reading: one config key
              // drives both speaking and hearing, and the provider that needs
              // no credential cannot transcribe. See screens/Voice.tsx.
              [
                "STT",
                hears
                  ? `${glyph.up} ${voiceProvider}`
                  : `${glyph.bad} not available on ${voiceProvider} — it speaks, it cannot hear`,
              ],
            ]}
          />
        </>
      ),
    },
    {
      id: "autostart",
      height: 1,
      node: (
        <MenuItem
          icon="⏻"
          label="Autostart"
          description="starts with the daemon"
          badge={
            p.autostart || p.isDefault ? `${glyph.ok} on` : `${glyph.bad} off`
          }
          badgeColor={p.autostart || p.isDefault ? theme.ok : theme.dim}
          activateHint="↵ toggle"
          selected={row === "autostart"}
          onPress={() => press("autostart")}
        />
      ),
    },
    {
      id: "default",
      height: 2,
      node: (
        <>
          <MenuItem
            icon="★"
            label="Default"
            description={
              p.isDefault
                ? "owns /update and /restart"
                : "↵ hands over /update and /restart"
            }
            badge={p.isDefault ? `${glyph.ok} yes` : `${glyph.bad} no`}
            badgeColor={p.isDefault ? theme.ok : theme.dim}
            activateHint="↵ change"
            selected={row === "default"}
            onPress={() => press("default")}
          />
          <Box marginBottom={1} />
        </>
      ),
    },
    {
      id: "doctor",
      height: 1,
      node: (
        <MenuItem
          icon="✚"
          label="Doctor"
          description={
            p.completeness.complete
              ? "run the checks"
              : `setup unfinished — resume at ${p.completeness.resumeAt}`
          }
          badgeColor={p.completeness.complete ? theme.ok : theme.warn}
          activateHint="↵ run"
          selected={row === "doctor"}
          onPress={() => press("doctor")}
        />
      ),
    },
  ];

  // `blocks` is in ROWS order, so the cursor indexes both.
  const view = scrollWindow(
    blocks.map((b) => b.height),
    budget,
    cursor,
  );

  return (
    <Frame
      title={["phantombot", p.name]}
      status={
        p.completeness.complete
          ? `${glyph.up} ready`
          : `${glyph.warn} setup unfinished`
      }
      footer={[
        { icon: badge.move, key: "↑↓", label: "Move" },
        { icon: badge.edit, key: "↵", label: "Edit" },
        { icon: badge.logs, key: "L", label: "Logs" },
        { icon: badge.back, key: "esc", label: "Back" },
      ]}
    >
      <Text color={theme.dim}>
        {view.above > 0 ? `▲ ${view.above} more above` : " "}
      </Text>
      {blocks.slice(view.start, view.end).map((block) => (
        <Box key={block.id} flexDirection="column">
          {block.node}
        </Box>
      ))}
      <Box flexGrow={1} />
      <Text color={theme.dim}>
        {view.below > 0 ? `▼ ${view.below} more below` : " "}
      </Text>
    </Frame>
  );
}
