/**
 * ============================================================================
 *  CHANNEL ABSTRACTION SEAM
 * ============================================================================
 *
 * This module defines the channel-agnostic interfaces the conversational
 * core (see `core/engine.ts`) talks to. It is the seam where NEW channels
 * (Matrix, and maybe Slack / Google Chat later) slot in WITHOUT any further
 * refactor of the engine.
 *
 * The contract, in one sentence:
 *
 *   The core only ever sees PLAINTEXT, channel-agnostic messages, and only
 *   ever speaks to a channel through the `Channel` adapter.
 *
 * --- The encryption seam (READ THIS BEFORE ADDING MATRIX) ---------------------
 *
 * A `Channel` exposes `encrypt(outbound)` / `decrypt(inbound)` hooks. These
 * are the ONLY place transport-level encryption ever happens:
 *
 *   - On ingest, the adapter calls `decrypt` so the engine receives plaintext.
 *   - On egress, the adapter calls `encrypt` so the wire carries ciphertext.
 *
 * Telegram bots have NO end-to-end encryption, so Telegram's `encrypt` /
 * `decrypt` are IDENTITY PASS-THROUGHS (see `telegram/channel.ts`). An
 * encrypted channel — e.g. Matrix with Megolm — would implement these so that
 * decrypt-on-ingest / encrypt-on-egress happens HERE, leaving the core
 * completely unaware that the conversation is encrypted on the wire.
 *
 * Do NOT add any crypto code to this repo today. This file defines the SHAPE
 * of the seam only; no algorithm, no key handling, no Matrix SDK.
 *
 * --- The inbound-loop seam ----------------------------------------------------
 *
 * `Channel.listen(signal)` is the channel-agnostic inbound-message loop shape:
 * an `AsyncIterable<ChannelMessage>` a future engine can `for await` over,
 * independent of whether the underlying transport long-polls (Telegram) or
 * holds a sync stream (Matrix). It is declared here as the future seam; the
 * Telegram engine currently still drives `transport.getUpdates(...)` directly
 * (see `core/engine.ts`) because wiring `listen()` in today would risk a
 * behaviour change in the long-poll / offset-advance logic. New channels
 * should implement `listen()`; adopting it in the engine is a separate, later
 * step.
 * ============================================================================
 */

/**
 * Normalized inbound message handed to the core, independent of channel.
 *
 * `TelegramMessage` (in `telegram/parse.ts`) EXTENDS this so existing code
 * keeps compiling unchanged. Field names that the engine and tests already
 * depend on are preserved verbatim — notably `chatId` (the conversation id;
 * Telegram's numeric chat id is fine for now) and `text` (the plaintext body
 * the core reasons over).
 */
export interface ChannelMessage {
  /**
   * Conversation id. For Telegram this is the numeric chat id; for other
   * channels it is whatever uniquely keys a conversation thread. Used to
   * build the per-conversation memory key (`telegram:<chatId>`), to serialize
   * turns per chat, and to route replies back.
   */
  chatId: number;
  /**
   * The sender's stable user id within the channel. Drives allow-listing /
   * the trust perimeter.
   */
  fromUserId: number;
  /** Optional human-readable handle for the sender (logging, group labels). */
  fromUsername?: string;
  /**
   * The plaintext message body the core reasons over. For channels with
   * transport encryption this is the DECRYPTED text — the core never sees
   * ciphertext (see the encryption seam doc above).
   */
  text: string;
}

/**
 * Channel-agnostic transport surface: the low-level send / receive / control
 * operations a channel exposes. `TelegramTransport` (in `telegram/transport.ts`)
 * EXTENDS this and narrows / adds Telegram-specific bits, so
 * `HttpTelegramTransport` still satisfies it.
 *
 * Methods every channel is expected to provide are required here; capabilities
 * that not all channels share (voice, attachments, command menus, identity
 * lookup) are optional on the base so a minimal transport can omit them, and
 * callers guard with `?.`. The Telegram extension re-declares the ones
 * Telegram always provides as required.
 *
 * The inbound loop is intentionally NOT on the transport — see `Channel.listen`.
 */
