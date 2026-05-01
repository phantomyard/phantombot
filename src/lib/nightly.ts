/**
 * Nightly cognitive pass.
 *
 * Runs the harness once per day in an isolated conversation
 * (`system:nightly:<YYYY-MM-DD>`) so it can never bleed into Telegram
 * chats. The harness gets the full persona BOOT.md + a focused
 * distillation directive, plus access to phantombot's memory CLI tools
 * (search / get / list / today / index) via its native Bash tool.
 *
 * Phases the harness is instructed to run (from the OpenClaw spec):
 *
 *   1. Day essence — read today's daily file, write a 2-3 line summary
 *      header at the top.
 *   2. Promote — anything tagged or worth keeping into the structured
 *      drawers (people / decisions / lessons / commitments).
 *   3. KB feed — for each durable concept, `phantombot memory search`
 *      first to dedup, then update an existing note OR create a new
 *      atomic note with frontmatter and [[wikilinks]]. Sweep kb/inbox/.
 *   4. Compress — trim MEMORY.md if bloating; clear ## Recent items
 *      that have been distilled.
 *   5. State — write a summary to memory/.nightly-state.json so the
 *      next run knows what was done.
 *
 * Phantombot just spawns this run; the cognitive work is the harness's
 * own. No phantombot-side judgment about what to keep, distill, or link.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./logger.ts";

export interface NightlyState {
  last_run?: string;
  last_status?: "ok" | "error" | "partial";
  items_promoted?: number;
  kb_notes_updated?: number;
  kb_notes_created?: number;
  errors?: string[];
}

export function nightlyConversationKey(date: string): string {
  return `system:nightly:${date}`;
}

export function nightlyStatePath(personaDir: string): string {
  return join(personaDir, "memory", ".nightly-state.json");
}

/** Read the previous nightly state. Returns {} if no prior run. */
export async function loadNightlyState(
  personaDir: string,
): Promise<NightlyState> {
  const p = nightlyStatePath(personaDir);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(await readFile(p, "utf8")) as NightlyState;
  } catch (e) {
    log.warn("nightly: state file unreadable; treating as empty", {
      error: (e as Error).message,
    });
    return {};
  }
}

/** Update the previous nightly state with a fresh run record. */
export async function saveNightlyState(
  personaDir: string,
  patch: Partial<NightlyState>,
): Promise<void> {
  const cur = await loadNightlyState(personaDir);
  const next = { ...cur, ...patch };
  await writeFile(
    nightlyStatePath(personaDir),
    JSON.stringify(next, null, 2) + "\n",
    "utf8",
  );
}

/**
 * Build the user-message that starts the nightly turn. Embeds the
 * persona name, today's date, and the 5-phase contract.
 */
export function buildNightlyPrompt(
  personaName: string,
  today: string,
): string {
  return `You are running your nightly cognitive maintenance pass for persona '${personaName}'. Today is ${today}.

This conversation is ISOLATED (conversation key system:nightly:${today}); nothing you say here will appear in Telegram or any user-facing chat. Speak in summaries, not replies.

You have access to phantombot's memory tools via Bash:

  phantombot memory today                       # path to today's daily file
  phantombot memory search "<query>"            # FTS5 + (if configured) semantic search
  phantombot memory get <persona-relative-path> # cat a file
  phantombot memory list <persona-relative-dir> # ls a dir
  phantombot memory index --rebuild             # full reindex (FTS + embeddings)

You also have your normal Read / Write / Edit tools — use them on files inside this persona's working directory (\`agentDir\`). The structured drawers are under memory/ and the KB vault under kb/. The four templates in kb/templates/ are scaffolds for atomic-note / runbook / decision / postmortem.

Run these five phases IN ORDER. Be brief in any text you write to MEMORY.md or drawers — long form goes in KB notes:

PHASE 1 — Day essence
  Read today's daily file (memory/${today}.md). If it exists, prepend a 2-3 line "Day essence" section summarising what mattered today. Skip if the file doesn't exist or is empty.

PHASE 2 — Promote to drawers
  Re-read the daily file. For each promote-able item that the heartbeat hasn't already filed:
    - People / relationships  → memory/people.md
    - Decisions with rationale → memory/decisions.md
    - Mistakes and learnings   → memory/lessons.md
    - Deadlines / obligations  → memory/commitments.md
  Append under a "## ${today}" header. Don't duplicate items the heartbeat already promoted.

PHASE 3 — Feed the KB
  Re-read the daily file for durable knowledge (procedures, configs, runbooks, concepts, decisions worth keeping).
  For each candidate:
    a) phantombot memory search "<topic>" to check for existing coverage
    b) If a note already covers the area: open and update it (add the new case, edge cases, links)
    c) Otherwise create a new atomic note in the right kb/<category>/ subdir using one of kb/templates/ as a starting point. Frontmatter required: type, tags, created, updated. Link related notes with [[wikilinks]].
  Then sweep kb/inbox/: file each stub into the right category, or delete if no longer relevant.
  Run \`phantombot memory index --rebuild\` at the end so new notes have embeddings.

PHASE 4 — Compress MEMORY.md
  MEMORY.md should stay short (orientation layer only). If it's bloated, move detail into the relevant KB note(s) and leave a short pointer. Clear items from "## Recent" that you've now distilled to a permanent home.

PHASE 5 — State report
  Write your summary to memory/.nightly-state.json (overwrite). Include:
    last_run         (ISO 8601 timestamp)
    last_status      ("ok" | "partial" | "error")
    items_promoted   (count from phase 2)
    kb_notes_updated (count from phase 3, existing-note edits)
    kb_notes_created (count from phase 3, new-note writes)
    errors           (array of strings — anything that went wrong; empty array on full success)

When you're done, your final reply (which won't go anywhere user-facing) should be a brief sentence acknowledging completion. Phantombot will log it.`;
}
