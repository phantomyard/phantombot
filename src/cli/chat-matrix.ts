/**
 * `phantombot chat matrix` — interactive setup for the Matrix channel.
 *
 * THE INVISIBLE-E2EE WIZARD, matrix-bot-sdk edition. It asks at most four
 * things: create-or-login, homeserver, username, password. Nothing about E2EE,
 * recovery keys, or device verification ever reaches the user — because under
 * matrix-bot-sdk there is nothing to ask:
 *
 *   1. Password login (or programmatic REGISTRATION of a fresh bot account on a
 *      homeserver that allows it) → access token + device id; the PASSWORD IS
 *      DISCARDED (never written anywhere).
 *   2. The token + device id + MXID land in `[channels.matrix]` (or
 *      `[channels.matrix.personas.<persona>]`) in config.toml.
 *
 * That's the WHOLE setup. There is NO crypto bootstrap at setup time: the Rust
 * crypto store (`<personaDir>/matrix/crypto-store/`) is created lazily the first
 * time the listener runs `crypto.prepare()`. Encrypted rooms then "just work" —
 * no cross-signing, no SAS emoji dance, no recovery key, no "unverified" badge.
 * This is the entire reason for the migration off matrix-js-sdk: the human-in-
 * the-loop verification nag and the manual account-setup hack are both gone.
 *
 * Migration contract: copy the persona dir → keep the crypto store (same device,
 * no re-anything). The store is portable and agent-managed.
 *
 * The setup core (`runChatMatrixSetup`) takes injectable seams (login/register,
 * config path) so it's unit-testable with no homeserver / HTTP.
 */

import { defineCommand } from "citty";
import * as p from "@clack/prompts";

import { type Config, loadConfig } from "../config.ts";
import {
  realMatrixLogin,
  realMatrixRegister,
  type MatrixLoginFn,
} from "../channels/matrix/login.ts";
import { getIn, setIn, updateConfigToml } from "../lib/configWriter.ts";
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

export interface ChatMatrixSetupInput {
  config: Config;
  /** Persona this Matrix account binds to. Default account → defaultPersona;
   *  a named persona → the `[channels.matrix.personas.<persona>]` block. */
  persona: string;
  /** Whether to write the per-persona block vs the default block. */
  perPersona: boolean;
  /**
   * Persist `e2ee = true` so the runtime attaches the Rust crypto store. DEFAULT
   * TRUE — under matrix-bot-sdk E2EE is free (no bootstrap, no recovery key), so
   * there's no reason to default it off. Set false for plaintext-over-TLS.
   */
  e2ee?: boolean;
  /**
   * Register a NEW account instead of logging into an existing one. Only works
   * on a homeserver that allows `m.login.dummy`/password registration (e.g. a
   * self-hosted phantom-mesh homeserver — matrix.org requires reCAPTCHA and will
   * reject this). Default false (log into an existing account).
   */
  register?: boolean;
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
  /** Injectable register (default realMatrixRegister). */
  registerFn?: MatrixLoginFn;
  /** Injectable config path (default config.configPath). */
  configPath?: string;
  out?: WriteSink;
  err?: WriteSink;
}

export interface ChatMatrixSetupResult {
  ok: boolean;
  /** The MXID the server canonicalized the login/registration to. */
  userId?: string;
  deviceId?: string;
  /** Whether the account was persisted with E2EE on. */
  e2ee?: boolean;
  error?: string;
}

/**
 * The setup core, free of TUI prompts so it can be unit-tested. Performs:
 * login-or-register → write config. Returns a structured result; never throws
 * for expected failures (login rejected, registration disabled, etc).
 */
export async function runChatMatrixSetup(
  input: ChatMatrixSetupInput,
): Promise<ChatMatrixSetupResult> {
  const login = input.login ?? realMatrixLogin;
  const registerFn = input.registerFn ?? realMatrixRegister;
  const configPath = input.configPath ?? input.config.configPath;
  const e2ee = input.e2ee ?? true;

  // 1. Authenticate → token + device id. The password is spent here; nothing
  //    downstream retains it. Registration mints a new account; login uses an
  //    existing one. Both return the same {userId, accessToken, deviceId}.
  let creds;
  try {
    const authenticate = input.register ? registerFn : login;
    creds = await authenticate({
      homeserver: input.homeserver,
      username: input.username,
      password: input.password,
    });
  } catch (e) {
    const verb = input.register ? "registration" : "login";
    return { ok: false, error: `${verb} failed: ${(e as Error).message}` };
  }

  // 2. Persist token + device id + MXID + e2ee flag + allowlist scaffold to
  //    config. E2EE needs NO setup-time bootstrap under matrix-bot-sdk — the
  //    runtime creates the crypto store on first run.
  await writeMatrixConfig(configPath, {
    perPersona: input.perPersona,
    persona: input.persona,
    homeserver: input.homeserver,
    userId: creds.userId,
    deviceId: creds.deviceId,
    accessToken: creds.accessToken,
    e2ee,
    allowedUserIds: input.allowedUserIds,
  });

  return { ok: true, userId: creds.userId, deviceId: creds.deviceId, e2ee };
}

