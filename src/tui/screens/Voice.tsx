/**
 * Screen 8 — voice.
 *
 * Two things this screen exists to fix.
 *
 * **The preview.** Today you pick `nova` blind and find out what it sounds like
 * when your phantom answers you. Being able to hear a sample before committing
 * is the whole reason to do this in a TUI.
 *
 * **The azure_edge trap.** `[voice] provider` is ONE key driving TWO
 * capabilities. `transcribe()` in `lib/audio.ts` dispatches on the same key and
 * supports exactly `elevenlabs` (scribe) and `openai` (whisper-1); everything
 * else returns "STT not supported". So `azure_edge` — the only provider that
 * needs no credential, and therefore the one a new user will reasonably pick —
 * produces a phantom that speaks but SILENTLY REJECTS EVERY VOICE NOTE sent to
 * it. That is a nasty thing to discover by sending one, so the STT row states
 * it as a live value, not a footnote.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

import { Frame, Field } from "../components/Frame.tsx";
import { badge, glyph, theme } from "../theme.ts";
import { providerHearsVoice, type VoiceProvider } from "../../lib/voice.ts";

/**
 * Providers in the order the wizard offers them: `azure_edge` leads the real
 * options because it is the only one that needs no credential.
 */
export const VOICE_PROVIDERS: VoiceProvider[] = [
  "none",
  "azure_edge",
  "openai",
  "elevenlabs",
];

export { providerHearsVoice };

export function VoiceScreen(props: {
  personaName: string;
  provider: VoiceProvider;
  voiceName?: string;
  onChangeProvider: (provider: VoiceProvider) => void;
  onPreview: () => void;
  onSave: () => void;
  onBack: () => void;
}): React.ReactElement {
  const [index, setIndex] = useState(
    Math.max(0, VOICE_PROVIDERS.indexOf(props.provider)),
  );
  const provider = VOICE_PROVIDERS[index]!;
  const hears = providerHearsVoice(provider);

  useInput((char, key) => {
    if (key.escape) return props.onBack();
    if (key.leftArrow) {
      const next = Math.max(0, index - 1);
      setIndex(next);
      props.onChangeProvider(VOICE_PROVIDERS[next]!);
    } else if (key.rightArrow) {
      const next = Math.min(VOICE_PROVIDERS.length - 1, index + 1);
      setIndex(next);
      props.onChangeProvider(VOICE_PROVIDERS[next]!);
    } else if (char === "p") props.onPreview();
    else if (key.return) props.onSave();
  });

  return (
    <Frame
      title={["phantombot", props.personaName, "voice"]}
      footer={[
        { icon: badge.change, key: "←→", label: "Change" },
        { icon: badge.preview, key: "p", label: "Preview", onPress: props.onPreview },
        { icon: badge.save, key: "↵", label: "Save" },
        { icon: badge.back, key: "esc", label: "Back" },
      ]}
    >
      <Field
        label="provider"
        value={`< ${provider} >`}
        hint={
          provider === "azure_edge"
            ? "free · no key · speaks only"
            : provider === "none"
              ? "text only"
              : "needs a key"
        }
      />
      <Field label="voice" value={props.voiceName ?? "default"} />

      <Box marginTop={1}>
        <Text color={theme.accent}>{`${glyph.play} preview  `}</Text>
        <Text color={theme.dim}>
          "Morning — three things need you today."
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Field
          label="speech out"
          value={
            provider === "none" ? (
              <Text color={theme.dim}>off</Text>
            ) : (
              <Text color={theme.ok}>{`${glyph.ok} available`}</Text>
            )
          }
        />
        <Field
          label="speech in"
          value={
            hears ? (
              <Text color={theme.ok}>{`${glyph.ok} available`}</Text>
            ) : (
              <Text color={theme.warn}>
                {`${glyph.bad} not available on ${provider} — needs openai or elevenlabs`}
              </Text>
            )
          }
        />
      </Box>

      {provider === "azure_edge" ? (
        <Box marginTop={1}>
          <Text color={theme.warn}>
            {`${glyph.warn}  azure_edge speaks but cannot hear. Every voice note you send this phantom will be rejected until an openai or elevenlabs key is added.`}
          </Text>
        </Box>
      ) : null}
    </Frame>
  );
}
