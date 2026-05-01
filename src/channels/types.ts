/**
 * ChannelAdapter contract. One implementation per chat platform.
 */

export interface IncomingMessage {
  /** Stable conversation key, e.g. "telegram:7995070089" or "signal:+31..." */
  conversationId: string;
  /** Platform-stable sender identifier. */
  senderId: string;
  /** Optional human-readable sender name for prompt context. */
  senderName?: string;
  /** Plain-text message body. Strip formatting at the adapter boundary. */
  text: string;
  /** Time the platform reports the message was sent (UTC). */
  timestamp: Date;
  /** Adapter-specific raw payload, for debugging. Not for orchestrator use. */
  raw?: unknown;
}

export interface OutgoingMessage {
  conversationId: string;
  text: string;
  /** Optional message ID to reply to (threading). Adapter may ignore. */
  replyToMessageId?: string;
}

export type IncomingHandler = (msg: IncomingMessage) => Promise<void>;

export interface ChannelAdapter {
  /** Stable identifier — matches the adapter file name. */
  readonly id: string;

  /** Begin receiving messages. Calls `handler` for every incoming message. */
  start(handler: IncomingHandler): Promise<void>;

  /** Graceful shutdown. Should be idempotent. */
  stop(): Promise<void>;

  /** Send an outgoing message. Returns when the platform has acknowledged. */
  send(msg: OutgoingMessage): Promise<void>;
}
