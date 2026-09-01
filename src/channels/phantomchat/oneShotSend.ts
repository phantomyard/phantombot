/**
 * One-shot phantomchat (Nostr NIP-17 DM) send, usable OUTSIDE a live listener
 * loop.
 *
 * A running PhantomChat listener holds a long-lived relay pool on the persona's
 * own nsec; callers that are not a listener (the `phantombot notify` CLI, the
 * lifecycle broadcast applier) still need to DM a persona's contacts from that
 * same identity. This module is the shared primitive for that: build a
 * single-use pool transport from (nsec, relays), publish one gift-wrap, tear
 * the pool down. Mirrors the listener's sender rules exactly — AuthGuarded
 * pool for NIP-42 (issue #368, crash-safety issue #401), NIP-17 wrap via
 * SimplePoolPhantomchatTransport.
 *
 * The imports of the nostr-tools websocket machinery are LAZY so a module that
 * only ever sends Telegram never pulls them into its import graph.
 */

/**
 * Publish `text` as the persona (secretKey) to `recipientHex` over `relays`.
 * Injectable so tests never open sockets.
 */
export type PhantomchatOneShotSend = (args: {
  secretKey: Uint8Array;
  relays: string[];
  recipientHex: string;
  text: string;
}) => Promise<void>;

export const defaultPhantomchatOneShotSend: PhantomchatOneShotSend = async ({
  secretKey,
  relays,
  recipientHex,
  text,
}) => {
  // Lazy import keeps the nostr-tools websocket machinery out of the import
  // graph for Telegram-only callers.
  const { AuthGuardedSimplePool } = await import(
    "./authGuardedPool.ts"
  );
  const { SimplePoolPhantomchatTransport } = await import("./transport.ts");
  // NIP-42 (issue #368): answer AUTH challenges so a send to an
  // auth-requiring relay isn't silently dropped — and don't die if a relay
  // never answers the challenge we send back (issue #401).
  const pool = new AuthGuardedSimplePool(secretKey);
  const transport = new SimplePoolPhantomchatTransport(
    secretKey,
    relays,
    pool as unknown as ConstructorParameters<
      typeof SimplePoolPhantomchatTransport
    >[2],
  );
  try {
    await transport.sendMessage(recipientHex, text);
  } finally {
    transport.close();
  }
};
