/**
 * 2026-09-16 failover incident regressions.
 *
 *  1. A harness that emits a recoverable, NON-terminal error mid-stream
 *     (claude's `server_error`) was failed over by the orchestrator, but the
 *     subprocess was never killed: it kept running tools for 78s in parallel
 *     with the fallback answering the same prompt. The kill must ride the
 *     orchestrator's own `break` — so these tests drive a REAL subprocess
 *     through runHarnessProcess via runWithFallback, the actual call site.
 *
 *  2. A harness streaming only model heartbeats kept re-arming the idle timer
 *     forever; "Thinking..." sat for 40 minutes. Model activity may now defer
 *     the idle kill only within the thinking budget.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createKillCoordinator,
  runHarnessProcess,
} from "../src/lib/harnessRunner.ts";
import { spawnInNewSession } from "../src/lib/processGroup.ts";
import { runWithFallback } from "../src/orchestrator/fallback.ts";
import { CooldownStore } from "../src/lib/cooldown.ts";
import { HarnessAlerter } from "../src/lib/harnessAlert.ts";
import type {
  Harness,
  HarnessChunk,
  HarnessRequest,
} from "../src/harnesses/types.ts";

const trackedPids: number[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const pid of trackedPids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  trackedPids.length = 0;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function baseReq(extra: Partial<HarnessRequest> = {}): HarnessRequest {
  return {
    idleTimeoutMs: 10_000,
    workingDir: process.cwd(),
    persona: "test",
    conversation: "test",
    userMessage: "test",
    systemPrompt: "",
    history: [],
    ...extra,
  } as HarnessRequest;
}

type Parsed = { kind?: string; v?: string };
const parseEvent = (parsed: unknown) => {
  const p = parsed as Parsed;
  if (p.kind === "err") {
    return { type: "error", error: "server_error", recoverable: true } as const;
  }
  if (p.kind === "text") return { type: "text", text: p.v ?? "" } as const;
  if (p.kind === "hb") return { type: "heartbeat" } as const;
  return undefined;
};

/** A harness that runs a real shell script through the shared engine. */
class ScriptHarness implements Harness {
  proc: ReturnType<typeof spawnInNewSession> | undefined;
  constructor(
    public readonly id: string,
    private readonly script: string,
  ) {}
  async available(): Promise<boolean> {
    return true;
  }
  async *invoke(req: HarnessRequest): AsyncGenerator<HarnessChunk> {
    const proc = spawnInNewSession(["sh", "-c", this.script], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    this.proc = proc;
    trackedPids.push(proc.pid!);
    yield* runHarnessProcess({
      proc,
      req,
      harnessId: this.id,
      parseEvent,
      activity: (_p, c) => (c.type === "heartbeat" ? "model" : "productive"),
      buildDoneMeta: () => ({}),
    });
  }
}

class ReplyHarness implements Harness {
  constructor(public readonly id: string) {}
  async available(): Promise<boolean> {
    return true;
  }
  async *invoke(): AsyncGenerator<HarnessChunk> {
    yield { type: "text", text: "fallback reply" };
    yield { type: "done", finalText: "fallback reply", meta: {} };
  }
}

describe("failover kills the abandoned primary (2026-09-16)", () => {
  test("recoverable mid-stream error → child is killed before its side effect runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pb-failover-"));
    dirs.push(dir);
    const sideEffect = join(dir, "applied");
    // Emit server_error, then keep working like claude did: after a pause,
    // perform a side effect (the HA change that ran twice).
    const primary = new ScriptHarness(
      "primary",
      `echo '{"kind":"err"}'; sleep 1; touch '${sideEffect}'; sleep 30`,
    );
    const chunks: HarnessChunk[] = [];
    for await (const c of runWithFallback(
      [primary, new ReplyHarness("fallback")],
      baseReq(),
      { cooldown: new CooldownStore(), alerter: new HarnessAlerter() },
    )) {
      chunks.push(c);
    }
    expect(chunks.at(-1)).toMatchObject({ type: "done", finalText: "fallback reply" });

    // The abandoned primary must be dead within the SIGTERM path, well before
    // its 1s side effect or 30s sleep.
    const exited = await Promise.race([
      primary.proc!.exited.then(() => "exited"),
      sleep(3_000).then(() => "still running"),
    ]);
    expect(exited).toBe("exited");
    await sleep(1_500);
    expect(existsSync(sideEffect)).toBe(false);
  });

  test("a stream that runs to EOF is not abandoned (no spurious kill)", async () => {
    const primary = new ScriptHarness(
      "primary",
      `echo '{"kind":"text","v":"hi"}'`,
    );
    const chunks: HarnessChunk[] = [];
    for await (const c of runWithFallback(
      [primary, new ReplyHarness("fallback")],
      baseReq(),
      { cooldown: new CooldownStore(), alerter: new HarnessAlerter() },
    )) {
      chunks.push(c);
    }
    expect(chunks.at(-1)).toMatchObject({ type: "done", finalText: "hi" });
    expect(await primary.proc!.exited).toBe(0);
  });
});

