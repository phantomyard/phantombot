/**
 * Signal channel adapter. STUB.
 *
 * Recommended implementation: talk to a local signal-cli daemon over its
 * JSON-RPC HTTP wrapper. signal-cli runs as its own process; phantombot is
 * just an HTTP client.
 *
 * Watch out for:
 *  - signal-cli memory leaks. Restart the daemon weekly via systemd timer.
 *  - Group messages don't have a stable groupId until the group has been
 *    fetched once via listGroups.
 *  - Reactions and typing indicators are separate API calls — ignore for v1.
 */

import type { ChannelAdapter, IncomingHandler, OutgoingMessage } from "./types.js";
import { log } from "../lib/logger.js";

export interface SignalConfig {
  url: string;
  number: string;
}

export class SignalChannel implements ChannelAdapter {
  readonly id = "signal";

  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(_config: SignalConfig) {}

  async start(_handler: IncomingHandler): Promise<void> {
    log.warn("SignalChannel.start: not implemented", { id: this.id });
    throw new Error("SignalChannel.start not implemented yet");
  }

  async stop(): Promise<void> {
    // no-op until start is implemented
  }

  async send(_msg: OutgoingMessage): Promise<void> {
    throw new Error("SignalChannel.send not implemented yet");
  }
}
