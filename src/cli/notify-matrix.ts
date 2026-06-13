/**
 * `phantombot notify` — the Matrix send path.
 *
 * Split out of cli/notify.ts so the Telegram path (the common case, with voice
 * synthesis) stays untouched and the Matrix-specific concern — resolving the
 * principal's DM room from an MXID and sending there — lives on its own.
 *
 * Routing rule (#172): an unsolicited notify on Matrix must land in the
 * principal's conversation, i.e. a 1:1 DM room with each allow-listed MXID, so
 * a reply lands back in `matrix:<mxid>` (sender-scoped — see
 * orchestrator/principalRouting.ts + channels/matrix/server.ts). The send
 * therefore (a) resolves-or-creates the DM room for the MXID, then (b) sends
 * the message there. Both go through an injectable `MatrixNotifySender` so this
 * is unit-testable without an SDK, network, or crypto.
 *
 * Voice is NOT supported on Matrix here (text-only v1). A voice-only notify on
 * a Matrix default channel degrades to "voice not supported" rather than going
 * silent; a combined text+voice notify sends the text.
 */

import {
  type Config,
  type MatrixAccount,
  matrixCryptoStoreDir,
} from "../config.ts";
import type { WriteSink } from "../lib/io.ts";
import { log } from "../lib/logger.ts";

/**
 * Sends a text message to the DM room for `mxid` on `account`, resolving or
 * creating the room as needed. Production wraps a crypto-enabled SDK client;
 * tests inject a fake.
 */
export interface MatrixNotifySender {
  send(args: {
    account: MatrixAccount;
    mxid: string;
    message: string;
    /** Per-persona crypto store dir; the E2EE sender restores the device
     *  identity from its snapshot (read-only) so it sends as the bot's real
     *  device rather than minting a throwaway one. */
    cryptoStoreDir?: string;
  }): Promise<void>;
}

export interface RunMatrixNotifyInput {
  config: Config;
  message?: string;
  voice?: string;
  persona?: string;
  sender?: MatrixNotifySender;
  out: WriteSink;
  err: WriteSink;
}

export async function runMatrixNotify(
  input: RunMatrixNotifyInput,
): Promise<number> {
  const { out, err } = input;

  // Resolve the Matrix account, mirroring the Telegram persona/default rule.
  let mx: MatrixAccount | undefined;
  if (input.persona) {
    mx = input.config.channels.matrixPersonas?.[input.persona];
    if (!mx) {
      const known = Object.keys(input.config.channels.matrixPersonas ?? {});
      const hint =
        known.length > 0
          ? `known personas: ${known.join(", ")}`
          : "no persona Matrix accounts are configured";
      err.write(
        `no matrix account configured for persona '${input.persona}' — ${hint}. Run \`phantombot chat matrix --persona ${input.persona}\`, or omit --persona for the default account.\n`,
      );
      return 2;
    }
  } else {
    mx = input.config.channels.matrix;
    if (!mx) {
      err.write(
        "matrix is not configured — run `phantombot chat matrix` first.\n",
      );
      return 2;
    }
  }

  if (mx.allowedUserIds.length === 0) {
    const where = input.persona
      ? `channels.matrix.personas.${input.persona}.allowed_user_ids`
      : "channels.matrix.allowed_user_ids";
    err.write(
      `${where} is empty — refusing to broadcast. Add at least one MXID via \`phantombot chat matrix\`.\n`,
    );
    return 2;
  }

  if (input.voice && !input.message) {
    err.write("voice notifications are not supported on Matrix (text only).\n");
    return 1;
  }
  if (input.voice) {
    err.write("voice is not supported on Matrix; sending text only.\n");
  }
  if (!input.message) {
    err.write("nothing to notify — pass --message.\n");
    return 2;
  }

  const sender = input.sender ?? (await defaultMatrixSender());

  // Only the E2EE sender needs this (to restore the device snapshot); resolve
  // it defensively so a minimal/plaintext config never trips persona-dir
  // resolution. Undefined is fine — the plaintext sender ignores it.
  let cryptoStoreDir: string | undefined;
  try {
    cryptoStoreDir = matrixCryptoStoreDir(
      input.config,
      input.persona ?? input.config.defaultPersona,
    );
  } catch {
    cryptoStoreDir = undefined;
  }

  let textSent = 0;
  for (const mxid of mx.allowedUserIds) {
    try {
      await sender.send({ account: mx, mxid, message: input.message, cryptoStoreDir });
      textSent++;
    } catch (e) {
      log.warn("matrix notify: send failed", {
        mxid,
        error: (e as Error).message,
      });
    }
  }

  out.write(
    `notify: sent text=${textSent} voice=0 to ${mx.allowedUserIds.length} matrix recipients\n`,
  );
  return 0;
}

/**
 * Default production Matrix sender (matrix-bot-sdk): resolves (or creates) the
 * 1:1 DM room for the target MXID and sends the message there. Imported
 * dynamically so the SDK only loads on an actual Matrix notify. With E2EE on,
 * the message is Megolm-encrypted transparently — the Rust crypto store
 * (`<personaDir>/matrix/crypto-store/`) holds the bot's device identity.
 *
 * Concurrency note: an E2EE notify reuses the SAME crypto store as the running
 * listener (so the bot keeps one stable device — no churn). The Rust SQLite
 * store tolerates a short-lived second opener for a single send; if a future
 * homeserver/store change makes that contend, the fix is a dedicated notify
 * device, not a snapshot dance. Tracked for dogfooding.
 */
