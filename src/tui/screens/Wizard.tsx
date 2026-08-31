/**
 * Screen 1 — first run, the installer wizard.
 *
 * Six steps: name → brain → channel → memory → voice → done. It opens when no
 * personas exist, and it RESUMES at the first unsatisfied requirement when the
 * default phantom is incomplete (`lib/personaComplete.ts`), with everything
 * already answered pre-filled. It never restarts from the name question for a
 * persona that already exists.
 *
 * Three correctness fixes are folded into this screen, each of which is a real
 * defect in the flow it replaces:
 *
 *   - **Gemini is not a harness.** The brain picker offers exactly the three
 *     adapters in `src/harnesses/`: claude, codex, pi. Gemini survives only as
 *     an EMBEDDING provider (`lib/geminiEmbed.ts`); offering it as a brain
 *     would produce a phantom that fails at its first turn.
 *   - **"Set as default persona?" must not default to yes.** `create-persona`
 *     offers `true`, so a user's SECOND phantom silently reassigns
 *     `default_persona` — which owns `/update` and `/restart`. Control of the
 *     box should not move on a mis-tapped Enter, so the answer defaults to
 *     `false` whenever a default already exists.
 *   - **azure_edge is TTS-only.** `[voice] provider` is one key driving two
 *     capabilities, and `transcribe()` supports only openai and elevenlabs. The
 *     screen states that at the point of choice.
 *
 * The wizard ends by dissolving into CHAT with the phantom it just built —
 * there is never a moment where the user is dropped back to a bare shell
 * wondering what happened.
 */

import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";

import { Frame } from "../components/Frame.tsx";
import { Selectable } from "../components/Selectable.tsx";
import { badge, glyph, theme } from "../theme.ts";
import { WIZARD_STEPS, type WizardStep } from "../../lib/personaComplete.ts";
import { applyTextChunk } from "../textInput.ts";
import { validPersonaName } from "../../cli/persona-new.ts";

/**
 * The three harness adapters. This list is the picker's whole vocabulary — see
 * the "gemini is not a harness" note above.
 */
export const BRAIN_OPTIONS = [
  { id: "claude", label: "Claude Code CLI" },
  { id: "codex", label: "OpenAI Codex CLI" },
  { id: "pi", label: "Pi (API routing)" },
] as const;

export const CHANNEL_OPTIONS = [
  { id: "telegram", label: "Telegram", hint: "a bot token from @BotFather" },
  { id: "chat", label: "phantomchat", hint: "encrypted, over Nostr" },
  {
    id: "cli",
    label: "CLI only",
    // Not a lesser answer: a phantom with no channel is a LOCAL phantom, and
    // it is the one you land in when the wizard finishes.
    hint: "talk to it from this terminal",
  },
] as const;

export const MEMORY_OPTIONS = [
  {
    id: "none",
    label: "no key",
    detail: "OKF lexical recall",
    hint: "works offline",
  },
  {
    id: "openai",
    label: "openai",
    detail: "text-embedding-3-small · 1536",
    hint: "needs a key",
  },
  {
    id: "gemini",
    label: "gemini",
    detail: "gemini-embedding-001 · 1536",
    hint: "needs a key",
  },
] as const;

export const VOICE_OPTIONS = [
  { id: "none", label: "not yet", detail: "text only", hears: true },
  {
    id: "azure_edge",
    label: "azure_edge",
    detail: "free, no key — speaks only",
    hears: false,
  },
  {
    id: "openai",
    label: "openai",
    detail: "tts-1 · whisper-1",
    hears: true,
  },
  {
    id: "elevenlabs",
    label: "elevenlabs",
    detail: "turbo v2.5 · scribe",
    hears: true,
  },
] as const;

export interface WizardAnswers {
  name: string;
  brain: string;
  channel: string;
  memory: string;
  voice: string;
  /** Only offered — and only ever pre-selected false — when a default exists. */
  makeDefault: boolean;
}

export const DEFAULT_ANSWERS: WizardAnswers = {
  name: "",
  brain: "claude",
  channel: "cli",
  memory: "none",
  voice: "none",
  makeDefault: false,
};

