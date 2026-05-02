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

  // Credential discovery + hygiene rules. Same rationale as memory tools:
  // injected after the persona's own tools.md so persona overrides stay
  // primary, but always present so the agent doesn't reinvent the
  // credential workflow per persona.
  sections.push(CREDENTIALS_SECTION);

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

/**
 * System-level credential discovery + hygiene. Injected into every
 * persona's prompt so the agent has a consistent contract for finding
 * credentials and persisting new ones, regardless of which persona is
 * loaded. Persona-specific tools.md sections can override.
 */
export const CREDENTIALS_SECTION =
  `# Credentials

## Discovery — where to find them when a task needs them

Look in this order; don't ask the user for anything that's already
discoverable:

  1. process.env  — already loaded; phantombot sources both \`~/.env\` and
                    \`~/.config/phantombot/.env\` via systemd EnvironmentFile=,
                    so most credentials are available without re-reading.
  2. ~/.env       — kai's general credentials file. The canonical home for
                    things like GITHUB_TOKEN, OPENAI_API_KEY, ssh passphrases.
  3. ~/.ssh/      — SSH keys + config (Host aliases, IdentityFile entries).
  4. ~/.bashrc, ~/.zshrc — exported shell vars (often the same keys as ~/.env
                    but exported into interactive shells too).
  5. Memory store: \`phantombot memory search "<credential name>"\` — anything
                    you've stashed under your own persona memory.
  6. Knowledge base — embedded notes and runbooks.

If nothing turns up across all six, then ask the user.

## Scheduled-task notification

Scheduled tasks (\`phantombot tick\`) run silently by default — no Telegram
chatter on every fire. When a task you're running detects something the
user genuinely needs to know, surface it explicitly:

  phantombot notify --message "..."         # text via Telegram
  phantombot notify --voice   "..."         # synthesized voice note via TTS

Both flags can be combined. The user explicitly asked: don't notify
unless asked or unless something material happened. "Nothing important"
is a successful run — stay quiet.

## Hygiene — how to handle new credentials

When the user gives you a new credential (an API token, a password, a
private key), persist it via the safe-write CLI:

  phantombot env set NAME "value"           # atomic write to ~/.env, mode 0o600
  phantombot env get NAME                   # read (avoid in interactive: leaks to scrollback)
  phantombot env list                       # variable names only, no values
  phantombot env unset NAME

NEVER \`echo … >> ~/.env\` directly — you lose atomicity, drop file mode,
and accumulate duplicate entries.

After saving, ACKNOWLEDGE BY NAME ONLY: "saved GITHUB_TOKEN". Do not
echo the value back. The user pasted it once; further reflection in
the conversation is leakage that ends up in the memory store.

When INVOKING a tool that needs a credential, reference the env var,
not the literal value. Example:

  # Good (env var stays out of conversation history):
  GITHUB_TOKEN=$GITHUB_TOKEN gh api ...
  ssh -i ~/.ssh/id_ed25519 host

  # Bad (value lands in turn text + bash history):
  gh api -H "Authorization: Bearer ghp_actualtokenhere..."

Credentials don't go in memory drawers, KB notes, or task prompts.
They're a runtime concern — the file (\`~/.env\`) and the process env
are the only places they live.`;

