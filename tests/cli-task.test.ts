import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
    harnessIdleTimeoutMs: 1000, harnessHardTimeoutMs: 1000, harnessStartupTimeoutMs: 1000,
    personasDir: join(workdir, "personas"),
    memoryDbPath: join(workdir, "tasks.sqlite"),
    configPath: join(workdir, "config.toml"),
    harnesses: {
      chain: ["claude"],
      claude: { bin: "claude", model: "opus", fallbackModel: "sonnet" },
      pi: { bin: "pi", maxPayloadBytes: 1 },
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

  test("--command stores a direct command task", async () => {
    const out = new CaptureStream();
    const code = await runTaskAdd({
      config,
      store,
      every: "1h",
      prompt: "poll external systems",
      description: "command poll",
      command: "/usr/local/bin/check-notifications",
      out,
      err: new CaptureStream(),
    });
    expect(code).toBe(0);
    expect(out.text).not.toContain("hygiene:");
    const t = store.get(1)!;
    expect(t.command).toBe("/usr/local/bin/check-notifications");
    expect(t.commandSecrets).toEqual([]);
    const showOut = new CaptureStream();
    await runTaskShow({ config, store, id: 1, out: showOut });
    expect(showOut.text).toContain("--- command ---");
    expect(showOut.text).toContain("/usr/local/bin/check-notifications");
  });

  test("--secret stores command env allowlist", async () => {
    const out = new CaptureStream();
    const code = await runTaskAdd({
      config,
      store,
      every: "1h",
      prompt: "poll external systems",
      description: "command poll",
      command: "/usr/local/bin/check-notifications",
      commandSecrets: ["JIRA_API_KEY", " JIRA_API_KEY ", "LINEAR_API_KEY"],
      out,
      err: new CaptureStream(),
    });
    expect(code).toBe(0);
    const t = store.get(1)!;
    expect(t.commandSecrets).toEqual(["JIRA_API_KEY", "LINEAR_API_KEY"]);
    const showOut = new CaptureStream();
    await runTaskShow({ config, store, id: 1, out: showOut });
    expect(showOut.text).toContain("secrets:      JIRA_API_KEY, LINEAR_API_KEY");
  });

  test("--secret requires --command and valid env names", async () => {
    const errNoCommand = new CaptureStream();
    const codeNoCommand = await runTaskAdd({
      config,
      store,
      every: "1h",
      prompt: "poll external systems",
      description: "bad poll",
      commandSecrets: ["JIRA_API_KEY"],
      out: new CaptureStream(),
      err: errNoCommand,
    });
    expect(codeNoCommand).toBe(2);
    expect(errNoCommand.text).toContain("--secret requires --command");

    const errBadName = new CaptureStream();
    const codeBadName = await runTaskAdd({
      config,
      store,
      every: "1h",
      prompt: "poll external systems",
      description: "bad poll",
      command: "/usr/local/bin/check-notifications",
      commandSecrets: ["not-a-var"],
      out: new CaptureStream(),
      err: errBadName,
    });
    expect(codeBadName).toBe(2);
    expect(errBadName.text).toContain("invalid --secret name");
  });

  test("--command rejects empty commands", async () => {
    const err = new CaptureStream();
    const code = await runTaskAdd({
      config,
      store,
      every: "1h",
      prompt: "poll external systems",
      description: "command poll",
      command: "   ",
      out: new CaptureStream(),
      err,
    });
    expect(code).toBe(2);
    expect(err.text).toContain("--command cannot be empty");
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

// ---------------------------------------------------------------------------
// --persona (phantombot#439)
// ---------------------------------------------------------------------------

describe("task --persona", () => {
  beforeEach(async () => {
    await mkdir(join(workdir, "personas", "lena"), { recursive: true });
  });

  test("add files the task against the named persona, not the default", async () => {
    const out = new CaptureStream();
    const code = await runTaskAdd({
      config,
      store,
      persona: "lena",
      relIn: "10m",
      prompt: "check the oven",
      description: "oven",
      out,
      err: new CaptureStream(),
    });
    expect(code).toBe(0);
    expect(store.list("lena", {})).toHaveLength(1);
    expect(store.list("phantom", {})).toHaveLength(0);
  });

  test("the commitment lands in THAT persona's journal", async () => {
    await runTaskAdd({
      config,
      store,
      persona: "lena",
      relIn: "10m",
      prompt: "check the oven",
      description: "oven",
      out: new CaptureStream(),
      err: new CaptureStream(),
    });
    const day = new Date(Date.now() + 10 * 60_000).toISOString().slice(0, 10);
    const journal = await readFile(
      join(workdir, "personas", "lena", "memory", `${day}.md`),
      "utf8",
    );
    expect(journal).toContain("[commitment] task");
  });

  test("an unknown persona is refused — a task that can never fire is worse than an error", async () => {
    const err = new CaptureStream();
    const code = await runTaskAdd({
      config,
      store,
      persona: "ghost",
      relIn: "10m",
      prompt: "x",
      description: "x",
      out: new CaptureStream(),
      err,
    });
    expect(code).toBe(2);
    expect(err.text).toContain("ghost");
    expect(store.list("ghost", {})).toHaveLength(0);
  });

  test("list shows the named persona's tasks", async () => {
    await runTaskAdd({
      config,
      store,
      persona: "lena",
      relIn: "10m",
      prompt: "check the oven",
      description: "oven",
      out: new CaptureStream(),
      err: new CaptureStream(),
    });
    const mine = new CaptureStream();
    await runTaskList({ config, store, persona: "lena", out: mine });
    expect(mine.text).toContain("oven");

    const theirs = new CaptureStream();
    await runTaskList({ config, store, out: theirs });
    expect(theirs.text).toContain("no tasks for persona 'phantom'");
  });

  test("omitting --persona keeps the historical default-persona behaviour", async () => {
    await runTaskAdd({
      config,
      store,
      relIn: "10m",
      prompt: "x",
      description: "x",
      out: new CaptureStream(),
      err: new CaptureStream(),
    });
    expect(store.list("phantom", {})).toHaveLength(1);
  });
});
