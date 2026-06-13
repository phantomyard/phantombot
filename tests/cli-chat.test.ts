/**
 * Tests for the `phantombot chat` namespace (issue #154):
 *   - runChatMatrixSetup: the matrix-bot-sdk setup core with the login/register
 *     seam mocked (no network). Asserts the password is NEVER persisted, the
 *     token/device/MXID land in the right config block, the e2ee flag is
 *     written, and that register vs login dispatch is honoured. There is NO
 *     crypto bootstrap / recovery key at setup time under matrix-bot-sdk.
 *   - applyDefaultChannel: writes [chat].default_channel.
 *   - runTelegramAlias: the deprecated `phantombot telegram` warns + forwards.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseAllowedMxids,
  runChatMatrixSetup,
} from "../src/cli/chat-matrix.ts";
import { applyDefaultChannel } from "../src/cli/chat.ts";
import {
  runTelegramAlias,
  TELEGRAM_DEPRECATION_NOTICE,
} from "../src/cli/telegram.ts";
import type { Config } from "../src/config.ts";

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

/** A login/register seam that records which credentials it saw. */
function fakeAuth(deviceId = "DEVICE123") {
  const seen: Array<{ homeserver: string; username: string; password: string }> =
    [];
  const fn = async (args: {
    homeserver: string;
    username: string;
    password: string;
  }) => {
    seen.push(args);
    return {
      userId: `@${args.username}:hs.example`,
      accessToken: "syt_token_abc",
      deviceId,
    };
  };
  return { fn, seen };
}

describe("parseAllowedMxids", () => {
  test("splits on commas and whitespace, trims, de-dupes", () => {
    const { ids, invalid } = parseAllowedMxids(
      " @a:matrix.org, @b:example.org  @a:matrix.org\n@c:hs.io ",
    );
    expect(ids).toEqual(["@a:matrix.org", "@b:example.org", "@c:hs.io"]);
    expect(invalid).toEqual([]);
  });

  test("separates non-MXID tokens into invalid", () => {
    const { ids, invalid } = parseAllowedMxids("@ok:hs.io, notanmxid, bob");
    expect(ids).toEqual(["@ok:hs.io"]);
    expect(invalid).toEqual(["notanmxid", "bob"]);
  });

  test("empty / whitespace input yields empty lists", () => {
    expect(parseAllowedMxids("")).toEqual({ ids: [], invalid: [] });
    expect(parseAllowedMxids("   \n ")).toEqual({ ids: [], invalid: [] });
  });
});

describe("runChatMatrixSetup — matrix-bot-sdk", () => {
  test("logs in and writes token/device/MXID + e2ee flag; password never persisted", async () => {
    const login = fakeAuth();
    const result = await runChatMatrixSetup({
      config: cfg(),
      persona: "phantom",
      perPersona: false,
      e2ee: true,
      homeserver: "https://hs.example",
      username: "robbie",
      password: "hunter2",
      login: login.fn,
      configPath,
    });

    expect(result.ok).toBe(true);
    expect(result.userId).toBe("@robbie:hs.example");
    expect(result.deviceId).toBe("DEVICE123");
    expect(result.e2ee).toBe(true);

    const toml = await readFile(configPath, "utf8");
    expect(toml).toContain("[channels.matrix]");
    expect(toml).toContain('homeserver = "https://hs.example"');
    expect(toml).toContain('user_id = "@robbie:hs.example"');
    expect(toml).toContain('device_id = "DEVICE123"');
    expect(toml).toContain('access_token = "syt_token_abc"');
    expect(toml).toContain("allowed_user_ids = []");
    expect(toml).toContain("e2ee = true");
    // The password (and any recovery material) must never reach config.
    expect(toml).not.toContain("hunter2");
    expect(toml).not.toContain("recovery");
  });

  test("register mode dispatches to registerFn, not login", async () => {
    const login = fakeAuth("LOGIN_DEV");
    const register = fakeAuth("REG_DEV");
    const result = await runChatMatrixSetup({
      config: cfg(),
      persona: "phantom",
      perPersona: false,
      e2ee: true,
      register: true,
      homeserver: "https://hs.example",
      username: "robbie",
      password: "hunter2",
      login: login.fn,
      registerFn: register.fn,
      configPath,
    });

    expect(result.ok).toBe(true);
    expect(result.deviceId).toBe("REG_DEV");
    expect(register.seen).toHaveLength(1);
    expect(login.seen).toHaveLength(0);
  });

  test("e2ee off writes e2ee = false (plaintext-over-TLS)", async () => {
    const login = fakeAuth();
    const result = await runChatMatrixSetup({
      config: cfg(),
      persona: "phantom",
      perPersona: false,
      e2ee: false,
      homeserver: "https://hs.example",
      username: "robbie",
      password: "hunter2",
      login: login.fn,
      configPath,
    });
    expect(result.ok).toBe(true);
    expect(result.e2ee).toBe(false);
    const toml = await readFile(configPath, "utf8");
    expect(toml).toContain("e2ee = false");
  });

  test("defaults e2ee to ON when omitted", async () => {
    const login = fakeAuth();
    const result = await runChatMatrixSetup({
      config: cfg(),
      persona: "phantom",
      perPersona: false,
      homeserver: "https://hs.example",
      username: "robbie",
      password: "hunter2",
      login: login.fn,
      configPath,
    });
    expect(result.ok).toBe(true);
    expect(result.e2ee).toBe(true);
    const toml = await readFile(configPath, "utf8");
    expect(toml).toContain("e2ee = true");
  });

  test("writes supplied trusted MXIDs into allowed_user_ids", async () => {
    const login = fakeAuth();
    const result = await runChatMatrixSetup({
      config: cfg(),
      persona: "phantom",
      perPersona: false,
      e2ee: true,
      homeserver: "https://hs.example",
      username: "robbie",
      password: "hunter2",
      allowedUserIds: ["@andrew:matrix.org", "@andrew:hodges.nl"],
      login: login.fn,
      configPath,
    });

    expect(result.ok).toBe(true);
    const toml = await readFile(configPath, "utf8");
    expect(toml).toContain('"@andrew:matrix.org"');
    expect(toml).toContain('"@andrew:hodges.nl"');
    expect(toml).not.toContain("allowed_user_ids = []");
  });

  test("per-persona setup writes the personas block", async () => {
    const login = fakeAuth("D");
    const result = await runChatMatrixSetup({
      config: cfg(),
      persona: "lena",
      perPersona: true,
      e2ee: true,
      homeserver: "https://hs",
      username: "lena",
      password: "pw",
      login: login.fn,
      configPath,
    });
    expect(result.ok).toBe(true);
    const toml = await readFile(configPath, "utf8");
    expect(toml).toContain("[channels.matrix.personas.lena]");
  });

  test("returns a failure (no throw) when login is rejected; nothing written", async () => {
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
      configPath,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("login failed");
    await expect(readFile(configPath, "utf8")).rejects.toThrow();
  });

  test("register failure surfaces a registration error", async () => {
    const result = await runChatMatrixSetup({
      config: cfg(),
      persona: "phantom",
      perPersona: false,
      register: true,
      homeserver: "https://hs",
      username: "x",
      password: "bad",
      registerFn: async () => {
        throw new Error("M_FORBIDDEN: registration disabled");
      },
      configPath,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("registration failed");
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
