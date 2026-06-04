/**
 * Tests for `phantombot run` — focused on the early-exit failure paths.
 * The full Telegram polling loop is exercised by the runTelegramServer
 * tests in tests/channels-telegram.test.ts (now folded into the run cmd).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planListeners, runRun } from "../src/cli/run.ts";
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
        defaultPersona: "ghostfixture",
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

  test("warns but keeps running when a configured harness binary is missing", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    let listenerStarted = false;
    const code = await runRun({
      config: {
        ...config,
        harnesses: { ...config.harnesses, chain: ["pi"] },
        channels: {
          telegram: {
            token: "abc",
            pollTimeoutS: 30,
            allowedUserIds: [],
          },
        },
      },
      lockPath: join(workdir, "run.lock"),
      checkHarnesses: async () => [{ id: "pi", bin: "pi" }],
      runTelegramServer: async () => {
        listenerStarted = true;
      },
      out,
      err,
    });
    expect(code).toBe(0);
    expect(listenerStarted).toBe(true);
    expect(err.text).toContain("configured harness binary not found");
    expect(err.text).toContain("pi: 'pi'");
    expect(err.text).toContain("Phantombot will keep running");
  });

  test("persists resolved harness binaries before starting listeners", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    await runRun({
      config: {
        ...config,
        harnesses: { ...config.harnesses, chain: ["pi"] },
        channels: {
          telegram: {
            token: "abc",
            pollTimeoutS: 30,
            allowedUserIds: [],
          },
        },
      },
      lockPath: join(workdir, "run.lock"),
      checkHarnesses: async () => [
        { id: "pi", bin: "pi", resolved: "/opt/pi-node/bin/pi" },
      ],
      runTelegramServer: async () => {},
      out,
      err,
    });

    const state = JSON.parse(await readFile(join(workdir, "state.json"), "utf8"));
    expect(state.harness_bins.pi).toBe("/opt/pi-node/bin/pi");
  });
});

describe("runRun — multi-persona telegram", () => {
  test("starts when only [channels.telegram.personas.*] is configured (no default block)", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    await mkdir(join(workdir, "personas", "miles"), { recursive: true });
    await writeFile(join(workdir, "personas", "miles", "BOOT.md"), "# Miles");

    const code = await runRun({
      config: {
        ...config,
        harnesses: { ...config.harnesses, chain: [] }, // force early exit after planning
        channels: {
          telegramPersonas: {
            miles: { token: "miles-token", pollTimeoutS: 30, allowedUserIds: [] },
          },
        },
      },
      lockPath: join(workdir, "run.lock"),
      out,
      err,
    });
    // Plan succeeded; failed on empty harness chain (proves planner accepted personas-only setup).
    expect(code).toBe(2);
    expect(err.text).toContain("phantombot harness");
    expect(err.text).not.toContain("phantombot telegram");
  });

  // Direct unit test of planListeners — the runRun() wrapper exits on
  // the empty harness chain before printing its listener table, so the
  // only way to assert on the planner output is to call it directly.
  test("planListeners builds one listener per configured persona, in order", async () => {
    const err = new CaptureStream();
    await mkdir(join(workdir, "personas", "miles"), { recursive: true });
    await writeFile(join(workdir, "personas", "miles", "BOOT.md"), "# Miles");
    await mkdir(join(workdir, "personas", "desiree"), { recursive: true });
    await writeFile(join(workdir, "personas", "desiree", "BOOT.md"), "# Desiree");

    const plan = planListeners(
      {
        ...config,
        channels: {
          telegram: { token: "default-tok", pollTimeoutS: 30, allowedUserIds: [1] },
          telegramPersonas: {
            miles: { token: "miles-tok", pollTimeoutS: 30, allowedUserIds: [2] },
            desiree: { token: "desiree-tok", pollTimeoutS: 30, allowedUserIds: [3] },
          },
        },
      },
      "phantom",
      err,
    );

    expect(plan.fatal).toBeUndefined();
    expect(plan.listeners).toHaveLength(3);

    // Default listener is first (defines the admin channel).
    expect(plan.listeners[0]).toMatchObject({
      persona: "phantom",
      source: "default",
      account: { token: "default-tok" },
    });

    // Persona listeners follow, each bound to its own bot + agentDir.
    const byPersona = Object.fromEntries(
      plan.listeners.map((l) => [l.persona, l]),
    );
    expect(byPersona.miles).toMatchObject({
      source: "personas.miles",
      account: { token: "miles-tok", allowedUserIds: [2] },
    });
    expect(byPersona.miles!.agentDir).toBe(join(workdir, "personas", "miles"));
    expect(byPersona.desiree).toMatchObject({
      source: "personas.desiree",
      account: { token: "desiree-tok", allowedUserIds: [3] },
    });
    expect(byPersona.desiree!.agentDir).toBe(
      join(workdir, "personas", "desiree"),
    );

    // Tokens are all distinct (the duplicate-token guard didn't trip).
    const tokens = plan.listeners.map((l) => l.account.token);
    expect(new Set(tokens).size).toBe(3);
  });

  test("planListeners returns personas-only listeners when no default block is set", async () => {
    const err = new CaptureStream();
    await mkdir(join(workdir, "personas", "miles"), { recursive: true });
    await writeFile(join(workdir, "personas", "miles", "BOOT.md"), "# Miles");

    const plan = planListeners(
      {
        ...config,
        channels: {
          telegramPersonas: {
            miles: { token: "miles-tok", pollTimeoutS: 30, allowedUserIds: [] },
          },
        },
      },
      "phantom",
      err,
    );

    expect(plan.fatal).toBeUndefined();
    expect(plan.listeners).toHaveLength(1);
    expect(plan.listeners[0]!.source).toBe("personas.miles");
    expect(plan.listeners.find((l) => l.source === "default")).toBeUndefined();
  });

  test("skips a persona block whose agent dir is missing but keeps the others", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    // 'phantom' (default) exists from beforeEach; 'miles' is configured but missing on disk.

    const code = await runRun({
      config: {
        ...config,
        harnesses: { ...config.harnesses, chain: [] },
        channels: {
          telegram: { token: "default-tok", pollTimeoutS: 30, allowedUserIds: [] },
          telegramPersonas: {
            miles: { token: "miles-tok", pollTimeoutS: 30, allowedUserIds: [] },
          },
        },
      },
      lockPath: join(workdir, "run.lock"),
      out,
      err,
    });
    expect(code).toBe(2); // empty harness chain (planner did NOT fatal)
    expect(err.text).toContain("phantombot harness");
    expect(err.text).toContain("personas.miles");
    expect(err.text).toContain("no agent dir");
  });

  test("fatal when default + persona share the same token", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    await mkdir(join(workdir, "personas", "miles"), { recursive: true });
    await writeFile(join(workdir, "personas", "miles", "BOOT.md"), "# Miles");

    const code = await runRun({
      config: {
        ...config,
        channels: {
          telegram: { token: "shared", pollTimeoutS: 30, allowedUserIds: [] },
          telegramPersonas: {
            miles: { token: "shared", pollTimeoutS: 30, allowedUserIds: [] },
          },
        },
      },
      lockPath: join(workdir, "run.lock"),
      out,
      err,
    });
    expect(code).toBe(2);
    expect(err.text).toMatch(/token reused/);
  });

  test("fatal when two persona entries share the same token", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    await mkdir(join(workdir, "personas", "miles"), { recursive: true });
    await writeFile(join(workdir, "personas", "miles", "BOOT.md"), "# Miles");
    await mkdir(join(workdir, "personas", "desiree"), { recursive: true });
    await writeFile(join(workdir, "personas", "desiree", "BOOT.md"), "# Desiree");

    const code = await runRun({
      config: {
        ...config,
        channels: {
          telegramPersonas: {
            miles: { token: "shared", pollTimeoutS: 30, allowedUserIds: [] },
            desiree: { token: "shared", pollTimeoutS: 30, allowedUserIds: [] },
          },
        },
      },
      lockPath: join(workdir, "run.lock"),
      out,
      err,
    });
    expect(code).toBe(2);
    expect(err.text).toMatch(/token reused/);
  });

  test("returns 2 when every configured persona is missing", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    // No default block, miles configured but no miles persona on disk.
    const code = await runRun({
      config: {
        ...config,
        channels: {
          telegramPersonas: {
            miles: { token: "miles-tok", pollTimeoutS: 30, allowedUserIds: [] },
          },
        },
      },
      lockPath: join(workdir, "run.lock"),
      out,
      err,
    });
    expect(code).toBe(2);
    expect(err.text).toContain("no telegram listeners could be started");
  });
});
