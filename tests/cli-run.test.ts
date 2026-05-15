/**
 * Tests for `phantombot run` — focused on the early-exit failure paths.
 * The full Telegram polling loop is exercised by the runTelegramServer
 * tests in tests/channels-telegram.test.ts (now folded into the run cmd).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRun } from "../src/cli/run.ts";
import type { Config } from "../src/config.ts";

class CaptureStream {
  chunks: string[] = [];
  write(s: string | Uint8Array): boolean {
    this.chunks.push(typeof s === "string" ? s : new TextDecoder().decode(s));
    return true;
  }
  get text(): string {
    return this.chunks.join("");
  }
}

const SAVED_STATE = process.env.PHANTOMBOT_STATE;

let workdir: string;
let config: Config;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-run-"));
  process.env.PHANTOMBOT_STATE = join(workdir, "state.json");
  await mkdir(join(workdir, "personas", "phantom"), { recursive: true });
  await writeFile(
    join(workdir, "personas", "phantom", "BOOT.md"),
    "# Phantom",
  );
  config = {
    defaultPersona: "phantom",
    harnessIdleTimeoutMs: 600_000, harnessHardTimeoutMs: 600_000,
    personasDir: join(workdir, "personas"),
    memoryDbPath: join(workdir, "memory.sqlite"),
    configPath: join(workdir, "config.toml"),
    harnesses: {
      chain: ["claude"],
      claude: { bin: "claude", model: "opus", fallbackModel: "sonnet" },
      pi: { bin: "pi", maxPayloadBytes: 1_000_000 },
      gemini: { bin: "gemini", model: "" },
    },
    channels: {},
    embeddings: { provider: "none" },
    voice: { provider: "none" },
  };
});

afterEach(async () => {
  if (SAVED_STATE === undefined) delete process.env.PHANTOMBOT_STATE;
  else process.env.PHANTOMBOT_STATE = SAVED_STATE;
  await rm(workdir, { recursive: true, force: true });
});

describe("runRun — early exits", () => {
  test("returns 2 when telegram is not configured", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const code = await runRun({ config, out, err });
    expect(code).toBe(2);
    expect(err.text).toContain("phantombot telegram");
  });

  test("returns 2 when persona dir is missing and no other personas exist", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    await rm(join(workdir, "personas", "phantom"), { recursive: true });
    const code = await runRun({
      config: {
        ...config,
        channels: {
          telegram: {
            token: "abc",
            pollTimeoutS: 30,
            allowedUserIds: [],
          },
        },
      },
      out,
      err,
    });
    expect(code).toBe(2);
    expect(err.text).toContain("no other personas exist");
  });

  test("heals to another persona when default is missing but others exist", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    // Remove the configured default persona, but leave a different one.
    await rm(join(workdir, "personas", "phantom"), { recursive: true });
    await mkdir(join(workdir, "personas", "kai"), { recursive: true });
    await writeFile(join(workdir, "personas", "kai", "BOOT.md"), "# Kai");

    // Use an empty harness chain to force an early exit (code 2) after
    // the persona validation passes. This proves healing worked without
    // launching a full Telegram polling server.
    const code = await runRun({
      config: {
        ...config,
        harnesses: { ...config.harnesses, chain: [] },
        channels: {
          telegram: {
            token: "abc",
            pollTimeoutS: 30,
            allowedUserIds: [],
          },
        },
      },
      lockPath: join(workdir, "run.lock"),
      out,
      err,
    });
    // Should fail on harness chain, not persona-missing.
    expect(code).toBe(2);
    expect(err.text).not.toContain("no other personas exist");
    expect(err.text).toContain("phantombot harness");
  });

  test("returns 2 when harness chain is empty", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const code = await runRun({
      config: {
        ...config,
        harnesses: { ...config.harnesses, chain: [] },
        channels: {
          telegram: {
            token: "abc",
            pollTimeoutS: 30,
            allowedUserIds: [],
          },
        },
      },
      out,
      err,
    });
    expect(code).toBe(2);
    expect(err.text).toContain("phantombot harness");
  });
});
