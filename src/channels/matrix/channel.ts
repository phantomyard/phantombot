/**
 * Matrix `Channel` adapter.
 *
 * The encrypted mirror of telegram/channel.ts. Bundles the Matrix transport,
 * the parse step, a static capabilities set, and the encryption-seam hooks —
 * and, unlike Telegram, implements `listen()` as an `AsyncIterable` over the
 * /sync timeline.
 *
 * ===========================================================================
 *  ENCRYPTION SEAM — REAL MEGOLM, BUT SDK-TRANSPARENT (READ THIS)
 * ===========================================================================
 * core/types.ts defines `encrypt(outbound)` / `decrypt(inbound)` as the ONLY
 * place transport encryption happens: decrypt-on-ingest, encrypt-on-egress,
 * so the core only ever sees plaintext. For Telegram these are identity
 * pass-throughs (no E2EE). For Matrix the work is REAL Megolm — but
 * matrix-bot-sdk + its Rust crypto addon perform it UNDER THE HOOD:
 *
 *   - INGEST: matrix-bot-sdk emits `room.message` ONLY AFTER decryption, so by
 *     the time an event reaches us it is already Megolm-DECRYPTED. So
 *     `decrypt()` receives an already-plaintext message; its job is to
 *     ASSERT/normalize that invariant, not to run a cipher.
 *   - EGRESS: `transport.sendMessage` → `client.sendText`, which the SDK
 *     transparently Megolm-ENCRYPTS for an encrypted room. So `encrypt()` is a
 *     pass-through of the plaintext OutboundMessage; the actual encryption
 *     happens at send time inside the SDK.
 *
 * So `encryption: true` is HONEST — the wire carries ciphertext — even though
 * these hooks look like pass-throughs. The cipher lives in the SDK, gated on
 * crypto being prepared (createRealMatrixClient → crypto.prepare) and the room
 * being encrypted. The hooks remain the documented seam: if we ever need to
 * touch the ciphertext boundary directly, this is where it goes.
 * ===========================================================================
 */

import type {
  Channel,
  ChannelCapabilities,
  ChannelMessage,
  OutboundMessage,
} from "../core/types.ts";
import { parseTimelineEvent } from "./parse.ts";
import type { MatrixTransport } from "./transport.ts";
import type { MatrixTimelineEvent } from "./types.ts";

/**
 * Matrix's static capabilities. Typing indicators: yes. End-to-end
 * encryption: YES (the defining difference from Telegram). Voice +
 * attachments are not wired for v1 (text-first landing), so they're false
 * until those paths exist — flipping them on later is additive.
 */
export const MATRIX_CAPABILITIES: ChannelCapabilities = {
  voice: false,
  typing: true,
  attachments: false,
  encryption: true,
};

/**
 * Build a Matrix `Channel` over a `MatrixTransport`.
 *
 * `listen(signal)` yields each decrypted, normalized inbound message until the
 * signal aborts — the channel-agnostic inbound loop from core/types.ts, which
 * Matrix DOES implement (Telegram still drives its long-poll directly). It
 * works by subscribing to the transport's timeline and pushing parsed messages
 * onto an async queue the `for await` consumer drains.
 */
export function createMatrixChannel(
  transport: MatrixTransport,
): Channel<MatrixTransport> {
  return {
    id: "matrix",
    capabilities: MATRIX_CAPABILITIES,
    transport,

    // ENCRYPTION SEAM (egress) — pass-through. The SDK Megolm-encrypts at send
    // time for encrypted rooms (see file header); the core produced plaintext
    // and that's exactly what we hand the transport.
    encrypt(outbound: OutboundMessage): OutboundMessage {
      return outbound;
    },

    // ENCRYPTION SEAM (ingest) — pass-through. The SDK already Megolm-decrypted
    // the event before it reached us; `inbound.text` is plaintext. The hook
    // exists so the core never has to know any of that happened.
    decrypt(inbound: ChannelMessage): ChannelMessage {
      return inbound;
    },

    // INBOUND-LOOP SEAM. Bridge the transport's push-based timeline callback
    // into a pull-based AsyncIterable. A bounded queue + waiter handshake means
    // a slow consumer applies natural backpressure (events accumulate in the
    // queue) without dropping messages, and an abort cleanly unsubscribes.
    async *listen(signal?: AbortSignal): AsyncIterable<ChannelMessage> {
      const selfId = transport.selfUserId();
      const queue: ChannelMessage[] = [];
      let notify: (() => void) | undefined;
      let done = false;

      const push = (event: MatrixTimelineEvent) => {
        const roomId = event.getRoomId();
        const encrypted = roomId ? transport.isEncrypted(roomId) : false;
        const msg = parseTimelineEvent(event, selfId, encrypted);
        if (!msg) return;
        queue.push(msg);
        notify?.();
      };

      const unsubscribe = transport.onEvent(push);
      const onAbort = () => {
        done = true;
        notify?.();
      };
      if (signal) {
        if (signal.aborted) {
          unsubscribe();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      try {
        while (!done) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
            notify = undefined;
            continue;
          }
          const next = queue.shift()!;
          yield next;
        }
        // Drain anything that arrived between the last yield and abort.
        while (queue.length > 0) {
          yield queue.shift()!;
        }
      } finally {
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
