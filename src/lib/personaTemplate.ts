/**
 * Generate the BOOT.md / MEMORY.md content for a freshly-created persona.
 * Pure function — keeps `phantombot create-persona` testable without mocking
 * the @clack/prompts TUI.
 */

export interface PersonaTemplateInput {
  name: string;
  /** One-line description: "a senior engineer who...". The "You are NAME, " prefix is added. */
  identity: string;
  tone: PersonaTone;
  expertise: readonly string[];
  /** Optional, free-form. Each line becomes a bullet. */
  hardRules: string;
  /** Optional, free-form. */
  greeting: string;
}

export type PersonaTone =
  | "blunt"
  | "professional"
  | "casual"
  | "warm"
  | "playful";

const TONE_GUIDANCE: Record<PersonaTone, string> = {
  blunt: "Concise, direct, no padding. Skip pleasantries; lead with the answer.",
  professional:
    "Measured and polished. Use precise language; avoid jargon when a plain word will do.",
  casual: "Friendly and conversational. First-person OK; idioms welcome.",
  warm: "Supportive and empathetic. Acknowledge what the user is dealing with before diving in.",
  playful:
    "Witty and light. A small joke is fine; avoid cynicism or punching down.",
};

export function generateBootMd(input: PersonaTemplateInput): string {
  const sections: string[] = [];

  sections.push(`# ${input.name}\n\nYou are ${input.name}, ${input.identity.trim()}.`);

  sections.push(
    `## How you respond\n\n- Tone: **${input.tone}** — ${TONE_GUIDANCE[input.tone]}`,
  );

  if (input.expertise.length > 0) {
    sections.push(
      `## Areas of expertise\n\n` +
        input.expertise.map((e) => `- ${e}`).join("\n"),
    );
  }

  const ruleLines = input.hardRules
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (ruleLines.length > 0) {
    sections.push(
      `## Hard rules\n\n` + ruleLines.map((l) => `- ${l}`).join("\n"),
    );
  }

  if (input.greeting.trim().length > 0) {
    sections.push(`## Greeting\n\n${input.greeting.trim()}`);
  }

  sections.push(
    `## Tools\n\nYou have whatever tools the harness provides (Bash, Read, Write, web fetch, etc.). Use them directly. Don't ask permission for read-only actions.`,
  );

  return sections.join("\n\n") + "\n";
}

export function generateMemoryMdPlaceholder(name: string): string {
  return `# ${name} — persistent memory\n\nNotes here are always in ${name}'s working memory across every turn. Keep this file under a few KB; everything written here is on every turn.\n\n_Add facts ${name} should always remember about the user, environment, and standing preferences._\n`;
}