/** The dot rail: `● ─── ● ─── ○ ─── ○ ─── ○ ─── ○  step 2 of 6 · brain`. */
function Progress(props: { step: WizardStep }): React.ReactElement {
  const index = WIZARD_STEPS.indexOf(props.step);
  return (
    <Box marginBottom={1}>
      <Text color={theme.accent}>
        {WIZARD_STEPS.map((_, i) => (i <= index ? glyph.up : glyph.down)).join(
          " ─── ",
        )}
      </Text>
      <Text color={theme.dim}>
        {`  step ${index + 1} of ${WIZARD_STEPS.length} · ${props.step}`}
      </Text>
    </Box>
  );
}

function Choice(props: {
  options: readonly {
    id: string;
    label: string;
    detail?: string;
    hint?: string;
  }[];
  value: string;
  cursor: number;
  onPick: (id: string) => void;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      {props.options.map((option, i) => (
        <Selectable
          key={option.id}
          selected={i === props.cursor}
          onPress={() => props.onPick(option.id)}
        >
          <Box>
            <Box width="24%">
              <Text
                color={option.id === props.value ? theme.accent : undefined}
              >
                {`${option.id === props.value ? "◉" : "○"} ${option.id}`}
              </Text>
            </Box>
            <Box flexGrow={1}>
              <Text>{option.label}</Text>
            </Box>
            <Text color={theme.dim}>{option.detail ?? option.hint ?? ""}</Text>
          </Box>
        </Selectable>
      ))}
    </Box>
  );
}

