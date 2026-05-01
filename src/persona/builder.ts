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
