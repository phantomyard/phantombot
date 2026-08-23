/**
 * Zed installer data-loss-guard regression tests.
 *
 * Exercises the REAL `installZed` against a temp settings file:
 *   - JSONC with comments + a trailing comma → all keys preserved + block added
 *   - unparseable file → ABORT, file byte-for-byte unchanged, non-zero code
 *   - no file → creates a valid one
 *   - backup created when the file existed
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";

import {
  defaultZedSettingsPath,
  installZed,
} from "../src/connectors/acp/installZed.ts";

class Sink {
  buf = "";
  write(s: string): boolean {
    this.buf += s;
    return true;
  }
}

let workdir: string;
let settingsPath: string;
const BIN = "/home/dev/.local/bin/phantombot";

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-zed-"));
  settingsPath = join(workdir, "settings.json");
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("defaultZedSettingsPath", () => {
  const saved = process.env.XDG_CONFIG_HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  });

  test("resolves under ~/.config/zed on macOS/Linux", () => {
    if (process.platform === "win32") return; // POSIX-only assertion
    delete process.env.XDG_CONFIG_HOME;
    const p = defaultZedSettingsPath();
    // The macOS bug was returning Library/Application Support — Zed never reads
    // that. It must be the .config/zed path on POSIX.
    expect(p.endsWith(join(".config", "zed", "settings.json"))).toBe(true);
    expect(p).not.toContain("Application Support");
  });

  test("honours XDG_CONFIG_HOME on POSIX", () => {
    if (process.platform === "win32") return;
    process.env.XDG_CONFIG_HOME = "/tmp/xdg-test";
    expect(defaultZedSettingsPath()).toBe(
      join("/tmp/xdg-test", "zed", "settings.json"),
    );
  });

  test("resolves under %APPDATA%\\Zed on Windows (never ~/.config)", () => {
    // Zed on Windows reads %APPDATA%\Zed\settings.json; ~/.config would be a
    // file Zed never reads (silent-miss). Stub process.platform + APPDATA so the
    // win32 branch is exercised even when the suite runs on Linux/macOS.
    const realPlatform = process.platform;
    const savedAppData = process.env.APPDATA;
    try {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      process.env.APPDATA = "C:\\Users\\test\\AppData\\Roaming";
      const p = defaultZedSettingsPath();
      expect(p).toBe(join("C:\\Users\\test\\AppData\\Roaming", "Zed", "settings.json"));
      expect(p).not.toContain(".config");
    } finally {
      Object.defineProperty(process, "platform", {
        value: realPlatform,
        configurable: true,
      });
      if (savedAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = savedAppData;
    }
  });
});

describe("installZed — JSONC preservation", () => {
  test("preserves comments + other keys + trailing comma, adds the block", async () => {
    const original = `{
  // user's theme — keep me
  "theme": "One Dark",
  "buffer_font_size": 15,
  "languages": {
    "TypeScript": { "format_on_save": "on" },
  },
}`;
    writeFileSync(settingsPath, original, "utf8");

    const out = new Sink();
    const err = new Sink();
    const result = installZed({ settingsPath, binaryPath: BIN, out, err });

    expect(result.code).toBe(0);
    const updated = readFileSync(settingsPath, "utf8");

    // Comment + pre-existing keys survive.
    expect(updated).toContain("// user's theme — keep me");
    expect(updated).toContain('"theme": "One Dark"');
    expect(updated).toContain('"buffer_font_size": 15');
    expect(updated).toContain('"format_on_save"');

    // The new block is present + parses with the agent registration.
    const parsed = parse(updated) as any;
    expect(parsed.theme).toBe("One Dark");
    expect(parsed.agent_servers.Phantombot.command).toBe(BIN);
    expect(parsed.agent_servers.Phantombot.args).toEqual(["acp"]);
    // The registered env now bakes in an absolute PHANTOMBOT_CONFIG override so
    // the spawned `phantombot acp` always reads the real config.toml (insurance
    // against a redirected child `$HOME`/`$XDG_*`, the strict-snap class of bug).
    expect(parsed.agent_servers.Phantombot.env.PHANTOMBOT_CONFIG).toMatch(
      /\/phantombot\/config\.toml$/,
    );
    // PHANTOMBOT_PERSONAS_DIR is deliberately NOT baked in: it would override a
    // custom `personas_dir` in config.toml and silently break custom persona
    // roots. loadConfig resolves personas_dir from PHANTOMBOT_CONFIG instead.
    expect(
      parsed.agent_servers.Phantombot.env.PHANTOMBOT_PERSONAS_DIR,
    ).toBeUndefined();
  });

  test("backup of the original is created", async () => {
    const original = `{ "theme": "Solarized" }`;
    writeFileSync(settingsPath, original, "utf8");

    const result = installZed({
      settingsPath,
      binaryPath: BIN,
      out: new Sink(),
      err: new Sink(),
    });

    expect(result.backupPath).toBe(`${settingsPath}.phantombot-bak`);
    expect(existsSync(result.backupPath!)).toBe(true);
    expect(readFileSync(result.backupPath!, "utf8")).toBe(original);
  });
});

describe("installZed — data-loss guard", () => {
  test("unparseable file → abort, file byte-for-byte unchanged, non-zero", async () => {
    // Structurally broken JSON (unterminated string) — jsonc-parser reports
    // an error here, so we MUST abort.
    const broken = `{ "theme": "One Dark`;
    writeFileSync(settingsPath, broken, "utf8");

    const err = new Sink();
    const result = installZed({
      settingsPath,
      binaryPath: BIN,
      out: new Sink(),
      err,
    });

    expect(result.code).toBe(1);
    // File untouched.
    expect(readFileSync(settingsPath, "utf8")).toBe(broken);
    // No backup written (we never got that far).
    expect(existsSync(`${settingsPath}.phantombot-bak`)).toBe(false);
    // Manual snippet printed to stderr.
    expect(err.buf).toContain("agent_servers");
    expect(err.buf).toContain("Phantombot");
  });
});

describe("installZed — no existing file", () => {
  test("creates a valid settings.json with the block, no backup", async () => {
    expect(existsSync(settingsPath)).toBe(false);

    const result = installZed({
      settingsPath,
      binaryPath: BIN,
      out: new Sink(),
      err: new Sink(),
    });

    expect(result.code).toBe(0);
    expect(result.backupPath).toBeUndefined();
    expect(existsSync(settingsPath)).toBe(true);
    const parsed = parse(readFileSync(settingsPath, "utf8")) as any;
    expect(parsed.agent_servers.Phantombot.command).toBe(BIN);
  });
});
