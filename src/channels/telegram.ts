/**
 * Telegram channel adapter. STUB.
 *
 * Recommended implementation: long-poll via Telegram Bot API getUpdates.
 * Use either grammy (https://grammy.dev) or write a small fetch-loop
 * directly — the API surface needed (getUpdates, sendMessage, editMessageText)
 * is small enough that a no-deps implementation is reasonable.
 *
 * Watch out for:
 *  - Supergroup migration: groups switching to topics get a new chat_id with
 *    a -100 prefix. Honor `chat_migrated_to_chat_id` updates.
 *  - Rate limits: ~30 messages/sec across the bot, ~1 message/sec per chat.
 *  - Message editing: rate-limited tighter than sending. Useful for live
 *    streaming but not unlimited.
 */

import type { ChannelAdapter, IncomingHandler, OutgoingMessage } from "./types.js";
import { log } from "../lib/logger.js";

export interface TelegramConfig {
  token: string;
}

export class TelegramChannel implements ChannelAdapter {
  readonly id = "telegram";

  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(_config: TelegramConfig) {}

  async start(_handler: IncomingHandler): Promise<void> {
    log.warn("TelegramChannel.start: not implemented", { id: this.id });
    throw new Error("TelegramChannel.start not implemented yet");
  }

  async stop(): Promise<void> {
    // no-op until start is implemented
  }

  async send(_msg: OutgoingMessage): Promise<void> {
    throw new Error("TelegramChannel.send not implemented yet");
  }
}
