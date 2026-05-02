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

let workdir: string;
let config: Config;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-run-"));
  await mkdir(join(workdir, "personas", "phantom"), { recursive: true });
  await writeFile(
    join(workdir, "personas", "phantom", "BOOT.md"),
    "# Phantom",
  );
  config = {
    defaultPersona: "phantom",
    turnTimeoutMs: 600_000,
    personasDir: join(workdir, "personas"),
    memoryDbPath: join(workdir, "memory.sqlite"),
    configPath: join(workdir, "config.toml"),
    harnesses: {
      chain: ["claude"],
      claude: { bin: "claude", model: "opus", fallbackModel: "sonnet" },
      pi: { bin: "pi", maxPayloadBytes:1_000_000 },
      gemini: { bin: "gemini", model: "" },
    },
    channels: {},
    embeddings: { provider: "none" },
    voice: { provider: "none" },
  };
});

afterEach(async () => {
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

  test("returns 2 when persona dir is missing", async () => {
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
    expect(err.text).toContain("import-persona");
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
