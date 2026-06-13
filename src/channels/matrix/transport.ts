/**
 * Matrix transport: the channel-agnostic `ChannelTransport` surface
 * specialized for Matrix (`MatrixTransport`), driven by a `MatrixClientLike`.
 *
 * Mirrors telegram/transport.ts — same role (low-level send/receive/control),
 * different wire. The big difference: matrix-bot-sdk + its Rust crypto addon
 * (`@matrix-org/matrix-sdk-crypto-nodejs`) handle Megolm UNDER THE HOOD. Once
 * the client has crypto prepared and the room is encrypted, `sendText`
 * transparently encrypts and inbound events arrive already decrypted (the SDK
 * emits `room.message` only after decryption). So the channel's
 * `encrypt`/`decrypt` seam hooks (see channel.ts) are near pass-throughs — the
 * SDK IS the seam. This file just exposes the SDK's send/typing/sync surface
 * behind the transport interface so the engine + tests don't touch the SDK
 * directly.
 *
 * `createRealMatrixClient` is the ONLY place the heavy SDK is imported, and it
 * is imported DYNAMICALLY so a phantombot that never configures Matrix never
 * pays the crypto init cost. Unit tests construct a `MatrixTransport` over a
 * fake `MatrixClientLike` and never reach this function.
 *
 * SINGLE-BINARY NOTE: the Rust crypto is a NAPI addon, NOT WASM. `bun build
 * --compile` statically embeds the prebuilt `.node` (see nativeCrypto.ts), so
 * this is a genuine single-file binary — no WASM bootstrap, no fake-indexeddb,
 * no on-disk snapshot dance. The whole matrix-js-sdk crypto-packaging saga is
 * gone.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { log } from "../../lib/logger.ts";
import type { ChannelTransport } from "../core/types.ts";
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
    await this.client.startClient();
  }

  stop(): void {
    this.client.stopClient();
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
 * Options for building a real, crypto-enabled Matrix client. The crypto +
 * sync state live under `cryptoStoreDir` (per-persona, next to SOUL.md — see
 * config.matrixCryptoStoreDir) so it migrates with the persona dir.
 */
export interface RealMatrixClientOptions {
  homeserver: string;
  userId: string;
  /** Vestigial under matrix-bot-sdk — the crypto store owns the device id.
   *  Kept in the options (and config) for diagnostics / forward-compat. */
  deviceId: string;
  accessToken: string;
  /** Base directory for the bot-sdk sync state + Rust crypto store
   *  (`<personaDir>/matrix/`). */
  cryptoStoreDir: string;
  /**
   * Enable end-to-end encryption. DEFAULT FALSE. When false the client is built
   * WITHOUT the Rust crypto storage provider: it talks plaintext-over-TLS (same
   * protection as the Telegram bot API). When true, a `RustSdkCryptoStorageProvider`
   * is attached and `crypto.prepare()` runs before sync — encrypted rooms then
   * "just work": no verification, no cross-signing dance, no recovery key.
   */
  e2ee?: boolean;
}

/** Filenames under the per-persona Matrix dir. */
const SYNC_STATE_FILE = "bot-sdk-sync.json";
const CRYPTO_STORE_SUBDIR = "crypto-store";

/**
 * Build a production `MatrixClientLike` backed by matrix-bot-sdk with the Rust
 * crypto addon enabled. Imported DYNAMICALLY so the SDK only loads when Matrix
 * is actually used.
 *
 * Steps:
 *   1. `SimpleFsStorageProvider` for the sync token + room cache (`<dir>/bot-sdk-sync.json`).
 *   2. When `e2ee`, a `RustSdkCryptoStorageProvider` over `<dir>/crypto-store/`
 *      — the SQLite-backed device identity + Megolm sessions. This is what makes
 *      E2EE work AND portable: copy the persona dir → keep the device + sessions.
 *   3. `AutojoinRoomsMixin` so the bot auto-accepts room invites (no manual join
 *      step — the trust gate is still the MXID allowlist in the server loop).
 *   4. `crypto.prepare()` (e2ee only) before `start()` so the device is ready.
 *
 * Unlike the retired matrix-js-sdk path there is NO WASM bootstrap, NO
 * fake-indexeddb, NO disk-snapshot dance, and NO verification/recovery-key
 * bootstrap. The Rust addon + crypto store handle all of it transparently.
 */
