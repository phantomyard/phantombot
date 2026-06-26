/**
 * Editor connector auto-registration tests.
 *
 * Exercises the REAL `reconcileEditorConnectors` against a fake editor backed
 * by a temp settings file, proving the behaviours startup + doctor depend on:
 *   - detection gate: skip editors whose config dir is absent (don't create it)
 *   - register when missing, idempotent "current" (no write) when already set
 *   - update when the registered binary path differs
 *   - report-only "stale" under repair:false (no write)
 *   - "error" surfaced when the installer aborts (unparseable settings)
 *   - per-editor isolation: one editor throwing doesn't sink the others
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "jsonc-parser";

import {
  reconcileEditorConnectors,
  type EditorSpec,
} from "../src/connectors/acp/autoInstall.ts";
import { installZed } from "../src/connectors/acp/installZed.ts";

let workdir: string;
let settingsPath: string;
const BIN = "/home/dev/.local/bin/phantombot";

/** A Zed-shaped editor pointed at a temp settings file (real installZed). */
function fakeZed(path: string): EditorSpec {
  return {
    id: "zed",
    settingsPath: () => path,
    detectionDir: (p) => dirname(p),
    currentCommand: (p) => {
      try {
        const parsed = parse(readFileSync(p, "utf8")) as any;
        const cmd = parsed?.agent_servers?.Phantombot?.command;
        return typeof cmd === "string" ? cmd : undefined;
      } catch {
        return undefined;
      }
    },
    install: (binaryPath, out, err) =>
      installZed({ settingsPath: path, binaryPath, out, err }),
  };
}

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-autoinstall-"));
  // The editor's config dir exists (editor "installed") but settings.json may not.
  settingsPath = join(workdir, "zed", "settings.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("reconcileEditorConnectors", () => {
  test("editor not installed (config dir absent) → not-detected, nothing created", () => {
    const missing = join(workdir, "no-such-editor", "settings.json");
    const results = reconcileEditorConnectors({
      binaryPath: BIN,
      editors: [fakeZed(missing)],
    });
    expect(results[0]!.action).toBe("not-detected");
    expect(existsSync(dirname(missing))).toBe(false); // did NOT create the dir
  });

  test("registers when missing, then idempotent (no write, no backup churn)", () => {
    // First run: no settings.json yet → registered.
    const first = reconcileEditorConnectors({
      binaryPath: BIN,
      editors: [fakeZed(settingsPath)],
    });
    expect(first[0]!.action).toBe("registered");
    const parsed = parse(readFileSync(settingsPath, "utf8")) as any;
    expect(parsed.agent_servers.Phantombot.command).toBe(BIN);

    // Capture file bytes, run again → current, file untouched, no backup made.
    const before = readFileSync(settingsPath, "utf8");
    const second = reconcileEditorConnectors({
      binaryPath: BIN,
      editors: [fakeZed(settingsPath)],
    });
    expect(second[0]!.action).toBe("current");
    expect(readFileSync(settingsPath, "utf8")).toBe(before);
    expect(existsSync(`${settingsPath}.phantombot-bak`)).toBe(false);
  });

  test("updates when the registered binary path differs", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        agent_servers: { Phantombot: { command: "/old/path", args: ["acp"], env: {} } },
      }),
      "utf8",
    );
    const results = reconcileEditorConnectors({
      binaryPath: BIN,
      editors: [fakeZed(settingsPath)],
    });
    expect(results[0]!.action).toBe("updated");
    const parsed = parse(readFileSync(settingsPath, "utf8")) as any;
    expect(parsed.agent_servers.Phantombot.command).toBe(BIN);
  });

  test("repair:false reports stale and writes nothing", () => {
    const results = reconcileEditorConnectors({
      binaryPath: BIN,
      repair: false,
      editors: [fakeZed(settingsPath)],
    });
    expect(results[0]!.action).toBe("stale");
    expect(existsSync(settingsPath)).toBe(false); // report-only, no write
  });

  test("unparseable settings → error, file untouched", () => {
    const broken = `{ "theme": "One Dark`; // unterminated string
    writeFileSync(settingsPath, broken, "utf8");
    const results = reconcileEditorConnectors({
      binaryPath: BIN,
      editors: [fakeZed(settingsPath)],
    });
    expect(results[0]!.action).toBe("error");
    expect(readFileSync(settingsPath, "utf8")).toBe(broken); // data-loss guard held
  });

  test("per-editor isolation: one throwing editor doesn't sink the others", () => {
    const exploding: EditorSpec = {
      id: "boom",
      settingsPath: () => {
        throw new Error("kaboom");
      },
      detectionDir: (p) => p,
      currentCommand: () => undefined,
      install: () => ({ code: 0 }),
    };
    const results = reconcileEditorConnectors({
      binaryPath: BIN,
      editors: [exploding, fakeZed(settingsPath)],
    });
    expect(results[0]!.action).toBe("error");
    expect(results[0]!.error).toContain("kaboom");
    // The healthy editor after it still got registered.
    expect(results[1]!.action).toBe("registered");
  });
});
