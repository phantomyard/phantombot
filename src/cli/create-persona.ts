/**
 * Persona creation flow — used by `phantombot persona` (the consolidated
 * subcommand) when the user picks "Create a new persona" from its menu.
 *
 * Asks a handful of questions, generates BOOT.md (and a placeholder
 * MEMORY.md), and optionally sets the new persona as default.
 *
 * Side effects live in `applyPersona`; the prompt flow is in
 * `runCreatePersona`. Tests cover applyPersona with synthetic inputs;
 * the prompt flow is verified manually.
 *
 * This file does NOT export a `defineCommand(...)` default — the
 * top-level `phantombot create-persona` subcommand was retired in
 * favor of `phantombot persona` (see src/cli/persona.ts).
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as p from "@clack/prompts";

import { type Config, loadConfig, personaDir } from "../config.ts";
import {
  generateBootMd,
  generateMemoryMdPlaceholder,
  type PersonaTemplateInput,
  type PersonaTone,
} from "../lib/personaTemplate.ts";
import {
  archivePersona,
  type ArchivedPersona,
} from "../lib/personaArchive.ts";
import type { WriteSink } from "../lib/io.ts";
import { adoptAsDefaultIfMissing } from "../lib/personaDefault.ts";
import { ensurePersonaScaffold } from "../lib/personaScaffold.ts";
import { loadState, saveState } from "../state.ts";

const TONE_OPTIONS: ReadonlyArray<{
  value: PersonaTone;
  label: string;
  hint: string;
}> = [
  { value: "blunt", label: "Blunt", hint: "concise, direct, no fluff" },
  {
    value: "professional",
    label: "Professional",
    hint: "measured and polished",
  },
  { value: "casual", label: "Casual", hint: "friendly, conversational" },
  { value: "warm", label: "Warm", hint: "supportive, empathetic" },
  { value: "playful", label: "Playful", hint: "witty, light" },
];

const EXPERTISE_OPTIONS = [
  { value: "Coding & software engineering", label: "Coding / engineering" },
  { value: "Writing & editing", label: "Writing / editing" },
  { value: "Linux sysadmin & ops", label: "Sysadmin / ops" },
  { value: "Research & analysis", label: "Research / analysis" },
  { value: "Household management", label: "Household management" },
  { value: "Scheduling & calendars", label: "Scheduling / calendars" },
  { value: "Customer support", label: "Customer support" },
];

export interface CreatePersonaResult {
  name: string;
  dir: string;
  setDefault: boolean;
  /**
   * True when the persona was adopted as default because the previously
   * configured default had no directory on disk — even though the user
   * said no to setDefault. Without this, `phantombot run` would still
   * try to load the missing previous default and fail.
   */
  adoptedAsDefault?: boolean;
  /** If an existing persona was archived to make room. */
  archived?: ArchivedPersona;
}

export async function applyPersona(
  config: Config,
  inputs: PersonaTemplateInput & { setDefault: boolean },
): Promise<CreatePersonaResult> {
  const dir = personaDir(config, inputs.name);
  let archived: ArchivedPersona | undefined;
  if (existsSync(dir)) {
    archived = await archivePersona(config.personasDir, inputs.name);
  }
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "BOOT.md"), generateBootMd(inputs), "utf8");
  await writeFile(
    join(dir, "MEMORY.md"),
    generateMemoryMdPlaceholder(inputs.name),
    "utf8",
  );
  await ensurePersonaScaffold(dir);

  let adoptedAsDefault = false;
  if (inputs.setDefault) {
    const state = await loadState();
    state.default_persona = inputs.name;
    await saveState(state);
  } else {
    adoptedAsDefault = await adoptAsDefaultIfMissing(config, inputs.name);
  }

  return {
    name: inputs.name,
    dir,
    setDefault: inputs.setDefault,
    adoptedAsDefault,
    archived,
  };
}

interface RunInput {
  config?: Config;
  out?: WriteSink;
}

