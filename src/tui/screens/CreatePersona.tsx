/**
 * The New Persona create flow — three questions, nothing else.
 *
 * The six-step installer wizard (Wizard.tsx) exists for FIRST RUN, where the
 * daemon needs a working brain before it can serve anyone. Adding a phantom
 * later needs none of that ceremony: identity is authored in three answers,
 * and everything operational — brain, channels, memory, voice — lives in the
 * Configure screen the flow lands on. A persona created here writes no local
 * harness overrides, so it simply inherits the host chain until Configure
 * says otherwise.
 *
 *   name → one-line identity → tone → skills → your name
 *
 * `esc` backs out one question at a time; esc on the name leaves the flow.
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

export interface CreatePersonaAnswers {
  name: string;
  identity: string;
  tone: PersonaTone;
  /** What the phantom calls its principal — undefined when skipped. */
  owner?: string;
  /** Expertise rows picked from the multi-select; empty when skipped. */
  expertise?: string[];
}

/**
 * The five tones `personaTemplate.ts` actually understands. The hints are
 * compressed from TONE_GUIDANCE there — one phrase per row, not the full
 * guidance text, so the picker stays scannable.
 */
export const TONE_CHOICES = [
  { value: "blunt", label: "Blunt", hint: "concise, direct, no fluff" },
  { value: "professional", label: "Professional", hint: "measured and polished" },
  { value: "casual", label: "Casual", hint: "friendly, conversational" },
  { value: "warm", label: "Warm", hint: "supportive, empathetic" },
  { value: "playful", label: "Playful", hint: "witty, light" },
] as const;

type Step = "name" | "identity" | "tone" | "skills" | "owner";

/**
 * The generic identity pre-filled into the identity question — deliberately
 * plain, deliberately editable: a user who just wants a working phantom
 * accepts it as-is, a user with an opinion overwrites it. Shared with the
 * first-run wizard, which asks the same three questions.
 */
export const DEFAULT_IDENTITY = "a helpful, no-nonsense assistant";

export function CreatePersonaScreen(props: {
  existingNames: readonly string[];
  onCreate: (answers: CreatePersonaAnswers) => void;
  onBack: () => void;
}): React.ReactElement {
  const [step, setStep] = useState<Step>("name");
  const [name, setName] = useState("");
  const [identity, setIdentity] = useState("");
  const [owner, setOwner] = useState("");
  const [tone, setTone] = useState<PersonaTone>("professional");
  const [expertise, setExpertise] = useState<string[]>([]);
  // Remounts the name AskScreen after a rejected answer, so the user edits
  // what they typed instead of staring at a box that silently ate it.
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string>();

  if (step === "name") {
    const request: AskRequest = {
      title: "Persona name",
      description: nameDescription(),
      hint:
        error ??
        "lowercase letters, digits, '-' or '_', starting with a letter or digit",
      initial: name,
    };
    return (
      <AskScreen
        key={attempt}
        request={request}
        onAnswer={(value) => {
          if (value === undefined) return props.onBack();
          if (!validPersonaName(value)) {
            setError(
              "invalid name — lowercase letters, digits, '-' or '_', starting with a letter or digit",
            );
            return setAttempt((n) => n + 1);
          }
          if (props.existingNames.includes(value)) {
            setError(`'${value}' already exists — pick another name`);
            return setAttempt((n) => n + 1);
          }
          setName(value);
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
      hint: `You are ${name}, ___`,
      initial: identity || DEFAULT_IDENTITY,
    };
    return (
      <AskScreen
        request={request}
        onAnswer={(value) => {
          if (value === undefined) return setStep("name");
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
        props.onCreate({
          name,
          identity,
          tone: tone as PersonaTone,
          owner: value || undefined,
          expertise,
        });
      }}
    />
  );
}