async function defaultMatrixSender(): Promise<MatrixNotifySender> {
  return {
    send: async ({ account, mxid, message, cryptoStoreDir }) => {
      const { mkdirSync } = await import("node:fs");
      const { join } = await import("node:path");
      const sdk = await import("matrix-bot-sdk");
      const {
        MatrixClient,
        SimpleFsStorageProvider,
        RustSdkCryptoStorageProvider,
        LogService,
        LogLevel,
      } = sdk;
      if (!process.env.PHANTOMBOT_MATRIX_DEBUG) {
        try {
          LogService.setLevel(LogLevel.ERROR);
        } catch {
          /* logging is best-effort */
        }
      }

      // The bot-sdk client needs a storage dir for its sync cache. Reuse the
      // per-persona Matrix dir when known; fall back to a temp dir otherwise.
      const dir =
        cryptoStoreDir ??
        join((await import("node:os")).tmpdir(), "phantombot-matrix-notify");
      mkdirSync(dir, { recursive: true });
      const storage = new SimpleFsStorageProvider(join(dir, "bot-sdk-sync.json"));
      let crypto: InstanceType<typeof RustSdkCryptoStorageProvider> | undefined;
      if (account.e2ee) {
        // `StoreType` is an ambient const enum; the runtime module is a real
        // object — read it via an any-cast (see transport.ts for the rationale).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cryptoPkg: any = await import("@matrix-org/matrix-sdk-crypto-nodejs");
        crypto = new RustSdkCryptoStorageProvider(
          join(dir, "crypto-store"),
          cryptoPkg.StoreType.Sqlite,
        );
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client: any = new MatrixClient(
        account.homeserver,
        account.accessToken,
        storage,
        crypto,
      );

      // Crypto must be prepared before an encrypted send so the DM ciphers
      // rather than UISIs. No sync loop needed — we just resolve a room + send.
      if (account.e2ee && client.crypto) {
        const joined = await client.getJoinedRooms().catch(() => []);
        await client.crypto.prepare(joined);
      }

      const roomId = await resolveOrCreateDm(client, mxid, account.e2ee === true);
      await client.sendText(roomId, message);
    },
  };
}

/**
 * The minimal client surface `resolveOrCreateDm` needs. The real bot-sdk
 * `MatrixClient` is a structural superset; the test fake implements exactly
 * these members.
 */
export interface DmResolverClient {
  getAccountData(eventType: string): Promise<Record<string, unknown> | undefined>;
  setAccountData(eventType: string, content: unknown): Promise<void>;
  createRoom(opts: Record<string, unknown>): Promise<string>;
}

/**
 * Resolve the existing 1:1 DM room for `mxid` from the bot's `m.direct`
 * account data, or create one. Kept tiny + isolated so the testable surface
 * (everything above) doesn't depend on it.
 *
 * When `encrypt` is set (the account is E2EE), a freshly created DM MUST carry
 * an `m.room.encryption` state event in its `initial_state`. matrix-bot-sdk
 * only auto-encrypts sends when `crypto.isRoomEncrypted(roomId)` sees that
 * state; a bare `createRoom` with no encryption state yields a plaintext
 * `trusted_private_chat`, so the first proactive notify to an allow-listed
 * MXID would go plaintext-over-TLS despite E2EE being configured (regression
 * caught in PR #179 review). We also persist the new room into `m.direct` so
 * the next notify reuses it (and it's recognised as a 1:1 DM) instead of
 * spawning a fresh room each time.
 */
export async function resolveOrCreateDm(
  client: DmResolverClient,
  mxid: string,
  encrypt: boolean,
): Promise<string> {
  const direct = (await client.getAccountData("m.direct").catch(() => ({}))) as
    | Record<string, unknown>
    | undefined;
  const rooms = direct?.[mxid];
  const existing = Array.isArray(rooms) ? rooms[0] : undefined;
  if (typeof existing === "string" && existing.length > 0) return existing;

  const roomId = await client.createRoom({
    invite: [mxid],
    is_direct: true,
    preset: "trusted_private_chat",
    ...(encrypt
      ? {
          initial_state: [
            {
              type: "m.room.encryption",
              state_key: "",
              content: { algorithm: "m.megolm.v1.aes-sha2" },
            },
          ],
        }
      : {}),
  });

  // Persist the freshly created DM into `m.direct` so subsequent notifies
  // resolve this same room. Best-effort: a failed write must not block the
  // send the user asked for.
  const next: Record<string, unknown> = { ...(direct ?? {}) };
  const list = Array.isArray(next[mxid]) ? [...(next[mxid] as unknown[])] : [];
  list.push(roomId);
  next[mxid] = list;
  await client.setAccountData("m.direct", next).catch(() => {
    /* best-effort m.direct persistence */
  });

  return roomId;
}
