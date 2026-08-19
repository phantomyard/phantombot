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
 *   │   ├── norms.md
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
 *           ├── concept.md
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
    ["memory/people.md", drawer("People", "Contacts, relationships, dynamics. The heartbeat promotes [person]-tagged lines from the daily file into this drawer; the nightly cycle files whatever it missed. The threat judge is briefed from this drawer, so a sender documented here reads as known rather than unfamiliar.")],
    ["memory/decisions.md", drawer("Decisions", `Choices with rationale. "We chose X because Y." The heartbeat promotes [decision]-tagged lines from the daily file into this drawer; the nightly cycle files whatever it missed. The threat judge is briefed from this drawer, so a prior ruling recorded here is what stops it re-litigating something you already approved.`)],
    ["memory/lessons.md", drawer("Lessons", "Mistakes and learnings. Grows, never shrinks. The heartbeat promotes [lesson]-tagged lines from the daily file into this drawer; the nightly cycle files whatever it missed.")],
    ["memory/commitments.md", drawer("Commitments", "Deadlines and obligations. The heartbeat promotes [commitment]-tagged lines from the daily file into this drawer; the nightly cycle files whatever it missed.")],
    ["memory/norms.md", drawer("Norms", "What is ROUTINE in your owner's world. Before scoring untrusted input the threat judge is briefed from this drawer alongside decisions and people — verbatim drawer text rather than search snippets, but hard-truncated at a shared ~16 KiB byte cap that can cut mid-entry — so entries here are what stop it flagging ordinary operations as attacks. This drawer is concatenated LAST, so past the cap it is the first thing clipped — keep entries short and the drawer lean rather than exhaustive. Capture with `--tag norm`; the heartbeat promotes [norm]-tagged lines from the daily file into this drawer.")],

    ["kb/Home.md", kbHome(today)],

    ["kb/templates/concept.md", conceptTemplate()],
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
type: index
title: Knowledge Base
description: Entry point and category map for this persona's private KB.
tags: [navigation]
aliases: [KB Home, Knowledge Base Index]
created: ${today}
updated: ${today}
---

# Home

Private to this persona. Atomic notes in Open Knowledge Format — one idea
per file, linked with [[wikilinks]] into a concept graph. Every note carries
YAML frontmatter: \`type\`, \`title\`, \`description\`, \`tags\`, \`aliases\`,
\`created\`, \`updated\`. See [[templates/]] for the skeletons.

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
- [[templates/]] — note skeletons (concept, runbook, decision, postmortem)

## How to use the KB

- **Search before writing.** Run \`phantombot memory search "topic"\` first
  to avoid duplicating an existing note.
- **One idea per file.** Atomic notes are easier to link, search, and
  refactor than mega-notes.
- **Link every note.** \`[[wikilinks]]\` are the graph, and recall expands
  outward along it from a lexical match — an unlinked note is reachable only
  by exact wording. The nightly cycle adds links between newly-related notes.
- **Fill \`description\` and \`aliases\`.** Search weights frontmatter above
  body text, so aliases are what let a later query find a note using words
  you didn't happen to write.
- **Capture in inbox/.** If you're mid-task and have a half-thought,
  drop a one-liner into \`inbox/\`. The nightly cycle files or discards it.
`;
}

function conceptTemplate(): string {
  return `---
type: concept
title: <what this is>
description: <one sentence: the question this note answers>
tags: []
aliases: []
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
title: <the action this performs>
description: <one sentence: when you reach for this>
tags: [ops]
aliases: []
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
title: <the choice made>
description: <one sentence: what was decided and why>
tags: []
aliases: []
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
title: <the incident>
description: <one sentence: what broke and what fixed it>
tags: [incident]
aliases: []
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
