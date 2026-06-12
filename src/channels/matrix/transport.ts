/**
 * Matrix transport: the channel-agnostic `ChannelTransport` surface
 * specialized for Matrix (`MatrixTransport`), driven by a `MatrixClientLike`.
 *
 * Mirrors telegram/transport.ts — same role (low-level send/receive/control),
 * different wire. The big difference: matrix-js-sdk + rust-crypto handle
 * Megolm UNDER THE HOOD. Once the client has crypto initialised and the room
 * is encrypted, `sendTextMessage` transparently encrypts and inbound events
 * arrive already decrypted. So the channel's `encrypt`/`decrypt` seam hooks
 * (see channel.ts) are near pass-throughs — the SDK IS the seam. This file
 * just exposes the SDK's send/typing/sync surface behind the transport
 * interface so the engine + tests don't touch the SDK directly.
 *
 * `createRealMatrixClient` is the ONLY place the heavy SDK is imported, and it
 * is imported DYNAMICALLY so a phantombot that never configures Matrix never
 * pays the crypto-WASM init cost. Unit tests construct a `MatrixTransport`
 * over a fake `MatrixClientLike` and never reach this function.
 */

import { log } from "../../lib/logger.ts";
import type { ChannelTransport } from "../core/types.ts";
import { ensureCryptoWasm } from "./cryptoWasm.ts";
import type {
  MatrixClientLike,
  MatrixTimelineEvent,
} from "./types.ts";

/** Typing-indicator lifetime sent to the server. Matrix wants an explicit
 *  timeout; 20s comfortably covers a turn's think time and auto-expires. */
const MATRIX_TYPING_TIMEOUT_MS = 20_000;

/**
 * The Matrix specialization of `ChannelTransport`. Adds a `client` handle (the
 * underlying `MatrixClientLike`) + the sync lifecycle (`start`/`stop`) and the
 * timeline subscription the server's `listen()` consumes. `sendVoice` /
 * `downloadFile` etc. are intentionally omitted for v1 (text-first, like the
 * original Telegram landing) — callers guard with `?.`.
 */
export interface MatrixTransport extends ChannelTransport {
  /** The bot's own MXID, or null before sync. */
  selfUserId(): string | null;
  /** Begin syncing the homeserver. Resolves after initial sync. */
  start(): Promise<void>;
  /** Stop syncing + release resources. */
  stop(): void;
  /** Is this room E2E-encrypted? Drives the inbound `encrypted` flag. */
  isEncrypted(roomId: string): boolean;
  /** Is this room a 1:1 DM? Drives sender-scoped keying for a principal's DM. */
  isDirect(roomId: string): boolean;
  /** Subscribe to live timeline events; returns an unsubscribe fn. */
  onEvent(cb: (event: MatrixTimelineEvent) => void): () => void;
  // Base ChannelTransport members, narrowed to required for Matrix:
  sendMessage(conversationId: string, text: string): Promise<void>;
  sendTyping(conversationId: string): Promise<void>;
}

/** Hard cap on a single message body to the server (matches Telegram's safe
 *  truncation policy: never silently drop, append a marker). Matrix has no
 *  hard 4096 limit but keeping replies bounded avoids pathological events. */
const MATRIX_BODY_MAX = 32_000;

/**
 * Concrete transport over a `MatrixClientLike`. Production passes a wrapped
 * real SDK client (`createRealMatrixClient`); tests pass a fake.
 */
export class ClientMatrixTransport implements MatrixTransport {
  constructor(private readonly client: MatrixClientLike) {}

  selfUserId(): string | null {
    return this.client.getUserId();
  }

  async start(): Promise<void> {
    // initialSyncLimit:1 keeps startup light — we don't want to replay a huge
    // backlog of historical messages as "new" inbound on boot. The server
    // additionally drops events older than its start time.
    await this.client.startClient({ initialSyncLimit: 1 });
  }

