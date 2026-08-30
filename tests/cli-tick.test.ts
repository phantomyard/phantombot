import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
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
import { acquireRunLock, isLockHandle } from "../src/lib/runLock.ts";
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

function captureStream(which: "stdout" | "stderr"): {
  lines: string[];
  restore: () => void;
} {
  const lines: string[] = [];
  const original = process[which].write;
  process[which].write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    lines,
    restore: () => {
      process[which].write = original;
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
  lastRequest?: HarnessRequest;
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
    this.lastRequest = req;
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
    harnessIdleTimeoutMs: 5000, harnessHardTimeoutMs: 5000, harnessStartupTimeoutMs: 5000,
    personasDir: join(workdir, "personas"),
    memoryDbPath: join(workdir, "memory.sqlite"),
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
  test("builds the scheduled task chain for its persona", async () => {
    await mkdir(join(workdir, "personas", "amanda"), { recursive: true });
    await writeFile(join(workdir, "personas", "amanda", "BOOT.md"), "# Amanda");
    const created = store.add({
      persona: "amanda",
      description: "Amanda check",
      schedule: "0 * * * *",
      prompt: "do the thing",
      now: new Date("2026-05-02T09:30:00Z"),
    });
    if (!created.ok) throw new Error("setup");

    const harness = new ScriptedHarness("amanda-primary", [
      { type: "done", finalText: "done" },
    ]);
    const resolvedPersonas: Array<string | undefined> = [];

    const code = await runTick({
      config,
      taskStore: store,
      memory,
      buildHarnesses: (_config, _err, persona) => {
        resolvedPersonas.push(persona);
        return [harness];
      },
      lockPath,
      out: { write() {} },
      now: new Date("2026-05-02T10:00:00Z"),
    });

    expect(code).toBe(0);
    expect(resolvedPersonas).toEqual(["amanda"]);
    expect(harness.invocations).toBe(1);
  });

  test("a task fires under ITS persona's effective config, not the default's", async () => {
    // The row stores the persona; the SETTINGS that decide how the wake
    // behaves — harness chain, idle timeout, retrieval — live in that
    // persona's own config.toml (phantombot#439). Before this, tick loaded the
    // default persona's config once and used it for every due task, so a task
    // added with `--persona lena` ran on the wrong policy entirely.
    await mkdir(join(workdir, "personas", "lena"), { recursive: true });
    await writeFile(join(workdir, "personas", "lena", "BOOT.md"), "# Lena");
    const created = store.add({
      persona: "lena",
      description: "Lena check",
      schedule: "0 * * * *",
      prompt: "do the thing",
      now: new Date("2026-05-02T09:30:00Z"),
    });
    if (!created.ok) throw new Error("setup");

    const lenaConfig = {
      ...config,
      personaLayer: "lena",
      harnessIdleTimeoutMs: 4242,
    };
    const asked: string[] = [];
    const harness = new ScriptedHarness("h", [
      { type: "done", finalText: "done" },
    ]);
    const seenConfigs: number[] = [];

    const code = await runTick({
      config,
      taskStore: store,
      memory,
      loadPersonaConfig: async (persona) => {
        asked.push(persona);
        return lenaConfig;
      },
      buildHarnesses: (cfg, _err, _persona) => {
        seenConfigs.push(cfg.harnessIdleTimeoutMs);
        return [harness];
      },
      lockPath,
      out: { write() {} },
      now: new Date("2026-05-02T10:00:00Z"),
    });

    expect(code).toBe(0);
    expect(asked).toEqual(["lena"]);
    expect(seenConfigs).toEqual([4242]);
    expect(harness.lastRequest?.idleTimeoutMs).toBe(4242);
  });

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
    const capture = captureStream("stderr");
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

  test("agent-woken task down-tiers BOTH turns to `other`", async () => {
    // #324 + review: a task can ingest UNTRUSTED content mid-turn (email/web)
    // that the threat judge never screened, so every fact it produces must land
    // in the untrusted `other` tier — never `self`. Both the user turn and the
    // assistant reply (the laundering vector) are stamped `other`.
    const created = store.add({
      persona: "phantom",
      description: "hourly check",
      schedule: "0 * * * *",
      prompt: "do the thing",
      now: new Date("2026-05-02T09:30:00Z"),
    });
    if (!created.ok) throw new Error("setup");

    const pairCalls: Array<{
      user: { source?: string };
      assistant: { source?: string };
    }> = [];
    const spied = new Proxy(memory, {
      get(target, prop, receiver) {
        if (prop === "appendTurnPair") {
          return async (
            user: { source?: string },
            assistant: { source?: string },
          ) => {
            pairCalls.push({ user, assistant });
            return (
              memory.appendTurnPair as (u: unknown, a: unknown) => Promise<void>
            )(user, assistant);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    await runTick({
      config,
      taskStore: store,
      memory: spied,
      harnesses: [new ScriptedHarness("h", [{ type: "done", finalText: "ok" }])],
      lockPath,
      out: { write() {} },
      now: new Date("2026-05-02T10:00:00Z"),
    });

    expect(pairCalls).toHaveLength(1);
    expect(pairCalls[0]!.user.source).toBe("other");
    expect(pairCalls[0]!.assistant.source).toBe("other");
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

  test("a command task is told which persona owns it (#505)", async () => {
    // The documented contract tells a poller to shell back into `phantombot`
    // (ask / notify / mcp call / memory). Those resolve --persona, then
    // PHANTOMBOT_PERSONA, then the HOST DEFAULT — so with no PHANTOMBOT_PERSONA
    // in the command env, every poller silently ran against the default
    // persona's vault, memory and MCP registry instead of its own.
    const oldEnv = process.env.PHANTOMBOT_PERSONA;
    // An ambient value from the tick process itself must not win over the
    // task's own owner.
    process.env.PHANTOMBOT_PERSONA = "someoneelse";
    try {
      await mkdir(join(workdir, "personas", "kai"), { recursive: true });
      const markerPath = join(workdir, "command-persona.txt");
      const created = store.add({
        persona: "kai",
        description: "command poll",
        schedule: "0 * * * *",
        prompt: "audit context only",
        command: `printf "[%s]" "$PHANTOMBOT_PERSONA" > ${markerPath}`,
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
      expect(await readFile(markerPath, "utf8")).toBe("[kai]");
    } finally {
      if (oldEnv === undefined) delete process.env.PHANTOMBOT_PERSONA;
      else process.env.PHANTOMBOT_PERSONA = oldEnv;
    }
  });

  test("--secret resolves from the TASK's persona vault, not the startup persona's", async () => {
    // One tick process runs tasks for EVERY persona, but only the startup
    // persona's vault is injected into process.env. Reading the ambient env
    // here would hand kai's poller robbie's credential.
    const { openPersonaVault } = await import("../src/lib/vault.ts");
    for (const [persona, value] of [
      ["phantom", "default-persona-value"],
      ["kai", "kai-value"],
    ] as const) {
      await mkdir(join(workdir, "personas", persona), { recursive: true });
      const v = await openPersonaVault(join(workdir, "personas", persona));
      try {
        v.set("SHARED_SECRET", value);
      } finally {
        v.close();
      }
    }
    await writeFile(join(workdir, "personas", "kai", "BOOT.md"), "# Kai\n", "utf8");

    const markerPath = join(workdir, "kai-secret.txt");
    const created = store.add({
      persona: "kai",
      description: "kai poll",
      schedule: "0 * * * *",
      prompt: "audit context only",
      command: `printf "%s" "$SHARED_SECRET" > ${markerPath}`,
      commandSecrets: ["SHARED_SECRET"],
      reviewIntervalMs: 1,
      now: new Date("2026-05-02T09:30:00Z"),
    });
    if (!created.ok) throw new Error("setup");

    const code = await runTick({
      config,
      taskStore: store,
      memory,
      // kai's layer resolves to the same fixture tree — the point under test is
      // WHICH persona's vault the secret comes from, not config loading.
      loadPersonaConfig: async (persona) => ({ ...config, personaLayer: persona }),
      harnesses: [
        new ScriptedHarness("h", [{ type: "done", finalText: "should not run" }]),
      ],
      lockPath,
      now: new Date("2026-05-02T10:00:00Z"),
    });
    expect(code).toBe(0);
    expect(await readFile(markerPath, "utf8")).toBe("kai-value");
  });

  test("a transient vault failure still passes the persona's OWN injected secret", async () => {
    // The other side of the guard: loadVaultIntoEnv leaves injected keys in
    // place when the SAME persona's vault fails to open transiently, so
    // refusing the ambient value would starve kai's poller of kai's own
    // credential. Simulated by removing the vault file after injection.
    const { openPersonaVault, loadVaultIntoEnv, vaultPath, _resetVaultTrackingForTesting } =
      await import("../src/lib/vault.ts");
    await mkdir(join(workdir, "personas", "kai"), { recursive: true });
    await writeFile(join(workdir, "personas", "kai", "BOOT.md"), "# Kai\n", "utf8");
    const v = await openPersonaVault(join(workdir, "personas", "kai"));
    try {
      v.set("OWN_SECRET", "kais-own");
    } finally {
      v.close();
    }
    _resetVaultTrackingForTesting();
    await loadVaultIntoEnv(join(workdir, "personas", "kai"));
    expect(process.env.OWN_SECRET).toBe("kais-own");
    await rm(vaultPath(join(workdir, "personas", "kai")), { force: true });

    const markerPath = join(workdir, "kai-own.txt");
    const created = store.add({
      persona: "kai",
      description: "kai poll",
      schedule: "0 * * * *",
      prompt: "audit context only",
      command: `printf "[%s]" "$OWN_SECRET" > ${markerPath}`,
      commandSecrets: ["OWN_SECRET"],
      reviewIntervalMs: 1,
      now: new Date("2026-05-02T09:30:00Z"),
    });
    if (!created.ok) throw new Error("setup");

    try {
      const code = await runTick({
        config,
        taskStore: store,
        memory,
        loadPersonaConfig: async (persona) => ({ ...config, personaLayer: persona }),
        harnesses: [
          new ScriptedHarness("h", [{ type: "done", finalText: "should not run" }]),
        ],
        lockPath,
        now: new Date("2026-05-02T10:00:00Z"),
      });
      expect(code).toBe(0);
      expect(await readFile(markerPath, "utf8")).toBe("[kais-own]");
    } finally {
      delete process.env.OWN_SECRET;
      _resetVaultTrackingForTesting();
    }
  });

  test("another persona's vault value in process.env never stands in for a missing secret", async () => {
    // The leak direction: kai has no row of his own. An ambient value that we
    // injected from ANOTHER persona's vault must not be handed to his task —
    // a genuinely host-wide export still may be (covered above).
    const { openPersonaVault, loadVaultIntoEnv } = await import(
      "../src/lib/vault.ts"
    );
    await mkdir(join(workdir, "personas", "kai"), { recursive: true });
    await writeFile(join(workdir, "personas", "kai", "BOOT.md"), "# Kai\n", "utf8");
    const v = await openPersonaVault(join(workdir, "personas", "phantom"));
    try {
      v.set("LEAKY_SECRET", "phantoms-own");
    } finally {
      v.close();
    }
    // Startup: the default persona's vault lands in the ambient environment.
    await loadVaultIntoEnv(join(workdir, "personas", "phantom"));
    expect(process.env.LEAKY_SECRET).toBe("phantoms-own");

    const markerPath = join(workdir, "kai-leak.txt");
    const created = store.add({
      persona: "kai",
      description: "kai poll",
      schedule: "0 * * * *",
      prompt: "audit context only",
      command: `printf "[%s]" "$LEAKY_SECRET" > ${markerPath}`,
      commandSecrets: ["LEAKY_SECRET"],
      reviewIntervalMs: 1,
      now: new Date("2026-05-02T09:30:00Z"),
    });
    if (!created.ok) throw new Error("setup");

    try {
      const code = await runTick({
        config,
        taskStore: store,
        memory,
        loadPersonaConfig: async (persona) => ({ ...config, personaLayer: persona }),
        harnesses: [
          new ScriptedHarness("h", [{ type: "done", finalText: "should not run" }]),
        ],
        lockPath,
        now: new Date("2026-05-02T10:00:00Z"),
      });
      expect(code).toBe(0);
      expect(await readFile(markerPath, "utf8")).toBe("[]");
    } finally {
      delete process.env.LEAKY_SECRET;
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
    expect(harness.lastRequest?.idleTimeoutMs).toBe(config.harnessIdleTimeoutMs);
    expect(harness.lastRequest?.hardTimeoutMs).toBe(30 * 60 * 1000);
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
    // Hold a REAL OS advisory lock on the tick lock path. runTick's own
    // acquireRunLock opens an independent fd/handle, which the kernel treats as
    // a distinct owner, so it must see the conflict and bail — even though the
    // holder is this same process.
    const held = acquireRunLock(lockPath);
    if (!isLockHandle(held)) throw new Error("setup: expected to hold the lock");
    try {
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
    } finally {
      held.release();
    }
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

describe("runTick — wake deferral while the principal is talking (issue #391)", () => {
  // The registry is inert under NODE_ENV=test by default (so unrelated suites
  // can't write live-looking entries into the real state dir); these tests opt
  // in explicitly and point it at the per-test workdir.
  let prevEnabled: string | undefined;
  let turnsDir: string;

  beforeEach(async () => {
    prevEnabled = process.env.PHANTOMBOT_TURN_REGISTRY;
    process.env.PHANTOMBOT_TURN_REGISTRY = "1";
    turnsDir = join(workdir, "turns");
    process.env.PHANTOMBOT_TURN_REGISTRY_DIR = turnsDir;
    await mkdir(turnsDir, { recursive: true });
  });

  afterEach(() => {
    if (prevEnabled === undefined) delete process.env.PHANTOMBOT_TURN_REGISTRY;
    else process.env.PHANTOMBOT_TURN_REGISTRY = prevEnabled;
    delete process.env.PHANTOMBOT_TURN_REGISTRY_DIR;
  });

  /**
   * Seed an in-flight interactive turn owned by THIS process, so the pid probe
   * genuinely reports it alive rather than being stubbed.
   */
  async function seedLiveConversation(startedAt: Date): Promise<void> {
    await writeFile(
      join(turnsDir, "live.json"),
      JSON.stringify({
        id: "live",
        persona: "phantom",
        conversation: "telegram:7995070089",
        origin: "channel",
        pid: process.pid,
        started_at: startedAt.toISOString(),
      }),
      "utf8",
    );
  }

  test("a due task does NOT wake a harness while an interactive turn is live", async () => {
    const now = new Date("2026-05-02T10:00:30Z");
    const created = store.add({
      persona: "phantom",
      description: "hourly check",
      schedule: "0 * * * *",
      prompt: "do the thing",
      now: new Date("2026-05-02T09:30:00Z"),
    });
    if (!created.ok) throw new Error("setup");
    await seedLiveConversation(new Date("2026-05-02T10:00:00Z"));

    const harness = new ScriptedHarness("h", [
      { type: "done", finalText: "should not run" },
    ]);
    const code = await runTick({
      config,
      taskStore: store,
      memory,
      harnesses: [harness],
      lockPath,
      now,
    });

    expect(code).toBe(0);
    expect(harness.invocations).toBe(0);

    // Crucially the row is UNTOUCHED: not counted as a run, and still due, so
    // the next tick re-evaluates and the overdue-by clock keeps running.
    const after = store.get(created.id)!;
    expect(after.runCount).toBe(0);
    expect(after.lastRunAt).toBeUndefined();
    expect(after.nextRunAt.getTime()).toBe(created.task.nextRunAt.getTime());
    expect(after.active).toBe(true);
  });

  test("the same task fires once the conversation has gone quiet", async () => {
    const created = store.add({
      persona: "phantom",
      description: "hourly check",
      schedule: "0 * * * *",
      prompt: "do the thing",
      now: new Date("2026-05-02T09:30:00Z"),
    });
    if (!created.ok) throw new Error("setup");
    // No registry entries at all — nobody is talking.
    const harness = new ScriptedHarness("h", [
      { type: "done", finalText: "ran" },
    ]);
    await runTick({
      config,
      taskStore: store,
      memory,
      harnesses: [harness],
      lockPath,
      now: new Date("2026-05-02T10:00:30Z"),
    });
    expect(harness.invocations).toBe(1);
    expect(store.get(created.id)!.runCount).toBe(1);
  });

  test("deferral is bounded — a task overdue past the ceiling fires anyway", async () => {
    const created = store.add({
      persona: "phantom",
      description: "hourly check",
      schedule: "0 * * * *",
      prompt: "do the thing",
      now: new Date("2026-05-02T09:30:00Z"),
    });
    if (!created.ok) throw new Error("setup");
    await seedLiveConversation(new Date("2026-05-02T10:20:00Z"));

    const harness = new ScriptedHarness("h", [
      { type: "done", finalText: "ran late" },
    ]);
    // 20 minutes past due, well beyond MAX_DEFERRAL_MS. Starving a scheduled
    // task indefinitely is a worse failure than the collision — it is silent.
    await runTick({
      config,
      taskStore: store,
      memory,
      harnesses: [harness],
      lockPath,
      now: new Date("2026-05-02T10:20:30Z"),
    });
    expect(harness.invocations).toBe(1);
  });

  // A command-backed poller runs no harness ITSELF, which makes it look exempt
  // — but the shipped contract (`persona/builder.ts`, and the Jira example in
  // the README) tells it to call `phantombot ask` when it finds work, and that
  // starts a full turn in a third process. So the poller is deferred too;
  // otherwise the documented wake path is an unguarded back door into the very
  // collision this feature exists to prevent.
  //
  // `askMarker` stands in for that documented wake: the command only touches it
  // when it actually got to run, so its absence is proof no agent was woken.
  function addPoller(askMarker: string) {
    const created = store.add({
      persona: "phantom",
      description: "poller",
      schedule: "0 * * * *",
      prompt: "audit context",
      // Exactly the shape the docs prescribe: detect work, then wake an agent.
      command: `printf woke > ${askMarker}`,
      now: new Date("2026-05-02T09:30:00Z"),
    });
    if (!created.ok) throw new Error("setup");
    return created;
  }

  test("a command poller is deferred too — its documented `ask` wake never launches", async () => {
    const askMarker = join(workdir, "poller-ask-live.txt");
    const created = addPoller(askMarker);
    await seedLiveConversation(new Date("2026-05-02T10:00:00Z"));

    await runTick({
      config,
      taskStore: store,
      memory,
      harnesses: [],
      lockPath,
      now: new Date("2026-05-02T10:00:30Z"),
    });

    // The command never ran, so it never reached its `phantombot ask` call.
    expect(existsSync(askMarker)).toBe(false);
    // And the row is untouched, so the next tick re-evaluates for free.
    const after = store.get(created.id)!;
    expect(after.runCount).toBe(0);
    expect(after.lastRunAt).toBeUndefined();
    expect(after.nextRunAt.getTime()).toBe(created.task.nextRunAt.getTime());
    expect(after.active).toBe(true);
  });

  test("the deferred poller — and its wake — go through once the conversation is quiet", async () => {
    const askMarker = join(workdir, "poller-ask-quiet.txt");
    const created = addPoller(askMarker);
    // No registry entries at all — nobody is talking.

    await runTick({
      config,
      taskStore: store,
      memory,
      harnesses: [],
      lockPath,
      now: new Date("2026-05-02T10:00:30Z"),
    });

    expect(existsSync(askMarker)).toBe(true);
    expect(store.get(created.id)!.runCount).toBe(1);
  });

  test("poller deferral is bounded too — an overdue poller fires mid-conversation", async () => {
    const askMarker = join(workdir, "poller-ask-overdue.txt");
    const created = addPoller(askMarker);
    await seedLiveConversation(new Date("2026-05-02T10:20:00Z"));

    // 20 minutes past due, beyond MAX_DEFERRAL_MS: a poller that never polls is
    // a worse failure than the collision, because it is silent.
    await runTick({
      config,
      taskStore: store,
      memory,
      harnesses: [],
      lockPath,
      now: new Date("2026-05-02T10:20:30Z"),
    });

    expect(existsSync(askMarker)).toBe(true);
    expect(store.get(created.id)!.runCount).toBe(1);
  });
});
