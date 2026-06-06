import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewForLog, runTick } from "../src/cli/tick.ts";
import type { Config } from "../src/config.ts";
import type {
  Harness,
  HarnessChunk,
  HarnessRequest,
} from "../src/harnesses/types.ts";
import { openTaskStore, type TaskStore } from "../src/lib/tasks.ts";
import { openMemoryStore, type MemoryStore } from "../src/memory/store.ts";

// Test seam: capture any HTTP egress so a quiet-by-default regression
// (tick trying to POST to the Telegram API on every fire) fails loud
// instead of silently working in the test environment.
type FetchCall = { url: string; init?: RequestInit };

// Hostname-precise match — substring matching against arbitrary URLs is
// what CodeQL's "Incomplete URL substring sanitization" rule flags, even
// in test code. Use the parsed hostname so we never accept e.g.
// `https://evil.com/api.telegram.org/x`.
function isTelegramApiUrl(u: string): boolean {
  try {
    return new URL(u).hostname === "api.telegram.org";
  } catch {
    return false;
  }
}
function installFetchTrap(): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function captureStdout(): {
  lines: string[];
  restore: () => void;
} {
  const lines: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    lines,
    restore: () => {
      process.stdout.write = original;
    },
  };
}

function parseJsonLogLines(lines: string[]): Array<Record<string, unknown>> {
  return lines
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

class ScriptedHarness implements Harness {
  invocations = 0;
  lastUserMessage?: string;
  constructor(
    public readonly id: string,
    private readonly script: HarnessChunk[],
  ) {}
  async available(): Promise<boolean> {
    return true;
  }
  async *invoke(req: HarnessRequest): AsyncGenerator<HarnessChunk> {
    this.invocations++;
    this.lastUserMessage = req.userMessage;
    for (const c of this.script) yield c;
  }
}

let workdir: string;
let store: TaskStore;
let memory: MemoryStore;
let config: Config;
let lockPath: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-tick-"));
  // Redirect the timer-fired marker path so runTick writes into the
  // test workdir, not the developer's real ~/.local/state/.
  process.env.XDG_STATE_HOME = workdir;
  store = await openTaskStore(join(workdir, "tasks.sqlite"));
  memory = await openMemoryStore(join(workdir, "memory.sqlite"));
  lockPath = join(workdir, "tick.lock");

  // Build a minimal persona dir so runTurn's loadPersona works.
  const personaDir = join(workdir, "personas", "phantom");
  await mkdir(personaDir, { recursive: true });
  await writeFile(join(personaDir, "BOOT.md"), "# Phantom\n", "utf8");

  config = {
    defaultPersona: "phantom",
    harnessIdleTimeoutMs: 5000, harnessHardTimeoutMs: 5000,
    personasDir: join(workdir, "personas"),
    memoryDbPath: join(workdir, "memory.sqlite"),
    configPath: join(workdir, "config.toml"),
    harnesses: {
      chain: ["claude"],
      claude: { bin: "claude", model: "opus", fallbackModel: "sonnet" },
      pi: { bin: "pi", maxPayloadBytes: 1 },
      gemini: { bin: "gemini", model: "" },
    },
    channels: {},
    embeddings: { provider: "none" },
    voice: { provider: "none" },
  };
});

afterEach(async () => {
  store.close();
  await memory.close();
  await rm(workdir, { recursive: true, force: true });
});

describe("runTick — no-op cases", () => {
  test("no due tasks → exit 0, no harness calls", async () => {
    const harness = new ScriptedHarness("h", [
      { type: "done", finalText: "should not run" },
    ]);
    const code = await runTick({
      config,
      taskStore: store,
      memory,
      harnesses: [harness],
      lockPath,
      now: new Date("2026-05-02T09:00:00Z"),
    });
    expect(code).toBe(0);
    expect(harness.invocations).toBe(0);
  });

  test("even a no-due-tasks tick records a fire-marker", async () => {
    const harness = new ScriptedHarness("h", [
      { type: "done", finalText: "unused" },
    ]);
    await runTick({
      config,
      taskStore: store,
      memory,
      harnesses: [harness],
      lockPath,
      now: new Date("2026-05-02T09:00:00Z"),
    });
    // Use a deferred import so we read XDG_STATE_HOME at call time.
    const { tickMarkerPath } = await import("../src/lib/timerHealth.ts");
    const { existsSync } = await import("node:fs");
    expect(existsSync(tickMarkerPath())).toBe(true);
  });
});

