/**
 * `phantombot chat matrix` — interactive setup for the Matrix channel.
 *
 * THE INVISIBLE-E2EE WIZARD. Per the principal's hard requirement, this asks
 * EXACTLY THREE things: homeserver, username, password. Nothing about E2EE,
 * recovery keys, or device verification ever reaches the user. Everything else
 * happens under the hood:
 *
 *   1. Password login → access token + device id; the PASSWORD IS DISCARDED
 *      (never written anywhere).
 *   2. rust-crypto is initialised against the per-persona crypto store
 *      (`<personaDir>/matrix/`, next to SOUL.md — migrates with the persona).
 *   3. Cross-signing + secret storage + key backup are auto-bootstrapped, and
 *      a recovery key is generated AUTOMATICALLY and stored as
 *      MATRIX_RECOVERY_KEY in ~/.env via `phantombot env set` (never echoed,
 *      never shown).
 *   4. The token + device id + MXID land in `[channels.matrix]` (or
 *      `[channels.matrix.personas.<persona>]`) in config.toml.
 *
 * Migration contract: copy the persona dir → keep the crypto store (same
 * device, no re-verification). A fresh restore uses MATRIX_RECOVERY_KEY to
 * recover key backup. Both pieces are portable and agent-managed.
 *
 * The setup core (`runChatMatrixSetup`) takes injectable seams (login, client
 * factory, crypto bootstrap, env writer) so it's unit-testable with no
 * homeserver / HTTP / WASM.
 */

import { defineCommand } from "citty";
import * as p from "@clack/prompts";

import {
  type Config,
  loadConfig,
  matrixCryptoStoreDir,
  personaEnvSuffix,
} from "../config.ts";
import {
  bootstrapInvisibleE2ee,
  type MatrixCryptoLike,
} from "../channels/matrix/crypto.ts";
import {
  realMatrixLogin,
  type MatrixLoginFn,
} from "../channels/matrix/login.ts";
import { getIn, setIn, updateConfigToml } from "../lib/configWriter.ts";
import { runEnvSet } from "./env.ts";
import type { WriteSink } from "../lib/io.ts";
import { log } from "../lib/logger.ts";
import { defaultServiceControl, type ServiceControl } from "../lib/platform.ts";
import { maybePromptRestart } from "./harness.ts";

/**
 * Parse a comma/space-separated list of trusted Matrix IDs into a clean,
 * de-duplicated MXID array — the Matrix equivalent of Telegram's
 * `parseAllowedUserIds`. MXIDs are strings (`@localpart:server`), not numbers.
 * Entries that don't look like an MXID are returned separately as `invalid` so
 * the caller can warn rather than silently writing garbage into the allowlist.
 */
export function parseAllowedMxids(raw: string): {
  ids: string[];
  invalid: string[];
} {
  const tokens = (raw ?? "")
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const ids: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    // A valid MXID is `@localpart:domain`. Be lenient on the localpart/domain
    // charset (homeservers vary) but require the @…:… shape.
    if (/^@[^:\s]+:[^:\s]+$/.test(t)) {
      if (!seen.has(t)) {
        seen.add(t);
        ids.push(t);
      }
    } else {
      invalid.push(t);
    }
  }
  return { ids, invalid };
}

/** The crypto-enabling client the setup needs after login. A thin seam so the
 *  wizard can be tested without a real SDK client / WASM. */
export interface MatrixSetupClient {
  /** Initialise rust-crypto against the per-persona store dir. */
  initCrypto(cryptoStoreDir: string): Promise<void>;
  /** The CryptoApi to bootstrap cross-signing/secret-storage on. */
  crypto(): MatrixCryptoLike;
  /** UIA callback that re-auths the cross-signing key upload with the
   *  just-used password. Built by the factory so this module never holds the
   *  password. */
  authUploadCallback(): (
    makeRequest: (authData: unknown) => Promise<unknown>,
  ) => Promise<void>;
  /** Release the client after setup. */
  stop(): void;
}

