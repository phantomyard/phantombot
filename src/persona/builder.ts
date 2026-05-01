/**
 * Construct the system prompt for a turn.
 *
 * Order matters. Persona first (most stable, most cacheable). Memory next.
 * Channel context (sender name, timestamp) last so the LRU prompt-cache on
 * the Anthropic side stays warm for the persona-and-memory prefix.
 */

import type { PersonaFiles } from "./loader.js";

export interface ChannelContext {
  channel: string; // 'telegram' | 'signal' | 'googlechat'
  conversationId: string;
  senderName?: string;
  timestamp: Date;
}

export function buildSystemPrompt(
  persona: PersonaFiles,
  channelCtx: ChannelContext,
  retrievedMemory?: string,
): string {
  const sections: string[] = [];

  sections.push("# Identity\n\n" + persona.boot.trim());

  if (persona.memory) {
    sections.push("# Persistent memory\n\n" + persona.memory.trim());
  }

  if (persona.tools) {
    sections.push("# Tools available to you\n\n" + persona.tools.trim());
  }

  // Always-on memory tool description + the two hard rules. Comes after
  // the persona-supplied tools.md so user customizations stay primary,
  // but always present so the harness knows the search/get/today
  // commands exist and that it should use them.
  sections.push(MEMORY_TOOLS_SECTION);

  if (retrievedMemory && retrievedMemory.trim().length > 0) {
    sections.push("# Retrieved context for this turn\n\n" + retrievedMemory.trim());
  }

  sections.push(
    "# Channel context\n\n" +
      `- Channel: ${channelCtx.channel}\n` +
      `- Conversation: ${channelCtx.conversationId}\n` +
      (channelCtx.senderName ? `- Sender: ${channelCtx.senderName}\n` : "") +
      `- Time (UTC): ${channelCtx.timestamp.toISOString()}\n`,
  );

  return sections.join("\n\n");
}

/**
 * Memory tools the harness can call from its own Bash tool, plus the
 * two always-applied rules: search-before-debug, capture-as-you-go.
 *
 * Exported for inspection / testing — also reused by the nightly prompt.
 */
export const MEMORY_TOOLS_SECTION =
  `# Memory tools

You have a four-layer memory system. Phantombot exposes the following
commands you can run from your Bash tool:

  phantombot memory today                         # path of today's daily file
  phantombot memory search "<query>" [--scope memory|kb|all] [--limit N]
                                                  # JSON results: hybrid FTS + vector
  phantombot memory get <persona-relative-path>   # cat a file
  phantombot memory list <persona-relative-dir>   # ls a dir
  phantombot memory index [--rebuild]             # refresh search index

Layout (relative to your working dir):

  memory/<YYYY-MM-DD>.md     — today's daily journal (you write to it)
  memory/people.md           — structured drawer (people / relationships)
  memory/decisions.md        — structured drawer (with rationale)
  memory/lessons.md          — structured drawer (mistakes + learnings)
  memory/commitments.md      — structured drawer (deadlines)
  kb/                        — Obsidian-shaped second brain (atomic notes)
  kb/inbox/                  — quick capture; nightly cycle files or discards
  kb/templates/              — frontmatter skeletons (atomic / runbook /
                               decision / postmortem)

Two hard rules — apply on every nontrivial task:

1. SEARCH BEFORE DEBUGGING. Run \`phantombot memory search "<topic>"\`
   first. If memory or KB has prior knowledge, use it. Investigate
   from scratch only if neither found anything.

2. CAPTURE AS YOU GO. Decisions / lessons / commitments go in today's
   daily file (\`phantombot memory today\` returns the path) — tag them
   with \`[decision]\`, \`[lesson]\`, \`[person]\`, or \`[commitment]\` so
   the heartbeat (every 30 min) and nightly cycle can promote them
   to the right drawer. KB-worthy thoughts go in
   \`kb/inbox/<short-name>.md\`. The nightly cycle files them later.

The heartbeat is mechanical (no LLM). The nightly is cognitive — that's
when KB notes get created or updated based on what you captured during
the day. Don't try to do nightly's job mid-conversation; just capture
well and the nightly cycle handles synthesis.`;