/**
 * Write the resolved Matrix credentials into config.toml. The default account
 * goes to `[channels.matrix]`; a per-persona account to
 * `[channels.matrix.personas.<persona>]`. allowed_user_ids is seeded EMPTY when
 * none is supplied — an empty allowlist answers anyone but trusts no one
 * (fail-closed), same policy as Telegram.
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
    // attach the Rust crypto store. Explicit in config so flipping it is visible.
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

/**
 * The interactive wizard. Resolves which persona/block to write, runs the setup
 * core, and reports a redacted summary.
 */
export async function runChatMatrix(
  input: {
    config?: Config;
    persona?: string;
    serviceControl?: ServiceControl;
    out?: WriteSink;
    /**
     * Non-interactive setup (no TUI prompts). When provided, the wizard runs the
     * setup core directly with these values and reports a redacted result. Used
     * by automation / init chains and to configure a headless host. The password
     * comes from the env var named here (never an argument), so it stays out of
     * argv / process listings.
     */
    nonInteractive?: {
      homeserver: string;
      username: string;
      passwordEnvVar: string;
      e2ee: boolean;
      register?: boolean;
      /** Trusted MXIDs for allowed_user_ids (already parsed). */
      allowedUserIds?: string[];
    };
  } = {},
): Promise<number> {
  const config = input.config ?? (await loadConfig());
  const svc = input.serviceControl ?? defaultServiceControl();
  const persona = input.persona ?? config.defaultPersona;
  const perPersona =
    input.persona !== undefined && input.persona !== config.defaultPersona;

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
      register: ni.register,
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
    "A Matrix account lives on a HOMESERVER (e.g. matrix.org). Apps like Element\n" +
      "(app.element.io) are just clients — they connect TO a homeserver.\n\n" +
      "  • Logging into an existing account? Have the homeserver URL, username,\n" +
      "    and password ready.\n" +
      "  • Creating a new bot account? That only works on a homeserver that allows\n" +
      "    open registration (your own server) — matrix.org won't (it needs a CAPTCHA).\n\n" +
      "End-to-end encryption is on by default and fully automatic: nothing to\n" +
      "verify, no recovery key to keep, no badges to clear.",
    "Before you start",
  );

  // Create a fresh account or log into an existing one.
  const mode = await p.select({
    message: "Account",
    options: [
      { value: "login", label: "Log into an existing account" },
      {
        value: "register",
        label: "Create a new account (homeserver must allow registration)",
      },
    ],
    initialValue: "login",
  });
  if (p.isCancel(mode)) {
    p.cancel("cancelled");
    return 1;
  }
  const register = mode === "register";

  // End-to-end encryption is opt-out (default on) — it's free under bot-sdk.
  const e2eeChoice = await p.confirm({
    message:
      "Turn on end-to-end encryption? (recommended — fully automatic, nothing to do)",
    initialValue: true,
  });
  if (p.isCancel(e2eeChoice)) {
    p.cancel("cancelled");
    return 1;
  }
  const e2ee = e2eeChoice === true;

  // Trusted principals. Same model as the Telegram allow-list: a
  // comma-separated list, empty = answer anyone but trust no one (fail-closed).
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
  // "try again" (re-ask credentials) or "cancel setup".
  for (;;) {
    const homeserver = await p.text({
      message: "Homeserver URL",
      placeholder: "https://matrix.org",
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
      message: register
        ? "Username for the new account (localpart, e.g. robbie)"
        : "Username (full MXID like @name:matrix.org, or just the localpart)",
      validate: (v) =>
        !v || v.length === 0 ? "username is required" : undefined,
    });
    if (p.isCancel(username)) {
      p.cancel("cancelled");
      return 1;
    }

    const password = await p.password({
      message: register
        ? "Password for the new account"
        : "Password (used once to log in, then discarded — never stored)",
      validate: (v) =>
        !v || v.length === 0 ? "password is required" : undefined,
    });
    if (p.isCancel(password)) {
      p.cancel("cancelled");
      return 1;
    }

    const spinner = p.spinner();
    spinner.start(register ? "creating account…" : "logging in…");
    const result = await runChatMatrixSetup({
      config,
      persona,
      perPersona,
      e2ee,
      register,
      homeserver: homeserverUrl,
      username: username as string,
      password: password as string,
      allowedUserIds,
    });

    if (result.ok) {
      spinner.stop(`signed in as ${result.userId} (device ${result.deviceId})`);
      return await finishMatrixSetup(result, { perPersona, persona, svc });
    }

    spinner.stop(`setup failed: ${result.error}`);
    const retry = await p.confirm({ message: "Try again?", initialValue: true });
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

  const encryptionLine = result.e2ee
    ? "encryption: end-to-end on (automatic — the crypto store is created on first run)"
    : "encryption: in-transit (TLS to homeserver); end-to-end is a config flip away";
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
      "Configure the Matrix channel (homeserver + username + password). E2EE is automatic.",
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
      description: "Non-interactive: MXID or localpart to log in / register as.",
    },
    "password-env": {
      type: "string",
      description:
        "Non-interactive: name of the env var holding the login password (never passed as an argument).",
    },
    register: {
      type: "boolean",
      description:
        "Non-interactive: create a new account instead of logging in (homeserver must allow registration).",
      default: false,
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
            register: args.register === true,
            allowedUserIds,
          }
        : undefined;
    process.exitCode = await runChatMatrix({
      persona: args.persona as string | undefined,
      nonInteractive,
    });
  },
});