export interface ChatMatrixSetupInput {
  config: Config;
  /** Persona this Matrix account binds to. Default account → defaultPersona;
   *  a named persona → the `[channels.matrix.personas.<persona>]` block. */
  persona: string;
  /** Whether to write the per-persona block vs the default block. */
  perPersona: boolean;
  /**
   * Bootstrap + persist end-to-end encryption. DEFAULT FALSE. When false the
   * setup is login → write config only: no crypto client, no WASM, no recovery
   * key — the plaintext-to-homeserver path that decouples onboarding from the
   * rust-crypto bootstrap. Set true to run the full invisible-E2EE setup.
   */
  e2ee?: boolean;
  homeserver: string;
  username: string;
  password: string;
  /**
   * Trusted Matrix IDs to write into `allowed_user_ids`. Empty/omitted →
   * fail-closed: an empty allowlist answers anyone but trusts no one (same
   * policy as Telegram). A non-empty list is written verbatim into the config
   * block so these MXIDs are treated as trusted principals.
   */
  allowedUserIds?: string[];
  /** Injectable login (default realMatrixLogin). */
  login?: MatrixLoginFn;
  /** Injectable crypto-client factory (default builds a real SDK client). */
  makeClient?: (args: {
    homeserver: string;
    userId: string;
    deviceId: string;
    accessToken: string;
    password: string;
    username: string;
  }) => Promise<MatrixSetupClient>;
  /** Injectable env writer (default runEnvSet → ~/.env). */
  envSet?: (name: string, value: string) => Promise<number>;
  /** Injectable config path (default config.configPath). */
  configPath?: string;
  out?: WriteSink;
  err?: WriteSink;
}

export interface ChatMatrixSetupResult {
  ok: boolean;
  /** The MXID the server canonicalized the login to. */
  userId?: string;
  deviceId?: string;
  /** Name of the env var the recovery key was stored under. NEVER the value. */
  recoveryKeyEnvVar?: string;
  error?: string;
}

/**
 * The setup core, free of TUI prompts so it can be unit-tested. Performs:
 * login → crypto init → bootstrap → store secrets → write config. Returns a
 * structured result; never throws for expected failures (login rejected, etc).
 */
