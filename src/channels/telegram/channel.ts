/**
 * Telegram `Channel` adapter.
 *
 * Bundles the Telegram transport, the message parse step, a static
 * capabilities flag set, and the encryption-seam hooks into a single
 * `Channel` object the core can talk to (see core/types.ts).
 *
 * ===========================================================================
 *  ENCRYPTION SEAM — IDENTITY PASS-THROUGHS (DO NOT ADD CRYPTO HERE TODAY)
 * ===========================================================================
 * Telegram bots have NO end-to-end encryption, so `encrypt` / `decrypt` here
 * are NO-OPS that return their input unchanged. The hooks EXIST so that an
 * encrypted channel (e.g. Matrix with Megolm) can decrypt-on-ingest /
 * encrypt-on-egress at exactly this boundary WITHOUT touching the core — the
 * core only ever produces and consumes plaintext.
 *
 * Do NOT add any crypto, key handling, or Matrix code to this file today.
 * This adapter is the place a future encrypted channel mirrors; it stays a
 * pure pass-through for Telegram.
 * ===========================================================================
 *
 * Note: this adapter is exported additively. The current engine
 * (core/engine.ts) still drives `transport.getUpdates(...)` directly and does
 * NOT yet consume `Channel.listen()` / the encrypt/decrypt hooks — wiring that
 * in is a later, separate step (see the seam docs in core/types.ts), kept out
 * of this refactor to guarantee zero behaviour change.
 */

import type {
  Channel,
  ChannelCapabilities,
  ChannelMessage,
  OutboundMessage,
} from "../core/types.ts";
import { HttpTelegramTransport, type TelegramTransport } from "./transport.ts";

/**
 * Telegram's static capabilities. Telegram bots support voice notes, typing
 * indicators, and file attachments, but have NO end-to-end encryption — hence
 * `encryption: false` and the identity encrypt/decrypt hooks below.
 */
export const TELEGRAM_CAPABILITIES: ChannelCapabilities = {
  voice: true,
  typing: true,
  attachments: true,
  encryption: false,
};

/**
 * Build a Telegram `Channel` over an HTTP transport for `token`.
 *
 * The returned adapter exposes the transport, the capabilities flags, and the
 * encryption-seam hooks. The hooks are identity pass-throughs (see the file
 * header): Telegram carries no E2EE.
 *
 * `listen()` is intentionally OMITTED for now — the engine still drives the
 * transport's long-poll directly; adopting `listen()` is a future step that
 * would change the offset-advance loop, which this refactor avoids.
 */
export function createTelegramChannel(
  token: string,
  transport: TelegramTransport = new HttpTelegramTransport(token),
): Channel<TelegramTransport> {
  return {
    id: "telegram",
    capabilities: TELEGRAM_CAPABILITIES,
    transport,
    // ENCRYPTION SEAM (egress) — identity. Telegram has no E2EE; the plaintext
    // the core produced goes straight to the wire. A Matrix adapter would
    // Megolm-encrypt here instead.
    encrypt(outbound: OutboundMessage): OutboundMessage {
      return outbound;
    },
    // ENCRYPTION SEAM (ingest) — identity. Telegram delivers plaintext; nothing
    // to decrypt. A Matrix adapter would Megolm-decrypt here so the core only
    // ever sees plaintext.
    decrypt(inbound: ChannelMessage): ChannelMessage {
      return inbound;
    },
  };
}