export function WizardScreen(props: {
  /** Resume point. "name" for a brand new phantom. */
  startAt?: WizardStep;
  initial?: Partial<WizardAnswers>;
  /** True when a default persona already exists — see the default-persona fix. */
  defaultExists: boolean;
  /** Existing directory names, used for inline validation before any write. */
  existingNames?: readonly string[];
  /** Absolute root used by the review step to name the files it will create. */
  personasDir?: string;
  /**
   * Where esc goes from the FIRST step. Absent on genuine first run, where
   * there is no screen behind the wizard to return to.
   */
  onBack?: () => void;
  onFinish: (answers: WizardAnswers) => void;
  onQuit: () => void;
}): React.ReactElement {
  const [step, setStep] = useState<WizardStep>(props.startAt ?? "name");
  const [answers, setAnswers] = useState<WizardAnswers>({
    ...DEFAULT_ANSWERS,
    ...props.initial,
  });
  const [cursor, setCursor] = useState(0);
  const [nameError, setNameError] = useState<string | undefined>();
  /** The name field's live value — see the keystroke handler for why. */
  const nameRef = useRef(answers.name);

  const stepIndex = WIZARD_STEPS.indexOf(step);
  const choicesFor = (target: WizardStep): readonly { id: string }[] => {
    if (target === "brain") return BRAIN_OPTIONS;
    if (target === "channel") return CHANNEL_OPTIONS;
    if (target === "memory") return MEMORY_OPTIONS;
    if (target === "voice") return VOICE_OPTIONS;
    return [];
  };
  const go = (delta: number) => {
    const next =
      WIZARD_STEPS[
        Math.min(WIZARD_STEPS.length - 1, Math.max(0, stepIndex + delta))
      ]!;
    setStep(next);
    const selected = choicesFor(next).findIndex(
      (option) => option.id === answers[next as keyof WizardAnswers],
    );
    setCursor(Math.max(0, selected));
  };

  const optionsFor = (): readonly { id: string }[] => {
    return choicesFor(step);
  };

  useInput((char, key) => {
    // `^q` is the app-wide quit key; `^c` stays bound because a half-built
    // phantom is exactly when a user reaches for a hard exit. Neither is
    // advertised once the wizard has a screen behind it — see the footer.
    if (key.ctrl && (char === "q" || char === "c")) {
      props.onQuit();
      return;
    }
    // Back is esc everywhere, and `←` is not a back key anywhere — see the
    // menu-language rule. Within the wizard esc walks one step back; on the
    // first step it leaves the wizard, when there is somewhere to leave to.
    if (key.escape) {
      if (step !== "name") go(-1);
      else props.onBack?.();
      return;
    }
    if (step === "name") {
      if (key.return) {
        const name = answers.name.trim();
        const error = !name
          ? "Required — enter a persona name."
          : !validPersonaName(name)
            ? "Use lowercase letters, digits, '-' or '_'; start with a letter or digit."
            : name !== props.initial?.name?.trim() &&
                props.existingNames?.includes(name)
              ? `A persona named '${name}' already exists.`
              : undefined;
        setNameError(error);
        if (!error) go(1);
      } else if (key.backspace || key.delete) {
        nameRef.current = nameRef.current.slice(0, -1);
        setAnswers((a) => ({ ...a, name: nameRef.current }));
        setNameError(undefined);
      } else if (char && !key.ctrl && !key.meta) {
        // A chunk can carry its own newline (a paste, or batched keystrokes),
        // and Ink reports `key.return` only for a chunk that is exactly "\r".
        // Appending it verbatim named a persona "alice\n". See `textInput.ts`.
        //
        // Read from the REF, never from `answers`: several chunks can arrive
        // before React re-renders, and a closure-read `answers.name` is one
        // render stale — typing "alice" quickly then kept only the last
        // letters. The ref is written synchronously on every keystroke.
        const applied = applyTextChunk(nameRef.current, char);
        nameRef.current = applied.submit ?? applied.text;
        setAnswers((a) => ({ ...a, name: nameRef.current }));
        setNameError(undefined);
        if (applied.submit) {
          const name = nameRef.current.trim();
          const error = !validPersonaName(name)
            ? "Use lowercase letters, digits, '-' or '_'; start with a letter or digit."
            : name !== props.initial?.name?.trim() &&
                props.existingNames?.includes(name)
              ? `A persona named '${name}' already exists.`
              : undefined;
          setNameError(error);
          if (!error) go(1);
        }
      }
      return;
    }
    if (step === "done") {
      if (key.return) props.onFinish(answers);
      return;
    }
    const options = optionsFor();
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow)
      setCursor((c) => Math.min(options.length - 1, c + 1));
    else if (key.return) {
      const picked = options[cursor]?.id;
      if (picked) {
        setAnswers((a) => ({ ...a, [step]: picked }) as WizardAnswers);
      }
      go(1);
    }
  });

  const pick = (id: string) => {
    setAnswers((a) => ({ ...a, [step]: id }) as WizardAnswers);
    go(1);
  };

  return (
    <Frame
      // The header bar prints the version itself, so a status of
      // `0.1.0-dev · setup` repeated it — the same duplication the phantom
      // table already dropped. The crumb carries the screen's name instead:
      // this is the installer on first run and `n New` from the table after.
      title={["phantombot", props.defaultExists ? "new" : "setup"]}
      footer={[
        ...(step === "done"
          ? [{ icon: badge.chat, key: "↵", label: "Start talking" }]
          : step === "name"
            ? [{ icon: badge.continue, key: "↵", label: "Continue" }]
            : [
                { icon: badge.select, key: "↑↓", label: "Select" },
                { icon: badge.continue, key: "↵", label: "Continue" },
              ]),
        // Offered on the first step only when esc has somewhere to go: a
        // footer key that does nothing is worse than no key at all.
        ...(step !== "name" || props.onBack
          ? [{ icon: badge.back, key: "esc", label: "Back" }]
          : []),
        // Quit is advertised ONLY on genuine first run, where the wizard IS
        // the app and esc has nowhere to go. Opened from the phantom table it
        // is a wizard inside the app: leaving it means going back one screen,
        // not killing the process, so the footer offers Back and nothing else.
        ...(props.onBack
          ? []
          : [{ icon: badge.quit, key: "^q", label: "Quit" }]),
      ]}
    >
      <Progress step={step} />

      {step === "name" ? (
        <Box flexDirection="column">
          <Text>What should it be called?</Text>
          <Box
            borderStyle="round"
            borderColor={theme.dim}
            paddingX={1}
            marginY={1}
          >
            <Text>{answers.name}▌</Text>
          </Box>
          <Text color={theme.dim}>
            Required · lowercase, no spaces · becomes the persona directory
          </Text>
          {nameError ? (
            <Text color={theme.bad}>{`${glyph.bad} ${nameError}`}</Text>
          ) : null}
        </Box>
      ) : null}

      {step === "brain" ? (
        <Box flexDirection="column">
          <Text>{`Which harness should ${answers.name || "it"} think with?`}</Text>
          <Box marginY={1} flexDirection="column">
            <Choice
              options={BRAIN_OPTIONS}
              value={answers.brain}
              cursor={cursor}
              onPick={pick}
            />
          </Box>
          <Text color={theme.dim}>
            Only these three are harnesses. Gemini is an embedding provider, not
            a brain — it appears in step 4, not here.
          </Text>
        </Box>
      ) : null}

      {step === "channel" ? (
        <Box flexDirection="column">
          <Text>How will you reach it?</Text>
          <Box marginY={1} flexDirection="column">
            <Choice
              options={CHANNEL_OPTIONS}
              value={answers.channel}
              cursor={cursor}
              onPick={pick}
            />
          </Box>
          <Text color={theme.dim}>
            A phantom with no channel is not a broken phantom — it is a local
            one, and it is the screen you land in when this finishes.
          </Text>
        </Box>
      ) : null}

      {step === "memory" ? (
        <Box flexDirection="column">
          <Text>{`How should ${answers.name || "it"} remember and recall?`}</Text>
          <Box marginY={1} flexDirection="column">
            <Choice
              options={MEMORY_OPTIONS}
              value={answers.memory}
              cursor={cursor}
              onPick={pick}
            />
          </Box>
          <Box
            borderStyle="round"
            borderColor={theme.dim}
            paddingX={1}
            flexDirection="column"
          >
            <Text color={theme.dim}>
              {'"no key" gives OKF field-weighted BM25 plus link-graph '}
              expansion: frontmatter title/description/tags/aliases outrank body
              text, and a hit walks [[wikilinks]] outward. No semantic
              similarity — but markedly stronger than plain keyword search.
            </Text>
            <Text color={theme.dim}>
              You can turn embeddings on later; it re-embeds in place.
            </Text>
          </Box>
          <Text color={theme.dim}>
            openai targets api.openai.com by default — a base URL for a
            self-hosted /v1 is an advanced field, blank unless you fill it.
          </Text>
        </Box>
      ) : null}

      {step === "voice" ? (
        <Box flexDirection="column">
          <Text>{`Should ${answers.name || "it"} speak, and listen to voice notes?`}</Text>
          <Box marginY={1} flexDirection="column">
            <Choice
              options={VOICE_OPTIONS}
              value={answers.voice}
              cursor={cursor}
              onPick={pick}
            />
          </Box>
          <Text color={theme.warn}>
            azure_edge speaks but cannot hear — voice notes need an openai or
            elevenlabs key.
          </Text>
        </Box>
      ) : null}

      {step === "done" ? (
        <Box flexDirection="column">
          <Box
            borderStyle="round"
            borderColor={theme.ok}
            paddingX={1}
            flexDirection="column"
          >
            <Text
              color={theme.accent}
            >{`Review ${answers.name} — nothing has been written yet`}</Text>
            <Box marginTop={1} flexDirection="column">
              <Text>{`   brain      ${answers.brain}`}</Text>
              <Text>{`   channel    ${answers.channel}`}</Text>
              <Text>{`   memory     ${answers.memory}`}</Text>
              <Text>{`   voice      ${answers.voice}${answers.voice === "azure_edge" ? " (TTS only)" : ""}`}</Text>
              <Text>
                {`   default    ${!props.defaultExists || answers.makeDefault ? "yes — owns /update, /restart" : "no"}`}
              </Text>
            </Box>
          </Box>
          <Box marginTop={1}>
            <Text color={theme.dim}>
              {props.defaultExists
                ? "A default phantom already exists, so this one is not made default — that would move /update and /restart to it."
                : "This is your first phantom, so it owns /update and /restart."}
            </Text>
          </Box>
          <Box marginTop={1}>
            <Box flexDirection="column">
              <Text>{"Will create:"}</Text>
              <Text
                color={theme.dim}
              >{`   persona dir   ${props.personasDir ?? "<personas>"}/${answers.name}`}</Text>
              <Text color={theme.dim}>
                {"   files         identity.json · config.toml"}
              </Text>
              <Text>{`${glyph.arrow} Press Enter to create it and start talking.`}</Text>
            </Box>
          </Box>
        </Box>
      ) : null}
    </Frame>
  );
}
