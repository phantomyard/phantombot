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
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./logger.ts";

const NIGHTLY_PROMPT_OVERRIDE = "nightly-prompt.md";

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

// ---------------------------------------------------------------------------
// Checkpointed nightly — stage model
// ---------------------------------------------------------------------------

/**
 * The nightly pass decomposed into idempotent stages. Each stage is one
 * bounded harness turn; phantombot checkpoints after every completed
 * stage to `.nightly-progress.json`. A run that times out (or the box
 * powering off) loses at most the in-flight stage — the next run resumes
 * from the checkpoint instead of redoing the whole night.
 *
 * Order matters: `essence` and `promote` read the daily file, `kb`
 * synthesises (the long pole), `compress` trims MEMORY.md, `state`
 * records counts.
 */
export type NightlyStage =
  | "essence"
  | "promote"
  | "kb"
  | "compress"
  | "state";

export const NIGHTLY_STAGES: readonly NightlyStage[] = [
  "essence",
  "promote",
  "kb",
  "compress",
  "state",
] as const;

export interface NightlyProgress {
  /** ISO date (YYYY-MM-DD) this checkpoint belongs to. */
  date: string;
  started_at: string;
  updated_at: string;
  /** Stages finished successfully, in completion order. */
  completed_stages: NightlyStage[];
  status: "in_progress" | "partial" | "complete";
  /** Message from the stage that failed/timed out, if any. */
  last_error?: string;
}

export function nightlyProgressPath(personaDir: string): string {
  return join(personaDir, "memory", ".nightly-progress.json");
}

/** Read the current checkpoint. Returns null if none exists. */
export async function loadNightlyProgress(
  personaDir: string,
): Promise<NightlyProgress | null> {
  const p = nightlyProgressPath(personaDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(await readFile(p, "utf8")) as NightlyProgress;
  } catch (e) {
    log.warn("nightly: progress file unreadable; treating as absent", {
      error: (e as Error).message,
    });
    return null;
  }
}

export async function saveNightlyProgress(
  personaDir: string,
  progress: NightlyProgress,
): Promise<void> {
  await writeFile(
    nightlyProgressPath(personaDir),
    JSON.stringify(progress, null, 2) + "\n",
    "utf8",
  );
}

/** Remove the checkpoint — called once all stages complete. */
export async function clearNightlyProgress(
  personaDir: string,
): Promise<void> {
  const p = nightlyProgressPath(personaDir);
  if (!existsSync(p)) return;
  try {
    await rm(p);
  } catch (e) {
    log.warn("nightly: could not clear progress file", {
      error: (e as Error).message,
    });
  }
}

/**
 * Given a persona dir and the date being processed, return the stages
 * still to run. Honors an existing checkpoint ONLY when it belongs to
 * the same date — a stale checkpoint from a previous day is ignored so
 * we always start a fresh day clean.
 */
export async function pendingNightlyStages(
  personaDir: string,
  today: string,
  resume: boolean,
): Promise<NightlyStage[]> {
  if (!resume) return [...NIGHTLY_STAGES];
  const progress = await loadNightlyProgress(personaDir);
  if (!progress || progress.date !== today) return [...NIGHTLY_STAGES];
  const done = new Set(progress.completed_stages);
  return NIGHTLY_STAGES.filter((s) => !done.has(s));
}

/**
 * Catch-up window: if the last nightly run was more than this many
 * milliseconds ago, a startup catch-up is warranted. Default: 24 hours.
 */
export const CATCHUP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Should a catch-up nightly run at startup?
 *
 * Returns `true` when the persona has no record of a previous nightly
 * run OR the last run was more than {@link CATCHUP_WINDOW_MS} ago.
 * Designed for users who shut down their machine overnight and miss
 * the 02:00 scheduled run.
 */