export async function runChatMatrixSetup(
  input: ChatMatrixSetupInput,
): Promise<ChatMatrixSetupResult> {
  const login = input.login ?? realMatrixLogin;
  const makeClient = input.makeClient ?? defaultMakeClient;
  const envSet =
    input.envSet ?? ((name: string, value: string) => runEnvSet({ name, value }));
  const configPath = input.configPath ?? input.config.configPath;
  const e2ee = input.e2ee ?? false;

  // 1. Password login → token + device id. Password is spent here.
  let creds;
  try {
    creds = await login({
      homeserver: input.homeserver,
      username: input.username,
      password: input.password,
    });
  } catch (e) {
    return { ok: false, error: `login failed: ${(e as Error).message}` };
  }

  // PLAINTEXT FAST-PATH (default). E2EE is decoupled from onboarding: a v1
  // Matrix account talks plaintext-over-TLS to its homeserver (same protection
  // as the Telegram bot API), so setup is just login → write config. No crypto
  // client, no WASM bootstrap, no recovery key. This is the path that lets
  // onboarding succeed without the rust-crypto-in-single-binary fight.
  if (!e2ee) {
    await writeMatrixConfig(configPath, {
      perPersona: input.perPersona,
      persona: input.persona,
      homeserver: input.homeserver,
      userId: creds.userId,
      deviceId: creds.deviceId,
      accessToken: creds.accessToken,
      e2ee: false,
      allowedUserIds: input.allowedUserIds,
    });
    return { ok: true, userId: creds.userId, deviceId: creds.deviceId };
  }

  // 2. Build a crypto-enabled client and init rust-crypto against the
  //    per-persona store dir (next to SOUL.md).
  const cryptoStoreDir = matrixCryptoStoreDir(input.config, input.persona);
  let client: MatrixSetupClient;
  try {
    client = await makeClient({
      homeserver: input.homeserver,
      userId: creds.userId,
      deviceId: creds.deviceId,
      accessToken: creds.accessToken,
      // Passed ONLY so the factory can build the UIA re-auth callback; not
      // persisted by anything downstream.
      password: input.password,
      username: input.username,
    });
  } catch (e) {
    return { ok: false, error: `crypto client init failed: ${(e as Error).message}` };
  }

  try {
    await client.initCrypto(cryptoStoreDir);

    // 3. Invisible E2EE bootstrap — auto-generates the recovery key.
    const { recoveryKey } = await bootstrapInvisibleE2ee(
      client.crypto(),
      client.authUploadCallback(),
    );

    // 3b. Store the recovery key as a per-persona-suffixed env var (default
    //     account uses the bare name). Via the env helper so it inherits
    //     atomic-rename + 0o600 — NEVER echoed to the user or the terminal.
    const envVar = input.perPersona
      ? `MATRIX_RECOVERY_KEY_${personaEnvSuffix(input.persona)}`
      : "MATRIX_RECOVERY_KEY";
    const code = await envSet(envVar, recoveryKey);
    if (code !== 0) {
      return { ok: false, error: `failed to store recovery key (env set exit ${code})` };
    }

    // 4. Persist token + device id + MXID + allowlist scaffold to config.
    await writeMatrixConfig(configPath, {
      perPersona: input.perPersona,
      persona: input.persona,
      homeserver: input.homeserver,
      userId: creds.userId,
      deviceId: creds.deviceId,
      accessToken: creds.accessToken,
      e2ee: true,
      allowedUserIds: input.allowedUserIds,
    });

    // Force the crypto store to disk NOW. The debounced auto-snapshot may not
    // have fired before this short-lived setup process exits; without an
    // explicit flush the device we just minted would be lost and the runtime
    // would register a brand-new one. No-op under unit tests (fake client never
    // installed the store).
    const { flushSnapshot } = await import("../channels/matrix/idbPersist.ts");
    await flushSnapshot();

    return {
      ok: true,
      userId: creds.userId,
      deviceId: creds.deviceId,
      recoveryKeyEnvVar: envVar,
    };
  } catch (e) {
    return { ok: false, error: `E2EE bootstrap failed: ${(e as Error).message}` };
  } finally {
    try {
      client.stop();
    } catch {
      /* best-effort teardown */
    }
  }
}

/**
 * Write the resolved Matrix credentials into config.toml. The default account
 * goes to `[channels.matrix]`; a per-persona account to
 * `[channels.matrix.personas.<persona>]`. allowed_user_ids is seeded EMPTY —
 * the user sets it afterward; an empty allowlist answers anyone but trusts
 * no one (fail-closed), same policy as Telegram.
 */
async function writeMatrixConfig(
  configPath: string,
  args: {
    perPersona: boolean;
    persona: string;
    homeserver: string;
    userId: string;
    deviceId: string;
    accessToken: string;
    e2ee: boolean;
    /** Trusted MXIDs to write into allowed_user_ids (see note below). */
    allowedUserIds?: string[];
  },
): Promise<void> {
  const base = args.perPersona
    ? ["channels", "matrix", "personas", args.persona]
    : ["channels", "matrix"];
  await updateConfigToml(configPath, (toml) => {
    setIn(toml, [...base, "homeserver"], args.homeserver);
    setIn(toml, [...base, "user_id"], args.userId);
    setIn(toml, [...base, "device_id"], args.deviceId);
    setIn(toml, [...base, "access_token"], args.accessToken);
    // Record the encryption mode so the runtime + notify path know whether to
    // spin up rust-crypto. Explicit in config so flipping it is a visible edit.
    setIn(toml, [...base, "e2ee"], args.e2ee);
    // allowed_user_ids: if the user supplied trusted MXIDs, write them
    // verbatim (a deliberate edit wins). Otherwise only SEED an empty list when
    // none exists yet — never clobber MXIDs a prior run already wrote.
    if (args.allowedUserIds && args.allowedUserIds.length > 0) {
      setIn(toml, [...base, "allowed_user_ids"], args.allowedUserIds);
    } else {
      const existing = getIn(toml, [...base, "allowed_user_ids"]);
      if (existing === undefined) {
        setIn(toml, [...base, "allowed_user_ids"], []);
      }
    }
  });
}