describe("thinking budget: heartbeats cannot defer the idle kill forever", () => {
  test("model-only activity is killed at the thinking budget", async () => {
    const proc = spawnInNewSession(["sh", "-c", "sleep 30"], {
      stdin: "ignore", stdout: "pipe", stderr: "ignore",
    });
    trackedPids.push(proc.pid!);
    const killer = createKillCoordinator({
      proc,
      idleTimeoutMs: 200,
      thinkingTimeoutMs: 600,
      hardTimeoutMs: 10_000,
      harnessId: "test",
      graceMs: 100,
    });
    const start = Date.now();
    const pinger = setInterval(() => killer.touch("model"), 50);
    await proc.exited;
    clearInterval(pinger);
    await killer.dispose();
    expect(killer.killCause()).toBe("idle");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(550);
    expect(elapsed).toBeLessThan(2_000);
  });

  test("legacy (no thinking budget): heartbeats keep the process alive", async () => {
    const proc = spawnInNewSession(["sh", "-c", "sleep 30"], {
      stdin: "ignore", stdout: "pipe", stderr: "ignore",
    });
    trackedPids.push(proc.pid!);
    const killer = createKillCoordinator({
      proc, idleTimeoutMs: 200, hardTimeoutMs: 10_000, harnessId: "test",
    });
    const pinger = setInterval(() => killer.touch("model"), 50);
    await sleep(1_000);
    clearInterval(pinger);
    expect(killer.killCause()).toBeUndefined();
    await killer.dispose();
  });

  test("model activity never SHORTENS an armed idle deadline", async () => {
    const proc = spawnInNewSession(["sh", "-c", "sleep 30"], {
      stdin: "ignore", stdout: "pipe", stderr: "ignore",
    });
    trackedPids.push(proc.pid!);
    // thinking budget (100ms) < idle (500ms): a heartbeat must not pull the
    // idle deadline in to the thinking budget.
    const killer = createKillCoordinator({
      proc, idleTimeoutMs: 500, thinkingTimeoutMs: 100, hardTimeoutMs: 10_000,
      harnessId: "test",
    });
    await sleep(50);
    killer.touch("model");
    await sleep(250);
    expect(killer.killCause()).toBeUndefined();
    await sleep(400);
    expect(killer.killCause()).toBe("idle");
    await killer.dispose();
  });

  test("productive output restarts the thinking budget", async () => {
    const proc = spawnInNewSession(["sh", "-c", "sleep 30"], {
      stdin: "ignore", stdout: "pipe", stderr: "ignore",
    });
    trackedPids.push(proc.pid!);
    const killer = createKillCoordinator({
      proc, idleTimeoutMs: 200, thinkingTimeoutMs: 500, hardTimeoutMs: 10_000,
      harnessId: "test",
    });
    const pinger = setInterval(() => killer.touch("model"), 50);
    await sleep(400);
    killer.touch("productive");
    await sleep(400); // 800ms total: past the budget from spawn, not from the reset
    expect(killer.killCause()).toBeUndefined();
    await sleep(500);
    clearInterval(pinger);
    expect(killer.killCause()).toBe("idle");
    await killer.dispose();
  });

  test("engine: a heartbeat-only stream yields a recoverable idle error at the budget", async () => {
    const proc = spawnInNewSession(
      ["sh", "-c", `echo '{"kind":"text","v":"working"}'; while true; do echo '{"kind":"hb"}'; sleep 0.05; done`],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    trackedPids.push(proc.pid!);
    const start = Date.now();
    const chunks: HarnessChunk[] = [];
    for await (const c of runHarnessProcess({
      proc,
      req: baseReq({ idleTimeoutMs: 200, thinkingTimeoutMs: 700, hardTimeoutMs: 20_000 }),
      harnessId: "hb",
      parseEvent,
      activity: (_p, c) => (c.type === "heartbeat" ? "model" : "productive"),
      buildDoneMeta: () => ({}),
    })) {
      chunks.push(c);
    }
    const last = chunks.at(-1);
    expect(last).toMatchObject({ type: "error", killCause: "idle", recoverable: true });
    expect(Date.now() - start).toBeLessThan(8_000);
  });
});
