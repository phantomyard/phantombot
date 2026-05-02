import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTick } from "../src/cli/tick.ts";
import type { Config } from "../src/config.ts";
import type {
  Harness,
  HarnessChunk,
  HarnessRequest,
} from "../src/harnesses/types.ts";
import { openTaskStore, type TaskStore } from "../src/lib/tasks.ts";
import { openMemoryStore, type MemoryStore } from "../src/memory/store.ts";

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
  store = await openTaskStore(join(workdir, "tasks.sqlite"));
  memory = await openMemoryStore(join(workdir, "memory.sqlite"));
  lockPath = join(workdir, "tick.lock");

  // Build a minimal persona dir so runTurn's loadPersona works.
  const personaDir = join(workdir, "personas", "phantom");
  await mkdir(personaDir, { recursive: true });
  await writeFile(join(personaDir, "BOOT.md"), "# Phantom\n", "utf8");

  config = {
    defaultPersona: "phantom",
    turnTimeoutMs: 5000,
    personasDir: join(workdir, "personas"),
    memoryDbPath: join(workdir, "memory.sqlite"),
    configPath: join(workdir, "config.toml"),
    harnesses: {
      chain: ["claude"],
      claude: { bin: "claude", model: "opus", fallbackModel: "sonnet" },
      pi: { bin: "pi", maxPayloadBytes:1 },
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
});

describe("runTick — normal task fire", () => {
  test("due task runs with its prompt; recordRun advances next_run_at", async () => {
    const created = store.add({
      persona: "phantom",
      description: "hourly check",
      schedule: "0 * * * *",
      prompt: "do the thing",
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
    expect(harness.lastUserMessage).toBe("do the thing");
    // After recordRun, next_run_at moved to 11:00.
    const t = store.get(created.id)!;
    expect(t.runCount).toBe(1);
    expect(t.nextRunAt.toISOString()).toBe("2026-05-02T11:00:00.000Z");
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