/** Minimal sync-event surface of a matrix-js-sdk client, for {@link waitForFirstSync}. */
export interface SyncCapableClient {
  on(event: "sync", listener: (state: string) => void): void;
  removeListener?(event: "sync", listener: (state: string) => void): void;
}

/** Default ceiling for the first-sync wait. matrix.org cold syncs are well under this. */
export const FIRST_SYNC_TIMEOUT_MS = 60_000;

/**
 * Wait for matrix-js-sdk's first /sync to reach a usable state before the E2EE
 * bootstrap runs. Resolves on PREPARED/SYNCING. Rejects on ERROR/STOPPED, or if
 * no terminal state arrives within `timeoutMs`.
 *
 * Without this bound, a homeserver/network stall after login, an invalidated
 * token, or an SDK that only ever emits ERROR would leave `initCrypto` — and
 * therefore `runChatMatrixSetup` — hanging forever instead of returning a
 * structured setup failure. The listener is removed and the timer cleared on
 * every exit path.
 */
export function waitForFirstSync(
  client: SyncCapableClient,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? FIRST_SYNC_TIMEOUT_MS;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      client.removeListener?.("sync", onSync);
      clearTimeout(timer);
    };
    const onSync = (state: string) => {
      if (settled) return;
      if (state === "PREPARED" || state === "SYNCING") {
        settled = true;
        cleanup();
        resolve();
      } else if (state === "ERROR" || state === "STOPPED") {
        settled = true;
        cleanup();
        reject(new Error(`matrix first sync failed: ${state}`));
      }
      // Transient states (RECONNECTING, CATCHUP, …) are ignored — keep waiting
      // until a usable/terminal state or the timeout.
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`matrix first sync timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    client.on("sync", onSync);
  });
}

/**
 * Default production client factory: builds a real crypto-enabled SDK client
 * and exposes the setup seam. Imported dynamically so the heavy SDK only loads
 * during an actual setup run.
 */
const defaultMakeClient = async (args: {
  homeserver: string;
  userId: string;
  deviceId: string;
  accessToken: string;
  password: string;
  username: string;
}): Promise<MatrixSetupClient> => {
  const { ensureCryptoWasm } = await import("../channels/matrix/cryptoWasm.ts");
  await ensureCryptoWasm();
  const sdk = await import("matrix-js-sdk");

  // Secret-storage (4S) bootstrap stashes the recovery key it creates via
  // `cacheSecretStorageKey`, then reads it back via `getSecretStorageKey` to
  // write cross-signing + backup secrets into 4S. matrix-js-sdk requires BOTH
  // callbacks at client-construction time — without them bootstrapSecretStorage
  // throws "No getSecretStorageKey callback supplied". We hold the key only in
  // this short-lived in-memory map for the duration of setup (it's also encoded
  // into MATRIX_RECOVERY_KEY by the caller); nothing is persisted here.
  const ssKeys = new Map<string, Uint8Array>();
  let lastKeyId: string | undefined;
  // Typed `any`: the SDK's cryptoCallbacks signature pins Uint8Array<ArrayBuffer>
  // which our generic Uint8Array doesn't satisfy under this lib version; the
  // client is `any` regardless and these are exercised at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cryptoCallbacks: any = {
    cacheSecretStorageKey: (keyId: string, _keyInfo: unknown, key: Uint8Array) => {
      ssKeys.set(keyId, key);
      lastKeyId = keyId;
    },
    getSecretStorageKey: async (opts: { keys: Record<string, unknown> }) => {
      // Prefer a key the request explicitly references; else fall back to the
      // one we just cached during this bootstrap.
      for (const keyId of Object.keys(opts.keys)) {
        const k = ssKeys.get(keyId);
        if (k) return [keyId, k];
      }
      if (lastKeyId && ssKeys.has(lastKeyId)) {
        return [lastKeyId, ssKeys.get(lastKeyId)!];
      }
      return null;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = sdk.createClient({
    baseUrl: args.homeserver,
    userId: args.userId,
    deviceId: args.deviceId,
    accessToken: args.accessToken,
    cryptoCallbacks,
  });
  return {
    initCrypto: async (cryptoStoreDir: string) => {
      // Install fake-indexeddb + disk snapshot BEFORE initRustCrypto so the
      // device identity this setup mints is persisted to disk and reused by the
      // runtime listener (same device, no re-verification). See idbPersist.ts.
      const { installPersistentIndexedDB, cryptoSnapshotPath, MATRIX_CRYPTO_DB_PREFIX } =
        await import("../channels/matrix/idbPersist.ts");
      // fresh:true — setup mints a NEW device on every login, so start from an
      // empty store and snapshot the new device; never restore a prior one.
      await installPersistentIndexedDB(cryptoSnapshotPath(cryptoStoreDir), {
        fresh: true,
      });
      await client.initRustCrypto({ cryptoDatabasePrefix: MATRIX_CRYPTO_DB_PREFIX });

      // Start the client and wait for first sync BEFORE the E2EE bootstrap.
      // bootstrapSecretStorage reads/writes account data; without a running
      // /sync those reads are inconsistent and the bootstrap hangs forever.
      await client.startClient({ initialSyncLimit: 1 });
      await waitForFirstSync(client);
    },
    crypto: () => client.getCrypto() as MatrixCryptoLike,
    authUploadCallback: () => async (makeRequest) => {
      // Re-auth the signing-key upload with the password we just used. The
      // password lives only in this closure for the duration of setup.
      await makeRequest({
        type: "m.login.password",
        identifier: { type: "m.id.user", user: args.username },
        password: args.password,
      });
    },
    stop: () => client.stopClient(),
  };
};

/**
 * The interactive wizard. EXACTLY three prompts. Resolves which persona/block
 * to write, runs the setup core, and reports a redacted summary.
 */
export async function runChatMatrix(
  input: {
    config?: Config;
    persona?: string;
    serviceControl?: ServiceControl;
    out?: WriteSink;
    /**
     * Non-interactive setup (no TUI prompts). When provided, the wizard runs
     * the setup core directly with these values and reports a redacted result.
     * Used by automation / init chains and to configure a headless host. The
     * password comes from the env var named here (never an argument), so it
     * stays out of argv / process listings.
     */
    nonInteractive?: {
      homeserver: string;
      username: string;
      passwordEnvVar: string;
      e2ee: boolean;
      /** Trusted MXIDs for allowed_user_ids (already parsed). */
      allowedUserIds?: string[];
    };
  } = {},
): Promise<number> {
  const config = input.config ?? (await loadConfig());
  const svc = input.serviceControl ?? defaultServiceControl();
  const persona = input.persona ?? config.defaultPersona;
  const perPersona = input.persona !== undefined && input.persona !== config.defaultPersona;

  // Non-interactive branch: no prompts, single setup attempt, structured exit.
  if (input.nonInteractive) {
    const ni = input.nonInteractive;
    const password = process.env[ni.passwordEnvVar];
    if (!password) {
      log.error(`matrix setup: password env var ${ni.passwordEnvVar} is empty`);
      return 1;
    }
    const result = await runChatMatrixSetup({
      config,
      persona,
      perPersona,
      e2ee: ni.e2ee,
      homeserver: ni.homeserver,
      username: ni.username,
      password,
      allowedUserIds: ni.allowedUserIds,
    });
    if (!result.ok) {
      log.error(`matrix setup failed: ${result.error}`);
      return 1;
    }
    log.info("matrix: setup complete (non-interactive)", {
      userId: result.userId,
      deviceId: result.deviceId,
      e2ee: ni.e2ee,
      recoveryKeyEnvVar: result.recoveryKeyEnvVar,
    });
    return 0;
  }

  p.intro("Configure the Matrix channel");

  // Opt-in gate. This wizard is part of the `phantombot init` chain, and most
  // users will not be wiring up Matrix — so ask first, default to NO, and exit
  // cleanly (0, not an error) when skipped so the init chain keeps flowing.
  const proceed = await p.confirm({
    message: "Set up Matrix now?",
    initialValue: false,
  });
  if (p.isCancel(proceed) || !proceed) {
    p.outro("skipped Matrix setup — you can run `phantombot chat matrix` later");
    return 0;
  }

  p.note(
    "You'll be asked for three things: homeserver, username, and password.\n\n" +
      "FIRST, you need an account. A Matrix account lives on a HOMESERVER\n" +
      "(e.g. matrix.org). Apps like Element (app.element.io) are just clients —\n" +
      "they connect TO a homeserver, they aren't the account itself.\n\n" +
      "  • No account yet? Open https://app.element.io, pick \"Create account\",\n" +
      "    and keep the default homeserver (matrix.org). No special steps — a\n" +
      "    plain username + password is all this needs.\n" +
      "  • Already have one? Just use it below. This logs into an EXISTING\n" +
      "    account; it never creates or modifies one.\n\n" +
      "Your homeserver URL is where the account lives — if you registered on\n" +
      "matrix.org, that's https://matrix.org (the default below).",
    "Before you start",
  );

  // End-to-end encryption is opt-in. It now works inside the single binary
  // (see channels/matrix/cryptoWasm.ts), so default it ON — but allow opting
  // out to the plaintext-over-TLS path (same protection as the Telegram bot).
  const e2eeChoice = await p.confirm({
    message:
      "Turn on end-to-end encryption? (recommended — auto-managed, nothing extra to do)",
    initialValue: true,
  });
  if (p.isCancel(e2eeChoice)) {
    p.cancel("cancelled");
    return 1;
  }
  const e2ee = e2eeChoice === true;

  // Trusted principals. Same model as the Telegram allow-list: a
  // comma-separated list, empty = answer anyone but trust no one (fail-closed).
  // Asked once up front so the retry loop below doesn't re-prompt it.
  const allowedRaw = await p.text({
    message:
      "Trusted Matrix IDs (comma-separated MXIDs like @you:matrix.org; empty = answer anyone, trust no one)",
    placeholder: "@you:matrix.org, @other:example.org",
  });
  if (p.isCancel(allowedRaw)) {
    p.cancel("cancelled");
    return 1;
  }
  const { ids: allowedUserIds, invalid: invalidMxids } = parseAllowedMxids(
    (allowedRaw as string) ?? "",
  );
  if (invalidMxids.length > 0) {
    p.note(
      `These didn't look like MXIDs (@name:server) and were skipped:\n  ${invalidMxids.join(", ")}`,
      "Ignored",
    );
  }
  if (allowedUserIds.length === 0) {
    p.note(
      "No trusted MXIDs set — the bot will answer anyone but trust no one. You can add them to allowed_user_ids later.",
      "Heads up",
    );
  }

  // Credential prompt + setup, wrapped in a retry loop. A bad password or wrong
  // homeserver shouldn't dump the user back to the shell — on failure we offer
  // "try again" (re-ask credentials) or "cancel setup", so this slots cleanly
  // into the init chain either way.
  for (;;) {
    const homeserver = await p.text({
      message: "Homeserver URL",
      placeholder: "https://matrix.org",
      // Empty-Enter accepts the placeholder — no retyping the common default.
      defaultValue: "https://matrix.org",
      validate: (v) => {
        if (v && !/^https?:\/\//.test(v))
          return "must start with http:// or https://";
        return undefined;
      },
    });
    if (p.isCancel(homeserver)) {
      p.cancel("cancelled");
      return 1;
    }
    const homeserverUrl = (homeserver as string) || "https://matrix.org";

    const username = await p.text({
      message: "Username (full MXID like @name:matrix.org, or just the localpart)",
      validate: (v) => (!v || v.length === 0 ? "username is required" : undefined),
    });
    if (p.isCancel(username)) {
      p.cancel("cancelled");
      return 1;
    }

    const password = await p.password({
      message: "Password (used once to log in, then discarded — never stored)",
      validate: (v) => (!v || v.length === 0 ? "password is required" : undefined),
    });
    if (p.isCancel(password)) {
      p.cancel("cancelled");
      return 1;
    }

    const spinner = p.spinner();
    spinner.start(e2ee ? "logging in + setting up encryption…" : "logging in…");
    const result = await runChatMatrixSetup({
      config,
      persona,
      perPersona,
      e2ee,
      homeserver: homeserverUrl,
      username: username as string,
      password: password as string,
      allowedUserIds,
    });

    if (result.ok) {
      spinner.stop(`logged in as ${result.userId} (device ${result.deviceId})`);
      return await finishMatrixSetup(result, { perPersona, persona, svc });
    }

    spinner.stop(`setup failed: ${result.error}`);
    const retry = await p.confirm({
      message: "Try again?",
      initialValue: true,
    });
    if (p.isCancel(retry) || !retry) {
      p.cancel("Matrix was not configured");
      return 1;
    }
    // loop: re-prompt credentials and retry.
  }
}