  stop(): void {
    this.client.stopClient();
    // Best-effort: persist the crypto store one last time on a clean shutdown
    // so anything written since the last debounced snapshot survives. No-op
    // (returns immediately) for a plaintext account that never installed it.
    void import("./idbPersist.ts").then((m) => m.flushSnapshot()).catch(() => {});
  }

  isEncrypted(roomId: string): boolean {
    try {
      return this.client.isRoomEncrypted(roomId);
    } catch {
      return false;
    }
  }

  isDirect(roomId: string): boolean {
    try {
      return this.client.isDirectRoom(roomId);
    } catch {
      return false;
    }
  }

  onEvent(cb: (event: MatrixTimelineEvent) => void): () => void {
    return this.client.onTimelineEvent(cb);
  }

  async sendMessage(conversationId: string, text: string): Promise<void> {
    const body =
      text.length > MATRIX_BODY_MAX
        ? text.slice(0, MATRIX_BODY_MAX) + "\n…[truncated]"
        : text;
    try {
      // For an encrypted room the SDK Megolm-encrypts this transparently —
      // the "encrypt-on-egress" half of the seam. We only ever pass plaintext.
      await this.client.sendTextMessage(conversationId, body);
    } catch (e) {
      log.warn("matrix: sendMessage failed", {
        roomId: conversationId,
        error: (e as Error).message,
      });
    }
  }

  async sendTyping(conversationId: string): Promise<void> {
    try {
      await this.client.sendTyping(
        conversationId,
        true,
        MATRIX_TYPING_TIMEOUT_MS,
      );
    } catch {
      /* typing indicator is best-effort */
    }
  }
}

/**
 * Options for building a real, crypto-enabled Matrix client. The crypto store
 * lives at `cryptoStoreDir` (per-persona, next to SOUL.md — see
 * config.matrixCryptoStoreDir) so it migrates with the persona dir.
 */
export interface RealMatrixClientOptions {
  homeserver: string;
  userId: string;
  deviceId: string;
  accessToken: string;
  /** Directory for the rust-crypto SQLite store (`<personaDir>/matrix/`). */
  cryptoStoreDir: string;
  /**
   * Enable end-to-end encryption. DEFAULT FALSE. When false, the client is
   * built WITHOUT rust-crypto: no `ensureCryptoWasm`, no `initRustCrypto`. It
   * talks plaintext-over-TLS — the v1 default that keeps the connect path off
   * the WASM-in-single-binary crypto bootstrap. Set true only for an account
   * whose config carries `e2ee = true`.
   */
  e2ee?: boolean;
}

/**
 * Build a production `MatrixClientLike` backed by matrix-js-sdk with
 * rust-crypto enabled. Imported DYNAMICALLY so the SDK + WASM only load when
 * Matrix is actually used.
 *
 * Steps:
 *   1. `ensureCryptoWasm()` — instantiate the embedded rust-crypto WASM (see
 *      cryptoWasm.ts for why this is needed under `bun --compile`). MUST run
 *      before `initRustCrypto`.
 *   2. `createClient` with the pinned device id (so the same crypto identity
 *      is reused across restarts).
 *   3. `initRustCrypto({ cryptoDatabasePrefix: cryptoStoreDir })` — opens the
 *      per-persona SQLite crypto store. This is what makes E2EE work AND makes
 *      it portable: copy the persona dir → keep the device + sessions.
 *
 * Cross-signing / secret-storage / key-backup bootstrap (the invisible-E2EE
 * setup) is done ONCE at `phantombot chat matrix` time — see cli/chat-matrix
 * + matrix/crypto.ts — not here, because that needs the user's just-entered
 * recovery context and only runs at setup, whereas this builds the runtime
 * client on every `run`.
 */