export async function createRealMatrixClient(
  opts: RealMatrixClientOptions,
): Promise<MatrixClientLike> {
  // Dynamic import keeps the heavy SDK out of the startup path for
  // Telegram-only installs.
  const sdk = await import("matrix-bot-sdk");
  const {
    MatrixClient,
    SimpleFsStorageProvider,
    RustSdkCryptoStorageProvider,
    AutojoinRoomsMixin,
    LogService,
    LogLevel,
  } = sdk;

  // Quiet the SDK's own log firehose unless explicitly debugging.
  if (!process.env.PHANTOMBOT_MATRIX_DEBUG) {
    try {
      LogService.setLevel(LogLevel.ERROR);
    } catch {
      /* logging is best-effort */
    }
  }

  mkdirSync(opts.cryptoStoreDir, { recursive: true });
  const storage = new SimpleFsStorageProvider(
    join(opts.cryptoStoreDir, SYNC_STATE_FILE),
  );
  let crypto: InstanceType<typeof RustSdkCryptoStorageProvider> | undefined;
  if (opts.e2ee) {
    // `StoreType` is an ambient const enum (can't be referenced under
    // verbatimModuleSyntax), but the runtime module is a real object
    // (`{ Sqlite: 0 }`) — read it through an any-cast.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cryptoPkg: any = await import("@matrix-org/matrix-sdk-crypto-nodejs");
    crypto = new RustSdkCryptoStorageProvider(
      join(opts.cryptoStoreDir, CRYPTO_STORE_SUBDIR),
      cryptoPkg.StoreType.Sqlite,
    );
  }

  const client = new MatrixClient(
    opts.homeserver,
    opts.accessToken,
    storage,
    crypto,
  );

  // Auto-accept room invites so the bot can be added to rooms with zero manual
  // steps. Answering is still gated on the MXID allowlist in the server loop,
  // so auto-join does not widen the trust perimeter.
  AutojoinRoomsMixin.setupOnClient(client);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return wrapSdkClient(client as any, opts);
}

