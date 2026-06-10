/**
 * Telegram channel — PUBLIC-API BARREL (#162).
 *
 * This module used to contain the entire Telegram channel (transport,
 * parsing, group routing, channel-layer prompts, and the streaming turn
 * engine). It was split into focused submodules:
 *
 *   - core/types.ts        — channel abstraction interfaces + encryption seam
 *   - core/engine.ts       — runTelegramServer + processChatMessage (engine)
 *   - core/routing.ts      — group reply routing
 *   - core/prompts.ts      — channel-layer prompt suffixes + capture nudge
 *   - telegram/parse.ts     — Telegram message parsing + helpers
 *   - telegram/transport.ts — TelegramTransport + HttpTelegramTransport
 *   - telegram/channel.ts   — the Telegram Channel adapter (transport + parse
 *                             + capabilities + identity encrypt/decrypt hooks)
 *
 * To keep the public API EXACTLY as it was, this file re-exports every name
 * the old monolith exported, under its original identifier. Every importer
 * (src/cli/run.ts, src/cli/notify.ts, src/lib/heartbeat.ts,
 * src/lib/updateNotify.ts) and the test suite import from here unchanged.
 *
 * Do NOT remove a re-export without auditing every importer of
 * `channels/telegram.ts`.
 *
 * Original module docstring (behaviour unchanged):
 *
 * Long-polls Telegram's getUpdates, dispatches each text message through
 * runTurn, and sends the assistant reply back via sendMessage. Per-chat
 * memory uses conversation key `telegram:<chatId>` so DMs and groups are
 * isolated from the CLI's `cli:default` history.
 *
 * Streaming: we send `sendChatAction(typing)` at the start of each turn
 * and refresh it on every harness chunk. Text before a tool call is
 * classified as progress narration, but it is posted only on a timer so
 * many tool calls coalesce into one bubble. Final answers stream through
 * a markdown-aware segmenter that cuts into smaller Telegram bubbles at
 * sentence/char boundaries without splitting code fences or tables.
 *
 * Voice-out skips text streaming; after the full reply is known, it is
 * split into short voice clips.
 *
 * Auth gating: if `allowedUserIds` is empty, anyone who DMs the bot is
 * answered. We log a warning at startup so this isn't accidental.
 */

// --- Parsing + helpers (telegram/parse.ts) ---------------------------------
export {
  formatAttachmentUserText,
  inboxDir,
  extractAttachment,
  extractReplyTo,
  sanitizeEnvelopeField,
  formatReplyToContext,
  extensionFromMime,
  normalizeChatType,
  stripBotMention,
  parseGetUpdatesResult,
  REPLY_TO_SNIPPET_MAX,
} from "./telegram/parse.ts";
export type {
  TelegramAttachment,
  TelegramReplyTo,
  TelegramMessage,
} from "./telegram/parse.ts";

// --- Transport (telegram/transport.ts) -------------------------------------
export { HttpTelegramTransport } from "./telegram/transport.ts";
export type { TelegramTransport } from "./telegram/transport.ts";

// --- Group routing (core/routing.ts) ---------------------------------------
export {
  matchPersonaNames,
  decideGroupReply,
  formatGroupContext,
  GROUP_BUFFER_MAX,
} from "./core/routing.ts";

// --- Channel-layer prompts + capture nudge (core/prompts.ts) ---------------
export {
  TELEGRAM_REPLY_INSTRUCTION,
  CAPTURE_NUDGE_INTERVAL,
  CAPTURE_NUDGE_TEXT,
  captureNudgeForTurn,
  VOICE_REPLY_INSTRUCTION,
  voiceUnavailableMessage,
} from "./core/prompts.ts";

// --- Turn engine + server loop (core/engine.ts) ----------------------------
export { runTelegramServer } from "./core/engine.ts";
export type { RunTelegramServerInput } from "./core/engine.ts";
