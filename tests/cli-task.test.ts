import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runTaskAdd,
  runTaskCancel,
  runTaskList,
  runTaskShow,
} from "../src/cli/task.ts";
import type { Config } from "../src/config.ts";
import { openTaskStore, type TaskStore } from "../src/lib/tasks.ts";

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
let store: TaskStore;
let config: Config;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-task-cli-"));
  store = await openTaskStore(join(workdir, "tasks.sqlite"));
  config = {
    defaultPersona: "phantom",
    harnessIdleTimeoutMs: 1000, harnessHardTimeoutMs: 1000,
    personasDir: join(workdir, "personas"),
    memoryDbPath: join(workdir, "tasks.sqlite"),
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
  await rm(workdir, { recursive: true, force: true });
});

describe("runTaskAdd", () => {
  test("happy path prints id + next run + next review", async () => {
    const out = new CaptureStream();
    const code = await runTaskAdd({
      config,
      store,
      schedule: "0 * * * *",
      prompt: "check email",
      description: "hourly email",
      out,
      err: new CaptureStream(),
    });
    expect(code).toBe(0);
    expect(out.text).toContain("task 1 scheduled");
    expect(out.text).toContain("description: hourly email");
    expect(out.text).toContain("fires at:");
  });

  test("bad cron → exit 2", async () => {
    const err = new CaptureStream();
    const code = await runTaskAdd({
      config,
      store,
      schedule: "junk",
      prompt: "x",
      description: "broken",
      out: new CaptureStream(),
      err,
    });
    expect(code).toBe(2);
    expect(err.text).toContain("bad cron");
  });

  test("--every WITHOUT an expiry succeeds (forever-recurring)", async () => {
    // Used to require --until/--count/--for; expiry is now optional.
    // The agent self-polices via the hygiene footer at fire time.
    const out = new CaptureStream();
    const err = new CaptureStream();
    const code = await runTaskAdd({
      config,
      store,
      every: "1h",
      prompt: "check email",
      description: "hourly email",
      out,
      err,
    });
    expect(code).toBe(0);
    expect(err.text).toBe("");
    expect(out.text).toContain("task 1 scheduled");
    // Echo surfaces the hygiene contract so the agent + user know
    // what they signed up for.
    expect(out.text).toContain("hygiene:");
    expect(out.text).toContain("phantombot task cancel 1");
    // Stored row reflects no expiry.
    const t = store.get(1)!;
    expect(t.expiresAt).toBeUndefined();
    expect(t.maxRuns).toBeUndefined();
    expect(t.oneOff).toBe(false);
  });

  test("--every with --count records maxRuns and skips the hygiene line", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const code = await runTaskAdd({
      config,
      store,
      every: "1h",
      count: 24,
      prompt: "x",
      description: "capped",
      out,
      err,
    });
    expect(code).toBe(0);
    expect(err.text).toBe("");
    expect(out.text).toContain("task 1 scheduled");
    // No hygiene line — user already set an end (24 runs).
    expect(out.text).not.toContain("hygiene:");
    expect(out.text).toContain("24 runs");
    expect(store.get(1)!.maxRuns).toBe(24);
  });

  test("--every with --until records expiresAt", async () => {
    const out = new CaptureStream();
    const code = await runTaskAdd({
      config,
      store,
      every: "1h",
      until: "2026-06-01T00:00:00Z",
      prompt: "x",
      description: "until-bound",
      out,
      err: new CaptureStream(),
    });
    expect(code).toBe(0);
    expect(out.text).not.toContain("hygiene:");
    const t = store.get(1)!;
    expect(t.expiresAt?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });
});

describe("runTaskList", () => {
  test("lists tasks for the configured persona", async () => {
    await runTaskAdd({
      config,
      store,
      schedule: "0 * * * *",
      prompt: "x",
      description: "hourly",
      out: new CaptureStream(),
      err: new CaptureStream(),
    });
    const out = new CaptureStream();
    await runTaskList({ config, store, out });
    expect(out.text).toContain("hourly");
    expect(out.text).toContain("schedule=0 * * * *");
  });

  test("empty list prints friendly placeholder", async () => {
    const out = new CaptureStream();
    await runTaskList({ config, store, out });
    expect(out.text).toContain("(no tasks");
  });
});

describe("runTaskShow + runTaskCancel", () => {
  test("show reveals full detail; cancel deactivates", async () => {
    await runTaskAdd({
      config,
      store,
      schedule: "0 * * * *",
      prompt: "the prompt body",
      description: "x",
      out: new CaptureStream(),
      err: new CaptureStream(),
    });
    const out = new CaptureStream();
    await runTaskShow({ config, store, id: 1, out });
    expect(out.text).toContain("the prompt body");
    expect(out.text).toContain("active:       true");

    const cancelOut = new CaptureStream();
    const code = await runTaskCancel({ config, store, id: 1, out: cancelOut });
    expect(code).toBe(0);
    expect(cancelOut.text).toContain("task 1 cancelled");

    const showOut = new CaptureStream();
    await runTaskShow({ config, store, id: 1, out: showOut });
    expect(showOut.text).toContain("active:       false");
  });

  test("show on missing id → exit 1", async () => {
    const err = new CaptureStream();
    const code = await runTaskShow({
      config,
      store,
      id: 999,
      out: new CaptureStream(),
      err,
    });
    expect(code).toBe(1);
    expect(err.text).toContain("not found");
  });

  test("cancel on missing id → exit 1", async () => {
    const err = new CaptureStream();
    const code = await runTaskCancel({
      config,
      store,
      id: 999,
      out: new CaptureStream(),
      err,
    });
    expect(code).toBe(1);
    expect(err.text).toContain("not found");
  });
});