export async function createRealMatrixClient(
  opts: RealMatrixClientOptions,
): Promise<MatrixClientLike> {
  // Dynamic import keeps the heavy SDK out of the startup path for
  // Telegram-only installs.
  const sdk = await import("matrix-js-sdk");
  const client = sdk.createClient({
    baseUrl: opts.homeserver,
    userId: opts.userId,
    deviceId: opts.deviceId,
    accessToken: opts.accessToken,
  });

  if (opts.e2ee) {
    // Enable E2EE. The rust-crypto store needs IndexedDB; under `bun --compile`
    // there is none, so we install fake-indexeddb backed by a disk snapshot
    // FIRST (restores the device identity → same device across restarts, no
    // device-list churn — see idbPersist.ts). ensureCryptoWasm() MUST run
    // before initRustCrypto (see cryptoWasm.ts). All of this is skipped in the
    // plaintext default so a non-E2EE account never touches the WASM bootstrap.
    const { installPersistentIndexedDB, cryptoSnapshotPath, MATRIX_CRYPTO_DB_PREFIX } =
      await import("./idbPersist.ts");
    await installPersistentIndexedDB(cryptoSnapshotPath(opts.cryptoStoreDir));
    await ensureCryptoWasm();
    await client.initRustCrypto({ cryptoDatabasePrefix: MATRIX_CRYPTO_DB_PREFIX });
  }

  return wrapSdkClient(client);
}

/**
 * Adapt a real matrix-js-sdk `MatrixClient` to our minimal `MatrixClientLike`.
 * Kept as its own function (vs inline) so the structural mapping is auditable
 * and the dynamic-import surface in `createRealMatrixClient` stays tiny.
 *
 * Typed against `any` because pulling the full `MatrixClient` type here would
 * defeat the point of the dynamic import (it'd load the type graph). The five
 * members we touch are stable matrix-js-sdk API.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapSdkClient(client: any): MatrixClientLike {
  return {
    getUserId: () => client.getUserId(),
    startClient: (o) => client.startClient(o),
    stopClient: () => client.stopClient(),
    sendTextMessage: (roomId, body) => client.sendTextMessage(roomId, body),
    sendTyping: (roomId, isTyping, timeoutMs) =>
      client.sendTyping(roomId, isTyping, timeoutMs),
    isRoomEncrypted: (roomId) => {
      // Prefer the crypto-API check; fall back to the legacy method.
      const crypto = client.getCrypto?.();
      const room = client.getRoom?.(roomId);
      if (crypto && room) {
        // hasEncryptionStateEvent is synchronous + reliable for rust-crypto.
        return Boolean(room.hasEncryptionStateEvent?.());
      }
      return Boolean(client.isRoomEncrypted?.(roomId));
    },
    isDirectRoom: (roomId) => {
      // Primary signal: the bot's `m.direct` account data maps each DM peer
      // MXID → [roomId,…]. This is the SAME source notify-matrix.ts uses to
      // resolve the DM room, so inbound keying and outbound routing agree.
      try {
        const direct =
          client.getAccountData?.("m.direct")?.getContent?.() ?? {};
        for (const rooms of Object.values(direct)) {
          if (Array.isArray(rooms) && rooms.includes(roomId)) return true;
        }
      } catch {
        /* fall through to the member-count heuristic */
      }
      // Fallback (account data not yet synced / not set by the peer's client):
      // a 2-member room is a de-facto 1:1 DM.
      try {
        const room = client.getRoom?.(roomId);
        const count = room?.getJoinedMemberCount?.();
        return typeof count === "number" && count === 2;
      } catch {
        return false;
      }
    },
    onTimelineEvent: (cb) => {
      // matrix-js-sdk emits "Room.timeline" with (event, room, toStartOfTimeline).
      // We surface only the event; the server filters. Decryption has already
      // happened by the time a live timeline event fires for an encrypted room.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (event: any) => {
        // Skip events still pending decryption / decryption failures — the SDK
        // re-emits once decrypted, so we only act on the resolved event.
        if (event.isDecryptionFailure?.()) return;
        cb(event as MatrixTimelineEvent);
      };
      client.on("Room.timeline", handler);
      return () => client.removeListener?.("Room.timeline", handler);
    },
  };
}
