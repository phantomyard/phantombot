import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultNightlyDate, runNightly } from "../src/cli/nightly.ts";
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
  workdir = await mkdtemp(join(tmpdir(), "phantombot-ngcli-"));
  await mkdir(join(workdir, "personas", "phantom"), { recursive: true });
  config = {
    defaultPersona: "phantom",
    harnessIdleTimeoutMs: 600_000, harnessHardTimeoutMs: 600_000, harnessStartupTimeoutMs: 600_000,
    personasDir: join(workdir, "personas"),
    memoryDbPath: join(workdir, "memory.sqlite"),
    configPath: join(workdir, "config.toml"),
    harnesses: {
      chain: ["claude"],
      claude: { bin: "claude", model: "opus", fallbackModel: "sonnet" },
      pi: { bin: "pi", maxPayloadBytes: 1_500_000 },
    },
    channels: {},
    embeddings: { provider: "none" },
    voice: { provider: "none" },
  };
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("defaultNightlyDate", () => {
  // The nightly timer fires at 02:00 for the day that just CLOSED. The
  // default date must be yesterday — otherwise the run looks for a daily
  // file that doesn't exist yet and silently no-ops (reported 2026-08-15).
  test("fires 02:00 → returns the day that just closed", () => {
    expect(defaultNightlyDate(new Date(Date.UTC(2026, 7, 15, 2, 0, 0)))).toBe(
      "2026-08-14",
    );
  });

  test("month boundary — Aug 1 → Jul 31", () => {
    expect(defaultNightlyDate(new Date(Date.UTC(2026, 7, 1, 2, 0, 0)))).toBe(
      "2026-07-31",
    );
  });

  test("year boundary — Jan 1 → Dec 31 of prior year", () => {
    expect(defaultNightlyDate(new Date(Date.UTC(2026, 0, 1, 2, 0, 0)))).toBe(
      "2025-12-31",
    );
  });
});

describe("runNightly — early exits", () => {
  test("missing persona → exit 2", async () => {
    const err = new CaptureStream();
    const code = await runNightly({
      config,
      persona: "doesnotexist",
      out: new CaptureStream(),
      err,
    });
    expect(code).toBe(2);
    expect(err.text).toContain("not found");
  });

  test("empty harness chain → exit 2", async () => {
    const err = new CaptureStream();
    const code = await runNightly({
      config: { ...config, harnesses: { ...config.harnesses, chain: [] } },
      out: new CaptureStream(),
      err,
    });
    expect(code).toBe(2);
    expect(err.text).toContain("no harnesses");
  });
});
