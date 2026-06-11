/**
 * Tests for the `phantombot chat` namespace (issue #154):
 *   - runChatMatrixSetup: the invisible-E2EE setup core with all SDK/crypto/
 *     env/login seams mocked (no network, no WASM). Asserts the password is
 *     NEVER persisted, the recovery key goes to env (not config), and the
 *     token/device/MXID land in the right config block.
 *   - applyDefaultChannel: writes [chat].default_channel.
 *   - runTelegramAlias: the deprecated `phantombot telegram` warns + forwards.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runChatMatrixSetup,
  type MatrixSetupClient,
} from "../src/cli/chat-matrix.ts";
import { applyDefaultChannel } from "../src/cli/chat.ts";
import {
  runTelegramAlias,
  TELEGRAM_DEPRECATION_NOTICE,
} from "../src/cli/telegram.ts";
import type { Config } from "../src/config.ts";
import type { MatrixCryptoLike } from "../src/channels/matrix/crypto.ts";

let workdir: string;
let configPath: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-chat-"));
  configPath = join(workdir, "config.toml");
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

function cfg(): Config {
  return {
    defaultPersona: "phantom",
    personasDir: join(workdir, "personas"),
    configPath,
    channels: {},
  } as unknown as Config;
}

/** A crypto stub that records the bootstrap calls + returns a fixed key. */
function fakeCrypto(): { crypto: MatrixCryptoLike; calls: string[] } {
  const calls: string[] = [];
  const crypto: MatrixCryptoLike = {
    bootstrapCrossSigning: async () => {
      calls.push("crossSigning");
    },
    bootstrapSecretStorage: async (opts) => {
      calls.push("secretStorage");
      // Exercise the recovery-key capture path the real bootstrap uses.
      if (opts.createSecretStorageKey) await opts.createSecretStorageKey();
    },
    createRecoveryKeyFromPassphrase: async () => {
      calls.push("recoveryKey");
      return {
        encodedPrivateKey: "EsTx 1234 5678 ABCD",
        privateKey: new Uint8Array([1, 2, 3]),
      };
    },
  };
  return { crypto, calls };
}