export interface ChannelTransport {
  /** Send a plaintext text message to a conversation. */
  sendMessage(chatId: number, text: string): Promise<void>;
  /** Show a "typing" activity indicator (best-effort). */
  sendTyping(chatId: number): Promise<void>;
  /** Send a voice clip. Optional: not every channel supports voice. */
  sendVoice?(chatId: number, audio: Buffer, mime: string): Promise<void>;
  /** Show a "recording voice" activity indicator. Optional. */
  sendRecording?(chatId: number): Promise<void>;
  /**
   * Commit / acknowledge the inbound offset (or equivalent watermark) so a
   * restart doesn't re-deliver already-handled messages. Optional: channels
   * without an offset model can omit it.
   */
  ackUpdates?(offset: number): Promise<void>;
  /** Download an attachment / file by channel-specific id. Optional. */
  downloadFile?(fileId: string): Promise<{ data: Buffer; mime: string }>;
  /** Fetch the bot's own identity (e.g. @username). Optional. */
  getMe?(): Promise<{ ok: true; username: string } | { ok: false }>;
  /** Register the bot's command menu with the platform. Optional. */
  setMyCommands?(
    commands: Array<{ command: string; description: string }>,
  ): Promise<void>;
}

/**
 * Static feature flags for a channel. Lets the core branch on what a channel
 * can actually do without sniffing for methods. Telegram is
 * `{ voice:true, typing:true, attachments:true, encryption:false }`; a Matrix
 * channel would set `encryption:true`.
 */
export interface ChannelCapabilities {
  /** Can synthesize + send voice clips. */
  voice: boolean;
  /** Can show typing / activity indicators. */
  typing: boolean;
  /** Can receive + download file attachments. */
  attachments: boolean;
  /**
   * Transport carries end-to-end encryption — i.e. `encrypt` / `decrypt` do
   * real work rather than passing through. Telegram bots: false.
   */
  encryption: boolean;
}

/**
 * An outbound message the core wants delivered, before any transport
 * encryption. The encrypt hook turns this into whatever the wire needs.
 */
export interface OutboundMessage {
  chatId: number;
  text: string;
}

/**
 * The adapter the core talks to. Bundles a transport, a parse step, a
 * `capabilities` flag set, and the encryption seam hooks.
 *
 * `T` is the concrete transport type (e.g. `TelegramTransport`) so the Telegram
 * adapter can expose its full surface without casts.
 */
export interface Channel<T extends ChannelTransport = ChannelTransport> {
  /** Channel identifier, e.g. "telegram", "matrix". */
  readonly id: string;
  /** Static feature flags — see ChannelCapabilities. */
  readonly capabilities: ChannelCapabilities;
  /** The low-level transport this channel drives. */
  readonly transport: T;

  /**
   * ENCRYPTION SEAM (egress). Given a plaintext outbound message from the
   * core, return what should actually be sent on the wire. Telegram: identity
   * pass-through. Matrix: Megolm-encrypt here. The core NEVER does this
   * itself — it only ever produces plaintext.
   */
  encrypt(outbound: OutboundMessage): OutboundMessage | Promise<OutboundMessage>;

  /**
   * ENCRYPTION SEAM (ingest). Given a freshly-received message, return it with
   * `text` as PLAINTEXT for the core. Telegram: identity pass-through. Matrix:
   * Megolm-decrypt here. The core only ever sees the output of this hook.
   */
  decrypt(inbound: ChannelMessage): ChannelMessage | Promise<ChannelMessage>;

  /**
   * INBOUND-LOOP SEAM. The channel-agnostic inbound stream: yield each
   * normalized (and decrypted) message until `signal` aborts. New channels
   * implement this. The Telegram engine does not yet consume it (see the
   * inbound-loop seam doc at the top of this file); it remains the documented
   * future seam.
   */
  listen?(signal?: AbortSignal): AsyncIterable<ChannelMessage>;
}
