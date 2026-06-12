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
  homeserver: string;
  username: string;
  password: string;
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
    });

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
    // Only seed an empty allowlist if none exists yet (don't clobber a
    // re-run where the user already added MXIDs).
    const existing = getIn(toml, [...base, "allowed_user_ids"]);
    if (existing === undefined) {
      setIn(toml, [...base, "allowed_user_ids"], []);
    }
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = sdk.createClient({
    baseUrl: args.homeserver,
    userId: args.userId,
    deviceId: args.deviceId,
    accessToken: args.accessToken,
  });
  return {
    initCrypto: async (cryptoStoreDir: string) => {
      await client.initRustCrypto({ cryptoDatabasePrefix: cryptoStoreDir });
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
  } = {},
): Promise<number> {
  const config = input.config ?? (await loadConfig());
  const svc = input.serviceControl ?? defaultServiceControl();
  const persona = input.persona ?? config.defaultPersona;
  const perPersona = input.persona !== undefined && input.persona !== config.defaultPersona;

  p.intro("Configure the Matrix channel");

  // Opt-in gate. This wizard is part of the `phantombot init` chain, and most
  // users will not be wiring up Matrix — so ask first, default to NO, and exit
  // cleanly (0, not an error) when skipped so the init chain keeps flowing.
  const proceed = await p.confirm({
    message: "Set up Matrix now? (most users skip this)",
    initialValue: false,
  });
  if (p.isCancel(proceed) || !proceed) {
    p.outro("skipped Matrix setup — you can run `phantombot chat matrix` later");
    return 0;
  }

  p.note(
    "E2EE is always on and fully automatic — you'll only be asked for your\n" +
      "homeserver, username, and password. Nothing else.\n\n" +
      "This logs into an EXISTING Matrix account — it does not create one.\n" +
      "If you don't have an account yet, register one on your homeserver first\n" +
      "(e.g. at https://app.element.io), then come back here.",
    "Before you start",
  );

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
      message: "Username (MXID or localpart, e.g. @robbie:matrix.org or robbie)",
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
    spinner.start("logging in + setting up encryption…");
    const result = await runChatMatrixSetup({
      config,
      persona,
      perPersona,
      homeserver: homeserverUrl,
      username: username as string,
      password: password as string,
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
  p.note(
    `MXID: ${result.userId}\n` +
      `device: ${result.deviceId}\n` +
      `encryption: on (recovery key stored as ${result.recoveryKeyEnvVar})\n` +
      `block: ${perPersona ? `[channels.matrix.personas.${persona}]` : "[channels.matrix]"}\n` +
      `\nNext: add allowed MXIDs to allowed_user_ids so the bot trusts you.`,
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
  },
  async run({ args }) {
    process.exitCode = await runChatMatrix({
      persona: args.persona as string | undefined,
    });
  },
});