describe("runChatMatrixSetup — invisible E2EE", () => {
  test("logs in, bootstraps, stores recovery key in env (not config), writes config", async () => {
    const cryptoCalls: string[] = [];
    const envWrites: Array<{ name: string; value: string }> = [];
    let initCryptoDir: string | undefined;
    const fc = fakeCrypto();

    const result = await runChatMatrixSetup({
      config: cfg(),
      persona: "phantom",
      perPersona: false,
      homeserver: "https://hs.example",
      username: "robbie",
      password: "hunter2",
      login: async ({ username }) => ({
        userId: `@${username}:hs.example`,
        accessToken: "syt_token_abc",
        deviceId: "DEVICE123",
      }),
      makeClient: async (): Promise<MatrixSetupClient> => ({
        initCrypto: async (dir) => {
          initCryptoDir = dir;
        },
        crypto: () => fc.crypto,
        authUploadCallback: () => async () => {
          cryptoCalls.push("authUpload");
        },
        stop: () => {},
      }),
      envSet: async (name, value) => {
        envWrites.push({ name, value });
        return 0;
      },
      configPath,
    });

    expect(result.ok).toBe(true);
    expect(result.userId).toBe("@robbie:hs.example");
    expect(result.deviceId).toBe("DEVICE123");

    // Recovery key went to ~/.env (the default account uses the bare name),
    // NEVER to config.
    expect(envWrites).toEqual([
      { name: "MATRIX_RECOVERY_KEY", value: "EsTx 1234 5678 ABCD" },
    ]);
    expect(result.recoveryKeyEnvVar).toBe("MATRIX_RECOVERY_KEY");

    // The crypto bootstrap ran cross-signing + secret-storage + key gen.
    expect(fc.calls).toEqual(["crossSigning", "secretStorage", "recoveryKey"]);

    // Crypto store dir is the per-persona dir, next to SOUL.md.
    expect(initCryptoDir).toBe(join(workdir, "personas", "phantom", "matrix"));

    // Config got token/device/MXID + an empty allowlist scaffold — and NOT the
    // password nor the recovery key.
    const toml = await readFile(configPath, "utf8");
    expect(toml).toContain("[channels.matrix]");
    expect(toml).toContain('homeserver = "https://hs.example"');
    expect(toml).toContain('user_id = "@robbie:hs.example"');
    expect(toml).toContain('device_id = "DEVICE123"');
    expect(toml).toContain('access_token = "syt_token_abc"');
    expect(toml).toContain("allowed_user_ids = []");
    expect(toml).not.toContain("hunter2");
    expect(toml).not.toContain("EsTx 1234 5678 ABCD");
    expect(toml).not.toContain("recovery");
  });

  test("per-persona setup writes the personas block + suffixed env var", async () => {
    const envWrites: Array<{ name: string; value: string }> = [];
    const fc = fakeCrypto();
    const result = await runChatMatrixSetup({
      config: cfg(),
      persona: "lena",
      perPersona: true,
      homeserver: "https://hs",
      username: "lena",
      password: "pw",
      login: async () => ({
        userId: "@lena:hs",
        accessToken: "tok",
        deviceId: "D",
      }),
      makeClient: async () => ({
        initCrypto: async () => {},
        crypto: () => fc.crypto,
        authUploadCallback: () => async () => {},
        stop: () => {},
      }),
      envSet: async (name, value) => {
        envWrites.push({ name, value });
        return 0;
      },
      configPath,
    });
    expect(result.ok).toBe(true);
    expect(result.recoveryKeyEnvVar).toBe("MATRIX_RECOVERY_KEY_LENA");
    expect(envWrites[0]?.name).toBe("MATRIX_RECOVERY_KEY_LENA");
    const toml = await readFile(configPath, "utf8");
    expect(toml).toContain("[channels.matrix.personas.lena]");
  });

  test("returns a failure (no throw) when login is rejected", async () => {
    const result = await runChatMatrixSetup({
      config: cfg(),
      persona: "phantom",
      perPersona: false,
      homeserver: "https://hs",
      username: "x",
      password: "bad",
      login: async () => {
        throw new Error("M_FORBIDDEN");
      },
      makeClient: async () => {
        throw new Error("should not reach client init when login fails");
      },
      envSet: async () => 0,
      configPath,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("login failed");
    // Nothing was written to config.
    await expect(readFile(configPath, "utf8")).rejects.toThrow();
  });
});

describe("applyDefaultChannel", () => {
  test("writes [chat].default_channel = matrix", async () => {
    await applyDefaultChannel(configPath, "matrix");
    const toml = await readFile(configPath, "utf8");
    expect(toml).toContain("[chat]");
    expect(toml).toContain('default_channel = "matrix"');
  });

  test("preserves other config sections", async () => {
    const { writeConfigToml } = await import("../src/lib/configWriter.ts");
    await writeConfigToml(configPath, { default_persona: "robbie" });
    await applyDefaultChannel(configPath, "telegram");
    const toml = await readFile(configPath, "utf8");
    expect(toml).toContain('default_persona = "robbie"');
    expect(toml).toContain('default_channel = "telegram"');
  });
});

describe("deprecated `phantombot telegram` alias", () => {
  test("prints the deprecation notice and forwards to runTelegram", async () => {
    const lines: string[] = [];
    let forwarded = false;
    const code = await runTelegramAlias({
      out: { write: (s: string) => lines.push(s) } as unknown as NodeJS.WriteStream,
      run: async () => {
        forwarded = true;
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(forwarded).toBe(true);
    expect(lines.join("")).toContain(TELEGRAM_DEPRECATION_NOTICE);
  });
});