/**
 * Adapt a real matrix-bot-sdk `MatrixClient` to our minimal `MatrixClientLike`.
 * Kept as its own function (vs inline) so the structural mapping is auditable
 * and the dynamic-import surface in `createRealMatrixClient` stays tiny.
 *
 * matrix-bot-sdk's `getUserId`, `getAccountData`, and `crypto.isRoomEncrypted`
 * are all ASYNC, but `MatrixClientLike` exposes sync `getUserId`/`isRoomEncrypted`/
 * `isDirectRoom` (the channel's push handler is synchronous). We bridge by
 * caching: the MXID comes from config (`opts.userId`); encrypted rooms are
 * learned from decrypted-event signals; direct rooms are learned from the
 * `m.direct` account data, refreshed at start and whenever it changes.
 *
 * Typed against `any` because pulling the full `MatrixClient` type here would
 * defeat the dynamic import (it'd load the type graph).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapSdkClient(client: any, opts: RealMatrixClientOptions): MatrixClientLike {
  // The MXID is known from config — seed it so `getUserId()` is correct before
  // the first sync, and so `parse.ts` can skip our own echoed messages.
  let userId: string | null = opts.userId ?? null;
  // Rooms we've observed an ENCRYPTED (then-decrypted) event in. Informational
  // for the inbound `encrypted` flag; the SDK already decrypted by the time we
  // see the message.
  const encryptedRooms = new Set<string>();
  // Rooms the bot's `m.direct` account data maps as 1:1 DMs. Load-bearing for
  // conversation keying (a principal's DM is keyed `matrix:<mxid>`).
  const directRooms = new Set<string>();

  const refreshDirect = async (): Promise<void> => {
    try {
      const direct = (await client.getAccountData("m.direct").catch(() => null)) as
        | Record<string, unknown>
        | null;
      if (!direct) return;
      directRooms.clear();
      for (const rooms of Object.values(direct)) {
        if (Array.isArray(rooms)) {
          for (const r of rooms) if (typeof r === "string") directRooms.add(r);
        }
      }
    } catch {
      /* account data not available yet — keep whatever we have */
    }
  };

  return {
    getUserId: () => userId,

    startClient: async () => {
      // Resolve the canonical MXID (config seed is usually right, but trust the
      // server if it differs).
      try {
        userId = (await client.getUserId()) ?? userId;
      } catch {
        /* keep the config seed */
      }

      // Crypto must be prepared before the sync loop starts so the device is
      // ready to decrypt/encrypt. No-op when e2ee is off (no crypto provider).
      if (opts.e2ee && client.crypto) {
        try {
          const joined = await client.getJoinedRooms().catch(() => []);
          await client.crypto.prepare(joined);
        } catch (e) {
          log.warn("matrix: crypto.prepare failed", {
            error: (e as Error).message,
          });
        }
      }

      // Learn which rooms are encrypted from decrypted-event signals.
      client.on?.("room.decrypted_event", (roomId: string) => {
        encryptedRooms.add(roomId);
      });
      // Keep the m.direct map fresh as the principal's client updates it.
      client.on?.("account_data", (ev: { type?: string }) => {
        if (ev?.type === "m.direct") void refreshDirect();
      });

      await refreshDirect();
      await client.start();
    },

    stopClient: () => {
      try {
        client.stop();
      } catch {
        /* best-effort teardown */
      }
    },

    sendTextMessage: async (roomId: string, body: string) => {
      const eventId = await client.sendText(roomId, body);
      return { event_id: eventId };
    },

    sendTyping: (roomId: string, isTyping: boolean, timeoutMs: number) =>
      client.setTyping(roomId, isTyping, timeoutMs),

    isRoomEncrypted: (roomId: string) => encryptedRooms.has(roomId),

    isDirectRoom: (roomId: string) => directRooms.has(roomId),

    onTimelineEvent: (cb: (event: MatrixTimelineEvent) => void) => {
      // matrix-bot-sdk emits "room.message" with (roomId, rawEvent) AFTER any
      // decryption, so we only ever see plaintext message events. We adapt the
      // raw event JSON into the small `MatrixTimelineEvent` projection the
      // parser consumes (keeping parse.ts SDK-agnostic + unit-testable).
      const handler = (roomId: string, rawEvent: RawMatrixEvent) => {
        cb(adaptRawEvent(roomId, rawEvent));
      };
      client.on("room.message", handler);
      return () => client.removeListener?.("room.message", handler);
    },
  };
}

/** The raw event shape matrix-bot-sdk hands `room.message` listeners. */
interface RawMatrixEvent {
  event_id?: string;
  type?: string;
  sender?: string;
  origin_server_ts?: number;
  content?: { body?: string; msgtype?: string } & Record<string, unknown>;
  unsigned?: { redacted_because?: unknown };
}

/**
 * Project a matrix-bot-sdk raw event + its room id onto the `MatrixTimelineEvent`
 * surface the parser programs against. The room id is passed separately (bot-sdk
 * gives it as the first callback arg, not on the event), so we close over it.
 */
function adaptRawEvent(roomId: string, raw: RawMatrixEvent): MatrixTimelineEvent {
  return {
    getId: () => raw.event_id,
    getType: () => raw.type ?? "",
    getSender: () => raw.sender,
    getRoomId: () => roomId,
    getTs: () => (typeof raw.origin_server_ts === "number" ? raw.origin_server_ts : 0),
    getContent: () => raw.content ?? {},
    isRedacted: () => Boolean(raw.unsigned?.redacted_because),
  };
}
