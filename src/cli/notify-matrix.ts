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
 * Default production Matrix sender: a crypto-enabled SDK client that resolves
 * (or creates) the 1:1 DM room for the target MXID and sends the message
 * there. Imported dynamically so the heavy SDK only loads on an actual Matrix
 * notify. The send is Megolm-encrypted transparently if the DM room is
 * encrypted (which a fresh DM with an E2EE-capable user will be).
 */
async function defaultMatrixSender(): Promise<MatrixNotifySender> {
  return {
    send: async ({ account, mxid, message, cryptoStoreDir }) => {
      const sdk = await import("matrix-js-sdk");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client: any = sdk.createClient({
        baseUrl: account.homeserver,
        userId: account.userId,
        deviceId: account.deviceId,
        accessToken: account.accessToken,
      });
      // Only spin up rust-crypto for an E2EE account. With E2EE on, crypto must
      // be up so the DM sends ciphertext, not a UISI. We restore the bot's
      // device identity from its snapshot in READ-ONLY mode: this short-lived
      // notify process reuses the real device (no churn) but never writes back,
      // so it can't race the long-running listener that owns the snapshot. With
      // E2EE off (the v1 default) we skip the WASM bootstrap and send plaintext.
      if (account.e2ee) {
        const {
          installPersistentIndexedDB,
          cryptoSnapshotPath,
          MATRIX_CRYPTO_DB_PREFIX,
        } = await import("../channels/matrix/idbPersist.ts");
        const { ensureCryptoWasm } = await import(
          "../channels/matrix/cryptoWasm.ts"
        );
        if (cryptoStoreDir) {
          await installPersistentIndexedDB(cryptoSnapshotPath(cryptoStoreDir), {
            readOnly: true,
          });
        }
        await ensureCryptoWasm();
        await client.initRustCrypto({
          cryptoDatabasePrefix: MATRIX_CRYPTO_DB_PREFIX,
        });
      }
      await client.startClient({ initialSyncLimit: 1 });
      try {
        const roomId = await resolveOrCreateDm(client, mxid);
        await client.sendTextMessage(roomId, message);
      } finally {
        client.stopClient();
      }
    },
  };
}

/**
 * Resolve the existing 1:1 DM room for `mxid` from the bot's `m.direct`
 * account data, or create one. Kept tiny + isolated so the testable surface
 * (everything above) doesn't depend on it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveOrCreateDm(client: any, mxid: string): Promise<string> {
  const direct = client.getAccountData?.("m.direct")?.getContent?.() ?? {};
  const existing = Array.isArray(direct[mxid]) ? direct[mxid][0] : undefined;
  if (typeof existing === "string" && existing.length > 0) return existing;
  const res = await client.createRoom({
    invite: [mxid],
    is_direct: true,
    preset: "trusted_private_chat",
  });
  return res.room_id;
}
