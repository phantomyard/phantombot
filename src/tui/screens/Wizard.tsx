/**
 * Screen 1 — first run, the installer wizard.
 *
 * Three questions, identical to the New Persona → Create flow
 * (CreatePersona.tsx): name → one-line identity → tone. Nothing operational is
 * asked here — the persona writes no brain/channel/memory/voice overrides, so
 * it inherits the host chain and lands straight in its CONFIGURE screen, where
 * the red `required` Brain row walks the user through the rest. The old
 * six-step installer (brain/channel/memory/voice) was cut: those are Configure
 * questions, and a first-run user got an interrogation instead of a persona.
 *
 * It opens when no personas exist, and RESUMES at the identity question when
 * an existing default persona is missing its identity (the one gap the wizard
 * itself can fix — see `resolveOpeningScreen`). It ends by opening CONFIGURE
 * for the phantom it just built.
 *
 * `^q` quits via the app-global handler; on genuine first run the wizard IS
 * the app, and from the table esc backs out one question at a time.
 */

import React, { useState } from "react";

import {
  validPersonaName,
} from "../../cli/persona-new.ts";
import { EXPERTISE_OPTIONS } from "../../cli/create-persona.ts";
import type { PersonaTone } from "../../lib/personaTemplate.ts";
import {
  identityDescription,
  nameDescription,
  ownerDescription,
  skillsDescription,
  toneDescription,
} from "../components/personaQuestions.tsx";
import { AskScreen, type AskRequest } from "./Ask.tsx";
import { ChooseScreen, type ChooseRequest } from "./Choose.tsx";
import { MultiChooseScreen, type MultiChooseRequest } from "./MultiChoose.tsx";
import { DEFAULT_IDENTITY, TONE_CHOICES } from "./CreatePersona.tsx";
import type { WizardStep } from "../../lib/personaComplete.ts";

export interface WizardAnswers {
  name: string;
  /**
   * The installer asks only name/identity/tone; brain/channel/memory/voice
   * stay undefined so the persona inherits the host chain and Configure
   * finishes the setup (the same shape the three-question create flow sends).
   */
  brain?: string;
  channel?: string;
  memory?: string;
  voice?: string;
  /** One-line "who is this" for IDENTITY.md. */
  identity: string;
  /** Default tone. */
  tone: PersonaTone;
  /** What the phantom calls its principal — undefined when skipped. */
  owner?: string;
  /** Expertise rows picked from the multi-select; empty when skipped. */
  expertise?: string[];
  /** False from this screen; `applyPersona` adopts the first phantom as default. */
  makeDefault: boolean;
}

export function WizardScreen(props: {
  /** Resume point. "name" for a brand new install; "identity" for a resume. */
  startAt?: WizardStep;
  /** Pre-filled answers — carries the persona name on a resume. */
  initial?: Partial<WizardAnswers>;
  /** Existing directory names, used for inline validation before any write. */
  existingNames?: readonly string[];
  /**
   * Where esc goes from the FIRST step. Absent on genuine first run, where
   * there is no screen behind the wizard to return to — there the app-wide
   * `^q Quit` takes over (`onQuit`), because the wizard is all there is.
   */
  onBack?: () => void;
  /** Quit the app — wired when the wizard has no screen behind it. */
  onQuit?: () => void;
  onFinish: (answers: WizardAnswers) => void;
}): React.ReactElement {
  const resumed = props.startAt === "identity";
  const [step, setStep] = useState<
    "name" | "identity" | "tone" | "skills" | "owner"
  >(resumed ? "identity" : "name");
  const [name, setName] = useState(props.initial?.name ?? "");
  const [identity, setIdentity] = useState("");
  const [tone, setTone] = useState<PersonaTone>("professional");
  const [owner, setOwner] = useState("");
  const [expertise, setExpertise] = useState<string[]>([]);
  // Remounts the name AskScreen after a rejected answer, so the user edits
  // what they typed instead of staring at a box that silently ate it.
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string>();

  if (step === "name") {
    const request: AskRequest = {
      title: "Persona name",
      description: nameDescription(),
      hint: error ?? "lowercase letters, digits, '-' or '_'",
      initial: name,
    };
    return (
      <AskScreen
        key={attempt}
        request={request}
        // Genuine first run has no screen behind the name question — ^q
        // quits instead of pretending to go back.
        noBack={!props.onBack}
        onQuit={props.onBack ? undefined : props.onQuit}
        onAnswer={(value) => {
          if (value === undefined) {
            if (props.onBack) props.onBack();
            return;
          }
          const trimmed = value.trim();
          if (!validPersonaName(trimmed)) {
            setError(
              "invalid name — lowercase letters, digits, '-' or '_', starting with a letter or digit",
            );
            return setAttempt((n) => n + 1);
          }
          if (
            trimmed !== props.initial?.name?.trim() &&
            props.existingNames?.includes(trimmed)
          ) {
            setError(`'${trimmed}' already exists — pick another name`);
            return setAttempt((n) => n + 1);
          }
          setName(trimmed);
          setError(undefined);
          setStep("identity");
        }}
      />
    );
  }

  if (step === "identity") {
    const request: AskRequest = {
      title: "One-line identity",
      description: identityDescription(name),
      hint: `You are ${name || "…"}, ___`,
      initial: identity || DEFAULT_IDENTITY,
    };
    return (
      <AskScreen
        request={request}
        // A resume has no name question behind it — the persona already
        // exists, and renaming it here would create a different phantom.
        noBack={resumed}
        onQuit={resumed ? props.onQuit : undefined}
        onAnswer={(value) => {
          if (value === undefined) {
            // A resume has no name question behind it — the persona already
            // exists, and renaming it here would create a different phantom.
            if (resumed || !name) return;
            setStep("name");
            return;
          }
          setIdentity(value);
          setStep("tone");
        }}
      />
    );
  }

  const request: ChooseRequest = {
    title: "Default tone",
    options: TONE_CHOICES,
    description: toneDescription(name, identity),
  };
  if (step === "tone") {
    return (
      <ChooseScreen
        request={request}
        onAnswer={(value) => {
          if (value === undefined) return setStep("identity");
          setTone(value as PersonaTone);
          setStep("skills");
        }}
      />
    );
  }

  if (step === "skills") {
    const multiRequest: MultiChooseRequest = {
      title: "Skills & disciplines",
      options: EXPERTISE_OPTIONS,
      initial: expertise,
      description: skillsDescription(name),
    };
    return (
      <MultiChooseScreen
        request={multiRequest}
        onAnswer={(values) => {
          if (values === undefined) return setStep("tone");
          setExpertise(values);
          setStep("owner");
        }}
      />
    );
  }

  const ownerRequest: AskRequest = {
    title: "Your name",
    description: ownerDescription(name),
    hint: `what ${name} calls you`,
    initial: owner,
    allowEmpty: true,
  };
  return (
    <AskScreen
      request={ownerRequest}
      onAnswer={(value) => {
        if (value === undefined) return setStep("skills");
        setOwner(value);
        props.onFinish({
          name,
          identity,
          tone,
          owner: value || undefined,
          expertise,
          makeDefault: false,
        });
      }}
    />
  );
}
