/**
 * Google Chat adapter. STUB.
 *
 * Recommended implementation: webhook + service-account auth. Google Chat
 * doesn't have a long-poll API — you need a public-facing endpoint Google
 * can POST to, plus a service-account JWT to send messages back.
 *
 * Watch out for:
 *  - Pub/Sub vs HTTP webhook delivery — both work, HTTP is simpler.
 *  - Card vs text messages — start with text only.
 *  - Per-space and per-DM scoping. The conversation key should be the
 *    space.name (which is the Google Chat ID for the conversation).
 */

import type { ChannelAdapter, IncomingHandler, OutgoingMessage } from "./types.js";
import { log } from "../lib/logger.js";

export interface GoogleChatConfig {
  serviceAccountPath: string;
  projectId: string;
}

export class GoogleChatChannel implements ChannelAdapter {
  readonly id = "googlechat";

  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(_config: GoogleChatConfig) {}

  async start(_handler: IncomingHandler): Promise<void> {
    log.warn("GoogleChatChannel.start: not implemented", { id: this.id });
    throw new Error("GoogleChatChannel.start not implemented yet");
  }

  async stop(): Promise<void> {
    // no-op until start is implemented
  }

  async send(_msg: OutgoingMessage): Promise<void> {
    throw new Error("GoogleChatChannel.send not implemented yet");
  }
}