/**
 * Report a successful setup (redacted) and offer the restart prompt. Split out
 * so the retry loop has a single clean exit on success.
 */
async function finishMatrixSetup(
  result: ChatMatrixSetupResult,
  ctx: { perPersona: boolean; persona: string; svc: ServiceControl },
): Promise<number> {
  const { perPersona, persona, svc } = ctx;

  // Deliberately do NOT print the recovery key — only that it was stored.
  const encryptionLine = result.recoveryKeyEnvVar
    ? `encryption: end-to-end on (recovery key stored as ${result.recoveryKeyEnvVar})`
    : `encryption: in-transit (TLS to homeserver); end-to-end is a later opt-in`;
  p.note(
    `MXID: ${result.userId}\n` +
      `device: ${result.deviceId}\n` +
      `${encryptionLine}\n` +
      `block: ${perPersona ? `[channels.matrix.personas.${persona}]` : "[channels.matrix]"}\n` +
      `\nTrusted principals live in allowed_user_ids in that block — edit it to adjust who the bot trusts.`,
    "Saved",
  );

  log.info("matrix: setup complete", {
    userId: result.userId,
    deviceId: result.deviceId,
    perPersona,
  });

  await maybePromptRestart(svc);
  p.outro("done");
  return 0;
}

export default defineCommand({
  meta: {
    name: "matrix",
    description:
      "Configure the Matrix channel (homeserver + username + password). E2EE is set up automatically.",
  },
  args: {
    persona: {
      type: "string",
      description:
        "Bind this Matrix account to a specific persona ([channels.matrix.personas.<name>]) instead of the default.",
    },
    homeserver: {
      type: "string",
      description:
        "Non-interactive: homeserver URL. With --username + --password-env, skips all prompts.",
    },
    username: {
      type: "string",
      description: "Non-interactive: MXID or localpart to log in as.",
    },
    "password-env": {
      type: "string",
      description:
        "Non-interactive: name of the env var holding the login password (never passed as an argument).",
    },
    e2ee: {
      type: "boolean",
      description:
        "Non-interactive: enable end-to-end encryption (default true). Use --no-e2ee for plaintext-over-TLS.",
      default: true,
    },
    "allowed-users": {
      type: "string",
      description:
        "Non-interactive: comma-separated trusted MXIDs (@you:matrix.org) for allowed_user_ids. Empty = answer anyone, trust no one.",
    },
  },
  async run({ args }) {
    const homeserver = args.homeserver as string | undefined;
    const username = args.username as string | undefined;
    const passwordEnvVar = args["password-env"] as string | undefined;
    const allowedRaw = args["allowed-users"] as string | undefined;
    const { ids: allowedUserIds, invalid: invalidMxids } = parseAllowedMxids(
      allowedRaw ?? "",
    );
    if (invalidMxids.length > 0) {
      log.warn(
        `matrix setup: ignoring entries that aren't MXIDs: ${invalidMxids.join(", ")}`,
      );
    }
    // All three present → headless setup; otherwise fall through to the wizard.
    const nonInteractive =
      homeserver && username && passwordEnvVar
        ? {
            homeserver,
            username,
            passwordEnvVar,
            e2ee: args.e2ee !== false,
            allowedUserIds,
          }
        : undefined;
    process.exitCode = await runChatMatrix({
      persona: args.persona as string | undefined,
      nonInteractive,
    });
  },
});