describe("runTick — normal task fire", () => {
  test("background agent wake logs lifecycle and stream chunks without Telegram delivery", async () => {
    const created = store.add({
      persona: "phantom",
      description: "hourly check",
      schedule: "0 * * * *",
      prompt: "do the thing",
      now: new Date("2026-05-02T09:30:00Z"),
    });
    if (!created.ok) throw new Error("setup");
    const harness = new ScriptedHarness("h", [
      { type: "progress", note: "checking repo" },
      { type: "text", text: "partial " },
      { type: "done", finalText: "partial done" },
    ]);
    const capture = captureStdout();
    const trap = installFetchTrap();
    try {
      await runTick({
        config,
        taskStore: store,
        memory,
        harnesses: [harness],
        lockPath,
        out: { write() {} },
        now: new Date("2026-05-02T10:00:00Z"),
      });
    } finally {
      capture.restore();
      trap.restore();
    }

    const logs = parseJsonLogLines(capture.lines);
    const telegramCalls = trap.calls.filter((c) => isTelegramApiUrl(c.url));
    expect(telegramCalls).toEqual([]);
    expect(logs).toContainEqual(expect.objectContaining({
      msg: "tick: background wake started",
      taskId: created.id,
      persona: "phantom",
      conversation: `tick:${created.id}`,
      isReview: false,
    }));
    expect(logs).toContainEqual(expect.objectContaining({
      msg: "tick: background wake stream",
      taskId: created.id,
      chunkType: "progress",
      preview: "checking repo",
      truncated: false,
    }));
    expect(logs).toContainEqual(expect.objectContaining({
      msg: "tick: background wake stream",
      taskId: created.id,
      chunkType: "text",
      preview: "partial ",
      chars: 8,
    }));
    expect(logs).toContainEqual(expect.objectContaining({
      msg: "tick: background wake completed",
      taskId: created.id,
      status: "ok",
      outputChars: 12,
    }));
  });

  test("background wake previews redact obvious secrets and cap long chunks", () => {
    const token = "ghp_" + "a".repeat(36);
    const preview = previewForLog(
      `GITHUB_TOKEN=${token} email andrew@example.com ${"x".repeat(2100)}`,
    );
    expect(preview.truncated).toBe(true);
    expect(preview.preview).toContain("GITHUB_TOKEN=[REDACTED]");
    expect(preview.preview).toContain("[EMAIL_REDACTED]");
    expect(preview.preview).not.toContain(token);
    expect(preview.preview.length).toBeLessThanOrEqual(2000);
  });

  test("command-backed due task gets only explicitly requested secrets", async () => {
    const oldSecret = process.env.PHANTOMBOT_TEST_SECRET;
    const oldOther = process.env.PHANTOMBOT_TEST_OTHER_SECRET;
    process.env.PHANTOMBOT_TEST_SECRET = "visible";
    process.env.PHANTOMBOT_TEST_OTHER_SECRET = "hidden";
    try {
      const markerPath = join(workdir, "command-env.txt");
      const created = store.add({
        persona: "phantom",
        description: "command poll",
        schedule: "0 * * * *",
        prompt: "audit context only",
        command:
          `printf "%s/%s" "$PHANTOMBOT_TEST_SECRET" "$PHANTOMBOT_TEST_OTHER_SECRET" > ${markerPath}`,
        commandSecrets: ["PHANTOMBOT_TEST_SECRET"],
        reviewIntervalMs: 1,
        now: new Date("2026-05-02T09:30:00Z"),
      });
      if (!created.ok) throw new Error("setup");
      const code = await runTick({
        config,
        taskStore: store,
        memory,
        harnesses: [
          new ScriptedHarness("h", [{ type: "done", finalText: "should not run" }]),
        ],
        lockPath,
        now: new Date("2026-05-02T10:00:00Z"),
      });
      expect(code).toBe(0);
      expect(await readFile(markerPath, "utf8")).toBe("visible/");
    } finally {
      if (oldSecret === undefined) delete process.env.PHANTOMBOT_TEST_SECRET;
      else process.env.PHANTOMBOT_TEST_SECRET = oldSecret;
      if (oldOther === undefined) delete process.env.PHANTOMBOT_TEST_OTHER_SECRET;
      else process.env.PHANTOMBOT_TEST_OTHER_SECRET = oldOther;
    }
  });

  test("command-backed due task runs without invoking any harness", async () => {
    const markerPath = join(workdir, "command-ran.txt");
    const created = store.add({
      persona: "phantom",
      description: "command poll",
      schedule: "0 * * * *",
      prompt: "audit context only",
      command: `printf ok > ${markerPath}`,
      reviewIntervalMs: 1,
      now: new Date("2026-05-02T09:30:00Z"),
    });
    if (!created.ok) throw new Error("setup");
    const harness = new ScriptedHarness("h", [
      { type: "done", finalText: "should not run" },
    ]);
    const code = await runTick({
      config,
      taskStore: store,
      memory,
      harnesses: [harness],
      lockPath,
      now: new Date("2026-05-02T10:00:00Z"),
    });
    expect(code).toBe(0);
    expect(harness.invocations).toBe(0);
    expect(await readFile(markerPath, "utf8")).toBe("ok");
    const t = store.get(created.id)!;
    expect(t.runCount).toBe(1);
    expect(t.active).toBe(true);
    const runs = store.taskRuns(created.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("ok");
  });

  test("command-backed task failure is logged and still advances", async () => {
    const created = store.add({
      persona: "phantom",
      description: "failing command poll",
      schedule: "0 * * * *",
      prompt: "audit context only",
      command: "printf failed >&2; exit 7",
      reviewIntervalMs: 1,
      now: new Date("2026-05-02T09:30:00Z"),
    });
    if (!created.ok) throw new Error("setup");
    const harness = new ScriptedHarness("h", [
      { type: "done", finalText: "should not run" },
    ]);
    const code = await runTick({
      config,
      taskStore: store,
      memory,
      harnesses: [harness],
      lockPath,
      now: new Date("2026-05-02T10:00:00Z"),
    });
    expect(code).toBe(0);
    expect(harness.invocations).toBe(0);
    const t = store.get(created.id)!;
    expect(t.runCount).toBe(1);
    expect(t.nextRunAt.toISOString()).toBe("2026-05-02T11:00:00.000Z");
    const runs = store.taskRuns(created.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("error");
    expect(runs[0]!.exitCode).toBe(7);
    expect(runs[0]!.outputExcerpt).toContain("command exited 7");
    expect(runs[0]!.outputExcerpt).toContain("failed");
  });

  test("due task runs with its prompt; recordRun advances next_run_at", async () => {
    const created = store.add({
      persona: "phantom",
      description: "hourly check",
      schedule: "0 * * * *",
      prompt: "do the thing",
      // Forever-recurring (no expiry) — fires get the hygiene footer.
      now: new Date("2026-05-02T09:30:00Z"),
    });
    if (!created.ok) throw new Error("setup");
    const harness = new ScriptedHarness("h", [
      { type: "text", text: "result" },
      { type: "done", finalText: "result" },
    ]);
    // Simulate the 10:00 tick.
    const code = await runTick({
      config,
      taskStore: store,
      memory,
      harnesses: [harness],
      lockPath,
      now: new Date("2026-05-02T10:00:00Z"),
    });
    expect(code).toBe(0);
    expect(harness.invocations).toBe(1);
    // The original prompt is still there...
    expect(harness.lastUserMessage).toContain("do the thing");
    // ...followed by the hygiene footer because there's no expiry.
    expect(harness.lastUserMessage).toContain("Task hygiene");
    expect(harness.lastUserMessage).toContain(
      `phantombot task cancel ${created.id}`,
    );
    // After recordRun, next_run_at moved to 11:00.
    const t = store.get(created.id)!;
    expect(t.runCount).toBe(1);
    expect(t.nextRunAt.toISOString()).toBe("2026-05-02T11:00:00.000Z");
  });

  test("recurring task WITH an expiry skips the hygiene footer", async () => {
    const created = store.add({
      persona: "phantom",
      description: "hourly check, capped",
      schedule: "0 * * * *",
      prompt: "do the thing",
      expiresAt: new Date("2026-05-09T00:00:00Z"),
      now: new Date("2026-05-02T09:30:00Z"),
    });
    if (!created.ok) throw new Error("setup");
    const harness = new ScriptedHarness("h", [
      { type: "done", finalText: "result" },
    ]);
    await runTick({
      config,
      taskStore: store,
      memory,
      harnesses: [harness],
      lockPath,
      now: new Date("2026-05-02T10:00:00Z"),
    });
    // No footer when the user has already set an end-date.
    expect(harness.lastUserMessage).toBe("do the thing");
  });

  test("one-off task skips the hygiene footer (it's self-deleting)", async () => {
    const created = store.add({
      persona: "phantom",
      description: "wake me up",
      schedule: "",
      prompt: "do the thing",
      oneOff: true,
      nextRunAt: new Date("2026-05-02T10:00:00Z"),
      now: new Date("2026-05-02T09:30:00Z"),
    });
    if (!created.ok) throw new Error("setup");
    const harness = new ScriptedHarness("h", [
      { type: "done", finalText: "result" },
    ]);
    await runTick({
      config,
      taskStore: store,
      memory,
      harnesses: [harness],
      lockPath,
      now: new Date("2026-05-02T10:00:00Z"),
    });
    expect(harness.lastUserMessage).toBe("do the thing");
  });
});

describe("runTick — review path", () => {
  test("when next_review_at has passed, runs the review prompt instead", async () => {
    // Create a task with a 1ms review interval so review fires immediately.
    const created = store.add({
      persona: "phantom",
      description: "x",
      schedule: "0 * * * *",
      prompt: "the normal prompt",
      reviewIntervalMs: 1,
      now: new Date("2026-05-02T09:30:00Z"),
    });
    if (!created.ok) throw new Error("setup");
    const harness = new ScriptedHarness("h", [
      { type: "done", finalText: "STOP — no longer needed" },
    ]);
    const code = await runTick({
      config,
      taskStore: store,
      memory,
      harnesses: [harness],
      lockPath,
      now: new Date("2026-05-02T10:00:00Z"),
    });
    expect(code).toBe(0);
    expect(harness.invocations).toBe(1);
    // It should be the REVIEW prompt, not the normal one.
    expect(harness.lastUserMessage).toContain("Self-review");
    expect(harness.lastUserMessage).toContain("KEEP / STOP / MODIFY");
    expect(harness.lastUserMessage).not.toBe("the normal prompt");
    // STOP reply → task deactivated.
    const t = store.get(created.id)!;
    expect(t.active).toBe(false);
    expect(t.reviewCount).toBe(1);
  });

  test("KEEP review reply doubles next_review_at and leaves task active", async () => {
    const created = store.add({
      persona: "phantom",
      description: "x",
      schedule: "0 * * * *",
      prompt: "normal",
      reviewIntervalMs: 1,
      now: new Date("2026-05-02T09:30:00Z"),
    });
    if (!created.ok) throw new Error("setup");
    const harness = new ScriptedHarness("h", [
      { type: "done", finalText: "KEEP — still useful" },
    ]);
    await runTick({
      config,
      taskStore: store,
      memory,
      harnesses: [harness],
      lockPath,
      now: new Date("2026-05-02T10:00:00Z"),
    });
    const t = store.get(created.id)!;
    expect(t.active).toBe(true);
    // Next review pushed forward by at least 1 day (the floor in
    // recordReview kicks in for very-short intervals).
    expect(t.nextReviewAt.getTime()).toBeGreaterThan(
      new Date("2026-05-02T10:00:00Z").getTime() + 23 * 60 * 60 * 1000,
    );
  });

  test("ambiguous reply defaults to KEEP (don't silently lose the user's task)", async () => {
    const created = store.add({
      persona: "phantom",
      description: "x",
      schedule: "0 * * * *",
      prompt: "normal",
      reviewIntervalMs: 1,
      now: new Date("2026-05-02T09:30:00Z"),
    });
    if (!created.ok) throw new Error("setup");
    const harness = new ScriptedHarness("h", [
      { type: "done", finalText: "uh, I'm not sure" },
    ]);
    await runTick({
      config,
      taskStore: store,
      memory,
      harnesses: [harness],
      lockPath,
      now: new Date("2026-05-02T10:00:00Z"),
    });
    expect(store.get(created.id)!.active).toBe(true);
  });
});

describe("runTick — lockfile", () => {
  test("if a previous tick lock is held, this tick exits 0 and no tasks run", async () => {
    // Pre-create a lockfile owned by the current PID — acquireRunLock
    // sees the holder is alive (us!) and refuses.
    await writeFile(lockPath, String(process.pid), { encoding: "utf8" });
    store.add({
      persona: "phantom",
      description: "x",
      schedule: "* * * * *",
      prompt: "x",
      now: new Date("2026-05-02T09:30:00Z"),
    });
    const harness = new ScriptedHarness("h", [
      { type: "done", finalText: "x" },
    ]);
    const code = await runTick({
      config,
      taskStore: store,
      memory,
      harnesses: [harness],
      lockPath,
      now: new Date("2026-05-02T10:00:00Z"),
    });
    expect(code).toBe(0);
    expect(harness.invocations).toBe(0);
  });
});

describe("runTick — quiet-by-default (no auto-Telegram delivery)", () => {
  // The system prompt promises tick fires are silent unless the agent
  // explicitly calls `phantombot notify`. These tests pin that contract
  // so the regression that produced PR #117 can't sneak back in.

  test("a fired task with Telegram fully configured does NOT post to the Telegram API", async () => {
    const created = store.add({
      persona: "phantom",
      description: "should be silent",
      schedule: "0 * * * *",
      prompt: "x",
      now: new Date("2026-05-02T09:30:00Z"),
    });
    if (!created.ok) throw new Error("setup");

    const configWithTelegram: Config = {
      ...config,
      channels: {
        telegram: {
          token: "fake-token",
          pollTimeoutS: 30,
          allowedUserIds: [12345],
        },
      },
    };

    const harness = new ScriptedHarness("h", [
      { type: "done", finalText: "this is the agent's reply — nothing material" },
    ]);
    const trap = installFetchTrap();
    try {
      await runTick({
        config: configWithTelegram,
        taskStore: store,
        memory,
        harnesses: [harness],
        lockPath,
        now: new Date("2026-05-02T10:00:00Z"),
      });
    } finally {
      trap.restore();
    }
    // No Telegram API call at all — tick is the wrong place for it.
    const telegramCalls = trap.calls.filter((c) => isTelegramApiUrl(c.url));
    expect(telegramCalls).toEqual([]);
    // Run row records the fire but `delivered` is false (we never auto-deliver).
    const runs = store.taskRuns(created.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.delivered).toBe(false);
  });

  test("legacy `silent: true` tasks also fire silently — the field is a no-op", async () => {
    const created = store.add({
      persona: "phantom",
      description: "legacy quiet flag",
      schedule: "0 * * * *",
      prompt: "x",
      silent: true,
      now: new Date("2026-05-02T09:30:00Z"),
    });
    if (!created.ok) throw new Error("setup");
    const configWithTelegram: Config = {
      ...config,
      channels: {
        telegram: {
          token: "fake-token",
          pollTimeoutS: 30,
          allowedUserIds: [12345],
        },
      },
    };
    const harness = new ScriptedHarness("h", [
      { type: "done", finalText: "still silent" },
    ]);
    const trap = installFetchTrap();
    try {
      await runTick({
        config: configWithTelegram,
        taskStore: store,
        memory,
        harnesses: [harness],
        lockPath,
        now: new Date("2026-05-02T10:00:00Z"),
      });
    } finally {
      trap.restore();
    }
    expect(trap.calls.filter((c) => isTelegramApiUrl(c.url))).toEqual([]);
  });
});

describe("runTick — failure resilience", () => {
  test("if a task throws, we still advance next_run_at so it doesn't refire forever", async () => {
    const created = store.add({
      persona: "phantom",
      description: "x",
      schedule: "0 * * * *",
      prompt: "x",
      now: new Date("2026-05-02T09:30:00Z"),
    });
    if (!created.ok) throw new Error("setup");
    class ThrowingHarness implements Harness {
      readonly id = "throw";
      async available() {
        return true;
      }
      async *invoke(): AsyncGenerator<HarnessChunk> {
        throw new Error("boom");
      }
    }
    await runTick({
      config,
      taskStore: store,
      memory,
      harnesses: [new ThrowingHarness()],
      lockPath,
      now: new Date("2026-05-02T10:00:00Z"),
    });
    const t = store.get(created.id)!;
    // next_run_at advanced past 10:00 (so the next tick won't immediately re-fire).
    expect(t.nextRunAt.getTime()).toBeGreaterThan(
      new Date("2026-05-02T10:00:00Z").getTime(),
    );
  });
});