export async function runCreatePersona(input: RunInput = {}): Promise<number> {
  const out = input.out ?? process.stdout;
  const config = input.config ?? (await loadConfig());

  p.intro("Create a new persona");

  const currentDefault = config.defaultPersona;
  if (existsSync(personaDir(config, currentDefault))) {
    p.note(
      `Current default: ${currentDefault}\n` +
        `(${personaDir(config, currentDefault)})`,
      "Status",
    );
  }

  const name = await p.text({
    message: "Persona name (lowercase letters, digits, '-', '_')",
    placeholder: "robbie",
    validate: (v) => {
      if (!v || v.length === 0) return "name is required";
      if (!/^[a-z0-9_-]+$/.test(v))
        return "use lowercase letters, digits, '-', '_'";
      return undefined;
    },
  });
  if (p.isCancel(name)) {
    p.cancel("cancelled");
    return 1;
  }

  const targetDir = personaDir(config, name as string);
  if (existsSync(targetDir)) {
    const overwrite = await p.confirm({
      message:
        `Persona '${name}' already exists.\n` +
        `It will be ARCHIVED to <personas-archive>/${name}-<timestamp>/\n` +
        `(restore later with phantombot import-persona). Continue?`,
      initialValue: false,
    });
    if (p.isCancel(overwrite) || !overwrite) {
      p.cancel("cancelled");
      return 1;
    }
  }

  const identity = await p.text({
    message:
      "One-line identity. (\"You are NAME, ___.\" — fill in the blank, no leading 'a/an'.)",
    placeholder: "a senior engineer who cares about correctness",
    validate: (v) => (!v || v.trim().length === 0 ? "identity is required" : undefined),
  });
  if (p.isCancel(identity)) {
    p.cancel("cancelled");
    return 1;
  }

  const tone = await p.select<PersonaTone>({
    message: "Default tone",
    options: [...TONE_OPTIONS],
  });
  if (p.isCancel(tone)) {
    p.cancel("cancelled");
    return 1;
  }

  const expertise = await p.multiselect<string>({
    message: "Areas of expertise (space to toggle)",
    options: EXPERTISE_OPTIONS,
    required: false,
  });
  if (p.isCancel(expertise)) {
    p.cancel("cancelled");
    return 1;
  }

  const hardRules = await p.text({
    message: "Hard rules (one per line — press Enter to skip)",
    placeholder: "always confirm before sending email",
    defaultValue: "",
  });
  if (p.isCancel(hardRules)) {
    p.cancel("cancelled");
    return 1;
  }

  const greeting = await p.text({
    message: "Greeting style (Enter to skip)",
    placeholder: "be direct; no small-talk",
    defaultValue: "",
  });
  if (p.isCancel(greeting)) {
    p.cancel("cancelled");
    return 1;
  }

  const setDefault = await p.confirm({
    message: `Set '${name}' as the default persona?`,
    initialValue: true,
  });
  if (p.isCancel(setDefault)) {
    p.cancel("cancelled");
    return 1;
  }

  const result = await applyPersona(config, {
    name: name as string,
    identity: identity as string,
    tone: tone as PersonaTone,
    expertise: expertise as string[],
    hardRules: hardRules as string,
    greeting: greeting as string,
    setDefault: setDefault as boolean,
  });

  if (result.archived) {
    p.note(
      `Old '${result.archived.name}' archived to:\n  ${result.archived.dir}\n\n` +
        `Restore later via: phantombot import-persona`,
      "Archived",
    );
  }

  if (result.adoptedAsDefault) {
    p.note(
      `'${result.name}' was set as default_persona because the previous default ('${config.defaultPersona}') has no persona dir on disk.`,
      "Default",
    );
  }

  p.outro(
    `Persona '${result.name}' created at ${result.dir}` +
      (result.setDefault || result.adoptedAsDefault ? " (set as default)" : ""),
  );
  out.write("");
  return 0;
}