export async function shouldRunCatchupNightly(
  personaDir: string,
): Promise<boolean> {
  const state = await loadNightlyState(personaDir);
  if (!state.last_run) return true;
  const lastRun = Date.parse(state.last_run);
  if (Number.isNaN(lastRun)) return true;
  return Date.now() - lastRun > CATCHUP_WINDOW_MS;
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
 * If a persona dir contains a `nightly-prompt.md` file, use it as the
 * template (with `{{persona}}` and `{{today}}` substitutions); otherwise
 * fall back to the built-in `buildNightlyPrompt`. Lets users customize
 * the nightly directive per-persona (e.g. add a "summarize calendar
 * before phase 3" step) without forking phantombot.
 */
export async function buildNightlyPromptForPersona(
  personaDir: string,
  personaName: string,
  today: string,
): Promise<string> {
  const overridePath = join(personaDir, NIGHTLY_PROMPT_OVERRIDE);
  if (existsSync(overridePath)) {
    try {
      const tpl = await readFile(overridePath, "utf8");
      return tpl
        .replace(/\{\{persona\}\}/g, personaName)
        .replace(/\{\{today\}\}/g, today);
    } catch (e) {
      log.warn("nightly: override unreadable, falling back to default", {
        path: overridePath,
        error: (e as Error).message,
      });
    }
  }
  return buildNightlyPrompt(personaName, today);
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

PHASE 4 — Maintain MEMORY.md
  MEMORY.md is the always-in-context orientation layer — MAINTAIN it (fill AND trim), don't only trim.
    - FILL: read MEMORY.md; if there is no "## Recent" section, add one. From today's daily file and what you promoted/distilled above, add a few SHORT orientation bullets (one line each) for durable, still-relevant facts worth having in context every turn. Summarise and point to the KB note / drawer that holds the detail — don't paste whole entries.
    - TRIM: keep MEMORY.md short. Remove "## Recent" bullets that are now stale or fully distilled to a permanent home (leave a pointer if useful). If a section bloated into long-form prose, move detail into the relevant KB note(s) and leave a short pointer.

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

/**
 * Common preamble for every checkpointed nightly stage — the tools list
 * and the isolation note, shared by all five stage prompts.
 */
function nightlyStagePreamble(personaName: string, today: string): string {
  return `You are running your nightly cognitive maintenance pass for persona '${personaName}'. Today is ${today}.

This conversation is ISOLATED (conversation key system:nightly:${today}); nothing you say here will appear in Telegram or any user-facing chat. Speak in summaries, not replies.

You have access to phantombot's memory tools via Bash:

  phantombot memory today                       # path to today's daily file
  phantombot memory search "<query>"            # FTS5 + (if configured) semantic search
  phantombot memory get <persona-relative-path> # cat a file
  phantombot memory list <persona-relative-dir> # ls a dir
  phantombot memory index --rebuild             # full reindex (FTS + embeddings)

You also have your normal Read / Write / Edit tools — use them on files inside this persona's working directory. The structured drawers are under memory/ and the KB vault under kb/.

This nightly run is CHECKPOINTED: you are executing exactly ONE stage. Do only the stage described below, then stop with a one-line completion note. Do not run other phases — phantombot drives them as separate turns.`;
}

/** Per-stage instruction body. Mirrors the phases of {@link buildNightlyPrompt}. */
const NIGHTLY_STAGE_BODY: Record<NightlyStage, (today: string) => string> = {
  essence: (today) => `STAGE: DAY ESSENCE
Read today's daily file (memory/${today}.md). If it exists and is non-empty, prepend a 2-3 line "Day essence" section summarising what mattered today. If the file is missing or empty, do nothing and say so.`,
  promote: (today) => `STAGE: PROMOTE TO DRAWERS
Re-read the daily file (memory/${today}.md). For each promote-able item the heartbeat has not already filed:
  - People / relationships   → memory/people.md
  - Decisions with rationale → memory/decisions.md
  - Mistakes and learnings   → memory/lessons.md
  - Deadlines / obligations  → memory/commitments.md
Append under a "## ${today}" header. Do not duplicate items the heartbeat already promoted.`,
  kb: () => `STAGE: FEED THE KB
Re-read today's daily file for durable knowledge (procedures, configs, runbooks, concepts, decisions worth keeping). For each candidate:
  a) phantombot memory search "<topic>" to check for existing coverage
  b) If a note already covers the area, open and update it (new case, edge cases, links)
  c) Otherwise create a new atomic note in the right kb/<category>/ subdir from a kb/templates/ scaffold. Frontmatter required: type, tags, created, updated. Link related notes with [[wikilinks]].
Then sweep kb/inbox/: file each stub into the right category, or delete if no longer relevant.
Finish with \`phantombot memory index --rebuild\` so new notes get embeddings.`,
  compress: (today) => `STAGE: MAINTAIN MEMORY.md
MEMORY.md is the always-in-context orientation layer. Your job here is to MAINTAIN it — both fill and trim — not just trim.
  1. Read MEMORY.md (use your Read tool). If it has no "## Recent" section, add one.
  2. FILL: from today's daily file (memory/${today}.md) and the items you promoted/distilled in earlier stages, add a few SHORT orientation bullets under "## Recent" — only durable, still-relevant facts worth having in context every turn (current focus, active projects, fresh standing facts). One line each. Do not copy whole entries; summarise and link to the KB note or drawer that holds the detail.
  3. TRIM: MEMORY.md must stay short. Remove "## Recent" bullets that are now stale or have a permanent home in a drawer/KB note (leave a short pointer if useful). If any section has bloated into long-form prose, move that detail into the relevant KB note and leave a one-line pointer.
If today's daily file is missing or empty and nothing has changed, say so and make no edits.`,
  state: (today) => `STAGE: STATE REPORT
Write memory/.nightly-state.json (overwrite). Include:
  last_run         (ISO 8601 timestamp — now)
  last_status      ("ok" | "partial" | "error")
  items_promoted   (count of items promoted in the PROMOTE stage)
  kb_notes_updated (existing-note edits from the KB stage)
  kb_notes_created (new notes from the KB stage)
  errors           (array of strings; empty array on full success)
Use \`phantombot memory get\`/your Read tool to recall counts from this conversation's earlier stages. Phantombot also patches last_run/last_status itself, so an approximate count is fine — date ${today}.`,
};

/**
 * Build the user-message for ONE checkpointed nightly stage. Used by the
 * resumable nightly driver, which runs each stage as a separate harness
 * turn and checkpoints between them.
 */
export function buildNightlyStagePrompt(
  personaName: string,
  today: string,
  stage: NightlyStage,
): string {
  return `${nightlyStagePreamble(personaName, today)}

${NIGHTLY_STAGE_BODY[stage](today)}`;
}
