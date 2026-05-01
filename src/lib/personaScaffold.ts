/**
 * Persona-dir scaffolding.
 *
 * Ensures every persona directory has the OpenClaw-shaped layout the
 * memory system expects:
 *
 *   <personaDir>/
 *   ├── memory/
 *   │   ├── people.md
 *   │   ├── decisions.md
 *   │   ├── lessons.md
 *   │   ├── commitments.md
 *   │   └── archive/
 *   └── kb/
 *       ├── Home.md
 *       ├── inbox/
 *       ├── concepts/
 *       ├── runbooks/
 *       ├── procedures/
 *       ├── decisions/
 *       ├── infra/
 *       ├── people/
 *       ├── projects/
 *       ├── postmortems/
 *       └── templates/
 *           ├── atomic-note.md
 *           ├── runbook.md
 *           ├── decision.md
 *           └── postmortem.md
 *
 * Idempotent: running twice never overwrites existing files. Used by
 * `phantombot create-persona` and `phantombot import-persona`.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ScaffoldResult {
  /** Files we just created (relative to personaDir). */
  created: string[];
  /** Files that were already present (skipped). */
  skipped: string[];
}

const KB_SUBDIRS = [
  "inbox",
  "concepts",
  "runbooks",
  "procedures",
  "decisions",
  "infra",
  "people",
  "projects",
  "postmortems",
  "templates",
];

const MEMORY_SUBDIRS = ["archive"];

export async function ensurePersonaScaffold(
  personaDir: string,
): Promise<ScaffoldResult> {
  const created: string[] = [];
  const skipped: string[] = [];

  // Create memory/ tree
  await mkdir(join(personaDir, "memory"), { recursive: true });
  for (const sub of MEMORY_SUBDIRS) {
    await mkdir(join(personaDir, "memory", sub), { recursive: true });
  }

  // Create kb/ tree
  await mkdir(join(personaDir, "kb"), { recursive: true });
  for (const sub of KB_SUBDIRS) {
    await mkdir(join(personaDir, "kb", sub), { recursive: true });
  }

  // Stamp the seed files (idempotent).
  const today = new Date().toISOString().slice(0, 10);
  for (const [rel, body] of seedFiles(today)) {
    const full = join(personaDir, rel);
    if (existsSync(full)) {
      skipped.push(rel);
      continue;
    }
    await writeFile(full, body, "utf8");
    created.push(rel);
  }

  return { created, skipped };
}

function seedFiles(today: string): Array<[string, string]> {
  return [
    ["memory/people.md", drawer("People", "Contacts, relationships, dynamics. The nightly cycle promotes [person]-tagged entries from daily files to here.")],
    ["memory/decisions.md", drawer("Decisions", `Choices with rationale. "We chose X because Y." Promoted from daily files by the nightly cycle.`)],
    ["memory/lessons.md", drawer("Lessons", "Mistakes and learnings. Grows, never shrinks.")],
    ["memory/commitments.md", drawer("Commitments", "Deadlines and obligations. The nightly cycle promotes [commitment]-tagged entries.")],

    ["kb/Home.md", kbHome(today)],

    ["kb/templates/atomic-note.md", atomicTemplate()],
    ["kb/templates/runbook.md", runbookTemplate()],
    ["kb/templates/decision.md", decisionTemplate()],
    ["kb/templates/postmortem.md", postmortemTemplate()],
  ];
}

function drawer(title: string, intro: string): string {
  return `# ${title}\n\n${intro}\n\n## (no entries yet)\n`;
}

function kbHome(today: string): string {
  return `---
type: home
tags: [navigation]
created: ${today}
updated: ${today}
---

# Home

Atomic notes — one idea per file, linked with [[wikilinks]]. Every
note carries YAML frontmatter (\`type\`, \`tags\`, \`created\`, \`updated\`).

## Categories

- [[concepts/]] — conceptual atoms (definitions, mental models)
- [[runbooks/]] — step-by-step ops procedures
- [[procedures/]] — repeatable workflows
- [[decisions/]] — choices with rationale
- [[infra/]] — infrastructure (hosts, services, configs)
- [[people/]] — contacts and relationships
- [[projects/]] — current work
- [[postmortems/]] — incident writeups
- [[inbox/]] — quick captures pending nightly filing
- [[templates/]] — note skeletons (atomic-note, runbook, decision, postmortem)

## How to use the KB

- **Search before writing.** Run \`phantombot memory search "topic"\` first
  to avoid duplicating an existing note.
- **One idea per file.** Atomic notes are easier to link, search, and
  refactor than mega-notes.
- **Link freely.** \`[[wikilinks]]\` build the graph. The nightly cycle
  adds links between newly-related notes.
- **Capture in inbox/.** If you're mid-task and have a half-thought,
  drop a one-liner into \`inbox/\`. The nightly cycle files or discards it.
`;
}

function atomicTemplate(): string {
  return `---
type: concept
tags: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
---

# Title

One idea per note. Link related notes with [[wikilinks]].

## Why this exists


## Notes


## Related
- [[ ]]
`;
}

function runbookTemplate(): string {
  return `---
type: runbook
tags: [ops]
created: YYYY-MM-DD
updated: YYYY-MM-DD
---

# Runbook: <action>

## Trigger
What situation calls for this runbook.

## Prerequisites
- [ ] Access to X
- [ ] Knowledge of Y

## Steps
1.
2.
3.

## Verification
How you confirm it worked.

## Rollback
What to do if a step fails.

## Related
- [[ ]]
`;
}

function decisionTemplate(): string {
  return `---
type: decision
tags: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
---

# Decision: <topic>

## Context
What forced this decision now.

## Options considered

### Option A


### Option B


## Decision
We chose X because Y.

## Trade-offs accepted


## Revisit when

`;
}

function postmortemTemplate(): string {
  return `---
type: postmortem
tags: [incident]
created: YYYY-MM-DD
updated: YYYY-MM-DD
---

# Postmortem: <incident>

## Timeline


## Root cause


## Impact


## What went well


## What didn't


## Action items
- [ ]
`;
}
