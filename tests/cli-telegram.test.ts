/**
 * Tests for `phantombot telegram`'s side-effect helpers + the
 * OpenClaw-config sniffer.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyTelegramConfig,
  parseAllowedUserIds,
  parseOpenClawTelegram,
} from "../src/cli/telegram.ts";

let workdir: string;
let configPath: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-tg-"));
  configPath = join(workdir, "config.toml");
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("parseAllowedUserIds", () => {
  test("parses comma- and space-separated digits", () => {
    expect(parseAllowedUserIds("123, 456 789")).toEqual([123, 456, 789]);
  });

  test("ignores garbage entries", () => {
    expect(parseAllowedUserIds("123, abc, 456")).toEqual([123, 456]);
  });

  test("returns [] on empty input", () => {
    expect(parseAllowedUserIds("")).toEqual([]);
    expect(parseAllowedUserIds("  ")).toEqual([]);
  });
});

describe("applyTelegramConfig", () => {
  test("writes the [channels.telegram] block to config.toml", async () => {
    await applyTelegramConfig(configPath, {
      token: "111:secret",
      pollTimeoutS: 30,
      allowedUserIds: [42, 99],
    });
    const text = await readFile(configPath, "utf8");
    expect(text).toContain("[channels.telegram]");
    expect(text).toContain('token = "111:secret"');
    expect(text).toContain("poll_timeout_s = 30");
    expect(text).toContain("allowed_user_ids = [ 42, 99 ]");
  });

  test("preserves other sections of an existing config", async () => {
    const { writeConfigToml } = await import("../src/lib/configWriter.ts");
    await writeConfigToml(configPath, {
      default_persona: "robbie",
      harnesses: { chain: ["claude"] },
    });
    await applyTelegramConfig(configPath, {
      token: "111:secret",
      pollTimeoutS: 30,
      allowedUserIds: [],
    });
    const text = await readFile(configPath, "utf8");
    expect(text).toContain('default_persona = "robbie"');
    expect(text).toContain("[harnesses]");
    expect(text).toContain('chain = [ "claude" ]');
    expect(text).toContain("[channels.telegram]");
  });
});

describe("parseOpenClawTelegram", () => {
  test("extracts token + approvers from the kai-style nested layout", () => {
    const r = parseOpenClawTelegram({
      channels: {
        telegram: {
          accounts: {
            default: {
              botToken: "111:abc",
              execApprovals: { approvers: ["123456789"] },
            },
          },
        },
      },
    });
    expect(r).toEqual({ token: "111:abc", allowedUserIds: [123456789] });
  });

  test("supports the older flat layout", () => {
    const r = parseOpenClawTelegram({
      channels: {
        telegram: {
          botToken: "222:xyz",
          approvers: [42, 99],
        },
      },
    });
    expect(r).toEqual({ token: "222:xyz", allowedUserIds: [42, 99] });
  });

  test("returns undefined when no telegram block is present", () => {
    expect(parseOpenClawTelegram({})).toBeUndefined();
    expect(parseOpenClawTelegram({ channels: {} })).toBeUndefined();
    expect(
      parseOpenClawTelegram({ channels: { telegram: {} } }),
    ).toBeUndefined();
  });
});
