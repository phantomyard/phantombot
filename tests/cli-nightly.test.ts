import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { NIGHTLY_TOOLS, runNightly, runNightlyTurn } from "../src/cli/nightly.ts";
import type {
  Harness,
  HarnessChunk,
  HarnessRequest,
} from "../src/harnesses/types.ts";
import { openMemoryStore } from "../src/memory/store.ts";
import {
  loadNightlyState,
  NIGHTLY_STAGES,
  type NightlyStage,
} from "../src/lib/nightly.ts";
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
let personaDir: string;
let config: Config;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-ngcli-"));
  personaDir = join(workdir, "personas", "phantom");
  await mkdir(join(personaDir, "memory"), { recursive: true });
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

async function daily(date: string, body = `notes for ${date}`): Promise<void> {
  await writeFile(join(personaDir, "memory", `${date}.md`), body, "utf8");
}

interface StageCall {
  date: string;
  stage: NightlyStage | "override" | "compact";
  prompt: string;
  startedAt: number;
  endedAt: number;
}

/**
 * Drive runNightly with fake stages. `fail` marks stage/date pairs that should
 * report an error; `delayMs` keeps a stage in flight long enough to observe
 * concurrency.
 */
function harness(opts: { fail?: string[]; delayMs?: number } = {}) {
  const calls: StageCall[] = [];
  const runStage = async (a: {
    date: string;
    stage: NightlyStage | "override" | "compact";
    prompt: string;
  }) => {
    const startedAt = Date.now();
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    calls.push({ ...a, startedAt, endedAt: Date.now() });
    const key = `${a.date}:${a.stage}`;
    return opts.fail?.includes(key)
      ? { finalReply: "", errored: "boom", durationMs: 1 }
      : { finalReply: "done", durationMs: 1 };
  };
  return { calls, runStage };
}

const now = new Date("2026-05-10T02:00:00Z");

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

describe("runNightly — the sweep", () => {
  test("processes every pending date, oldest first, two stages each", async () => {
    await daily("2026-05-01");
    await daily("2026-05-02");
    const h = harness();
    const out = new CaptureStream();
    const code = await runNightly({
      config,
      now,
      out,
      runStage: h.runStage,
      refreshIndex: async () => {},
    });
    expect(code).toBe(0);
    expect(h.calls.length).toBe(4);
    expect(h.calls.map((c) => c.date)).toEqual([
      "2026-05-01",
      "2026-05-01",
      "2026-05-02",
      "2026-05-02",
    ]);
    expect(new Set(h.calls.map((c) => c.stage))).toEqual(
      new Set(NIGHTLY_STAGES),
    );
  });

  // The whole point of the ledger: no flags, no catch-up mode — a second run
  // with nothing new spends zero turns.
  test("a second run with nothing changed does no work", async () => {
    await daily("2026-05-01");
    const first = harness();
    await runNightly({
      config, now, out: new CaptureStream(),
      runStage: first.runStage, refreshIndex: async () => {},
    });
    const second = harness();
    const out = new CaptureStream();
    const code = await runNightly({
      config, now, out,
      runStage: second.runStage, refreshIndex: async () => {},
    });
    expect(code).toBe(0);
    expect(second.calls).toEqual([]);
    expect(out.text).toContain("nothing pending");
  });

  // A day keeps receiving captures after its pass; growth must re-queue it.
  test("a daily file that grew after processing is swept again", async () => {
    await daily("2026-05-01");
    const first = harness();
    await runNightly({
      config, now, out: new CaptureStream(),
      runStage: first.runStage, refreshIndex: async () => {},
    });
    await daily("2026-05-01", "notes for 2026-05-01 plus a late capture");
    const second = harness();
    await runNightly({
      config, now, out: new CaptureStream(),
      runStage: second.runStage, refreshIndex: async () => {},
    });
    expect(second.calls.map((c) => c.date)).toEqual([
      "2026-05-01",
      "2026-05-01",
    ]);
  });

  // Disjoint write targets (drawers+MEMORY.md vs kb/) is what licenses this.
  test("the two stages for a date run concurrently, not in sequence", async () => {
    await daily("2026-05-01");
    const h = harness({ delayMs: 60 });
    await runNightly({
      config, now, out: new CaptureStream(),
      runStage: h.runStage, refreshIndex: async () => {},
    });
    expect(h.calls.length).toBe(2);
    const [a, b] = h.calls;
    // Overlap: the second stage started before the first one finished.
    expect(Math.max(a!.startedAt, b!.startedAt)).toBeLessThan(
      Math.min(a!.endedAt, b!.endedAt),
    );
  });

  test("the index refresh runs in code once per date, after both stages", async () => {
    await daily("2026-05-01");
    const h = harness();
    const refreshes: number[] = [];
    await runNightly({
      config, now, out: new CaptureStream(),
      runStage: h.runStage,
      refreshIndex: async () => {
        refreshes.push(Date.now());
      },
    });
    expect(refreshes.length).toBe(1);
    expect(refreshes[0]!).toBeGreaterThanOrEqual(
      Math.max(...h.calls.map((c) => c.endedAt)),
    );
  });

  test("today is never swept — only days that have closed", async () => {
    await daily("2026-05-09");
    await daily("2026-05-10"); // == `now`
    const h = harness();
    await runNightly({
      config, now, out: new CaptureStream(),
      runStage: h.runStage, refreshIndex: async () => {},
    });
    expect(new Set(h.calls.map((c) => c.date))).toEqual(
      new Set(["2026-05-09"]),
    );
  });
});

describe("runNightly — ledger", () => {
  test("records mtime, size, hash and stages per processed date", async () => {
    await daily("2026-05-01");
    const h = harness();
    await runNightly({
      config, now, out: new CaptureStream(),
      runStage: h.runStage, refreshIndex: async () => {},
    });
    const rec = (await loadNightlyState(personaDir)).processed?.["2026-05-01"];
    expect(rec?.status).toBe("ok");
    expect(rec?.stages_done.sort()).toEqual([...NIGHTLY_STAGES].sort());
    expect(rec?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rec?.size).toBeGreaterThan(0);
  });

  test("clears the in-flight marker when the sweep finishes", async () => {
    await daily("2026-05-01");
    const h = harness();
    await runNightly({
      config, now, out: new CaptureStream(),
      runStage: h.runStage, refreshIndex: async () => {},
    });
    expect((await loadNightlyState(personaDir)).current).toBeUndefined();
  });

  // One stage failing must not throw away the other's work, and must leave the
  // date pending so the next sweep retries it — resume with no resume flag.
  test("a failed stage → partial record, exit 1, and the date stays pending", async () => {
    await daily("2026-05-01");
    const h = harness({ fail: ["2026-05-01:kb"] });
    const out = new CaptureStream();
    const code = await runNightly({
      config, now, out,
      runStage: h.runStage, refreshIndex: async () => {},
    });
    expect(code).toBe(1);
    const rec = (await loadNightlyState(personaDir)).processed?.["2026-05-01"];
    expect(rec?.status).toBe("partial");
    expect(rec?.stages_done).toEqual(["distill"]);
    expect(out.text).toContain("PARTIAL");

    const retry = harness();
    await runNightly({
      config, now, out: new CaptureStream(),
      runStage: retry.runStage, refreshIndex: async () => {},
    });
    expect(retry.calls.length).toBe(2);
  });
});

describe("runNightly — bounds and locking", () => {
  test("--max-dates bounds a manual run and defers the rest", async () => {
    for (let d = 1; d <= 5; d++) {
      await daily(`2026-05-0${d}`);
    }
    const h = harness();
    const out = new CaptureStream();
    await runNightly({
      config, now, out, maxDates: 2,
      runStage: h.runStage, refreshIndex: async () => {},
    });
    expect(new Set(h.calls.map((c) => c.date))).toEqual(
      new Set(["2026-05-01", "2026-05-02"]),
    );
    expect(out.text).toContain("+3 deferred");
  });

  // No default cap: a backlog left half-drained comes back every night and
  // keeps /status yellow, so one pass takes the whole queue.
  test("with no --max-dates the sweep drains the entire backlog", async () => {
    for (let d = 1; d <= 25; d++) {
      await daily(`2026-04-${String(d).padStart(2, "0")}`);
    }
    const h = harness();
    const out = new CaptureStream();
    await runNightly({
      config, now, out,
      runStage: h.runStage, refreshIndex: async () => {},
    });
    expect(new Set(h.calls.map((c) => c.date)).size).toBe(25);
    expect(out.text).not.toContain("deferred");
  });

  // Two overlapping sweeps would double-file the same drawers.
  test("a live in-flight marker makes the run skip", async () => {
    await daily("2026-05-01");
    const { saveNightlyState } = await import("../src/lib/nightly.ts");
    await saveNightlyState(personaDir, {
      current: {
        date: "2026-05-01",
        index: 1,
        total: 1,
        started_at: now.toISOString(),
        updated_at: now.toISOString(),
      },
    });
    const h = harness();
    const out = new CaptureStream();
    const code = await runNightly({
      config, now, out,
      runStage: h.runStage, refreshIndex: async () => {},
    });
    expect(code).toBe(0);
    expect(h.calls).toEqual([]);
    expect(out.text).toContain("already in flight");
  });

  // …but a marker left by a crashed process must not block the sweep forever.
  test("a stale in-flight marker is taken over", async () => {
    await daily("2026-05-01");
    const { saveNightlyState } = await import("../src/lib/nightly.ts");
    await saveNightlyState(personaDir, {
      current: {
        date: "2026-05-01",
        index: 1,
        total: 1,
        started_at: "2026-05-09T02:00:00Z",
        updated_at: "2026-05-09T02:00:00Z",
      },
    });
    const h = harness();
    const out = new CaptureStream();
    await runNightly({
      config, now, out,
      runStage: h.runStage, refreshIndex: async () => {},
    });
    expect(h.calls.length).toBe(2);
    expect(out.text).toContain("stalled sweep");
  });

  // Issue #402. The killer case: the daemon dies mid-sweep, so the marker it
  // leaves behind is SECONDS old — the freshest it will ever be — and the
  // restart that follows is exactly when a new sweep tries to start. Judging
  // that marker by its timestamp makes the new sweep defer to a corpse, and
  // nothing retries until the next UTC day rollover.
  test("a fresh marker whose owner process is gone is taken over", async () => {
    await daily("2026-05-01");
    const { saveNightlyState } = await import("../src/lib/nightly.ts");
    await saveNightlyState(personaDir, {
      current: {
        date: "2026-05-01",
        index: 1,
        total: 1,
        started_at: new Date(now.getTime() - 5_000).toISOString(),
        updated_at: new Date(now.getTime() - 5_000).toISOString(),
        pid: 424242,
      },
    });
    const h = harness();
    const out = new CaptureStream();
    await runNightly({
      config, now, out,
      isProcessAlive: (pid) => pid !== 424242,
      runStage: h.runStage, refreshIndex: async () => {},
    });
    expect(h.calls.length).toBe(2);
    expect(out.text).toContain("dead sweep");
    expect(out.text).toContain("424242");
  });

  // The other half of the same rule: a live owner still holds the lock, so a
  // pid check can never turn into a licence to double-file drawers.
  test("a fresh marker whose owner process is alive still blocks", async () => {
    await daily("2026-05-01");
    const { saveNightlyState } = await import("../src/lib/nightly.ts");
    await saveNightlyState(personaDir, {
      current: {
        date: "2026-05-01",
        index: 1,
        total: 1,
        started_at: now.toISOString(),
        updated_at: now.toISOString(),
        pid: 424242,
      },
    });
    const h = harness();
    const out = new CaptureStream();
    const code = await runNightly({
      config, now, out,
      isProcessAlive: () => true,
      runStage: h.runStage, refreshIndex: async () => {},
    });
    expect(code).toBe(0);
    expect(h.calls).toEqual([]);
    expect(out.text).toContain("already in flight");
  });

  // A live owner that has stopped beating is a wedged turn, not a crash — the
  // 45-minute rule still applies to it.
  test("a live owner that stopped beating is still taken over", async () => {
    await daily("2026-05-01");
    const { saveNightlyState } = await import("../src/lib/nightly.ts");
    await saveNightlyState(personaDir, {
      current: {
        date: "2026-05-01",
        index: 1,
        total: 1,
        started_at: "2026-05-09T02:00:00Z",
        updated_at: "2026-05-09T02:00:00Z",
        pid: 424242,
      },
    });
    const h = harness();
    const out = new CaptureStream();
    await runNightly({
      config, now, out,
      isProcessAlive: () => true,
      runStage: h.runStage, refreshIndex: async () => {},
    });
    expect(h.calls.length).toBe(2);
    expect(out.text).toContain("stalled sweep");
  });
});

describe("runNightly — --date override", () => {
  test("reprocesses one date regardless of the ledger", async () => {
    await daily("2026-05-01");
    const first = harness();
    await runNightly({
      config, now, out: new CaptureStream(),
      runStage: first.runStage, refreshIndex: async () => {},
    });
    const again = harness();
    const code = await runNightly({
      config, now, today: "2026-05-01", out: new CaptureStream(),
      runStage: again.runStage, refreshIndex: async () => {},
    });
    expect(code).toBe(0);
    expect(again.calls.length).toBe(2);
  });

  test("a date with no daily file → exit 2", async () => {
    const err = new CaptureStream();
    const code = await runNightly({
      config, now, today: "2026-05-01", out: new CaptureStream(), err,
      runStage: harness().runStage, refreshIndex: async () => {},
    });
    expect(code).toBe(2);
    expect(err.text).toContain("no daily file");
  });
});

describe("runNightly — persona override prompt", () => {
  test("nightly-prompt.md runs as one monolithic turn per date", async () => {
    await daily("2026-05-01");
    await writeFile(
      join(personaDir, "nightly-prompt.md"),
      "custom {{persona}} {{today}}",
      "utf8",
    );
    const h = harness();
    await runNightly({
      config, now, out: new CaptureStream(),
      runStage: h.runStage, refreshIndex: async () => {},
    });
    expect(h.calls.length).toBe(1);
    expect(h.calls[0]!.stage).toBe("override");
    expect(h.calls[0]!.prompt).toBe("custom phantom 2026-05-01");
  });
});

// #387 — the macOS TCC re-prompt loop.
//
// A nightly stage's whole job lives in the persona dir, but runTurn used to
// default the harness cwd to homedir() and every background caller took the
// default. So stages woke up in $HOME, couldn't see their own memory/ from
// cwd, and went looking: 79 `find` invocations in a single sweep on Matt's
// box, 7 of them rooted at `/`, alongside claude's own parallel Glob walk.
// On macOS those walks cross ~/Library/Containers, which trips the TCC
// kTCCServiceSystemPolicyAppData prompt ("phantombot would like to access
// data from other apps") — once per spawned date, so a 110-date backlog
// became a barrage.
//
// These pin the two halves of the fix at the point they're wired, because
// the runStage seam used by the sweep tests bypasses runTurn entirely and so
// can never observe either.
describe("runNightlyTurn — harness scoping (#387)", () => {
  class CaptureHarness implements Harness {
    readonly id = "capture";
    seen: HarnessRequest | undefined;
    async available(): Promise<boolean> {
      return true;
    }
    async *invoke(req: HarnessRequest): AsyncGenerator<HarnessChunk> {
      this.seen = req;
      yield { type: "done", finalText: "ok" };
    }
  }

  async function runOnce(): Promise<CaptureHarness> {
    await writeFile(join(personaDir, "BOOT.md"), "# persona", "utf8");
    const memory = await openMemoryStore(":memory:");
    const harness = new CaptureHarness();
    try {
      await runNightlyTurn({
        persona: "phantom",
        conversation: "system:nightly:2026-05-10",
        userMessage: "distill",
        agentDir: personaDir,
        harnesses: [harness],
        memory,
      });
    } finally {
      await memory.close();
    }
    return harness;
  }

  test("spawns the stage in the persona dir, never the user's home", async () => {
    const harness = await runOnce();
    expect(harness.seen?.workingDir).toBe(personaDir);
    expect(harness.seen?.workingDir).not.toBe(homedir());
  });

  test("grants only the tools a stage needs — no tree-walking search tools", async () => {
    const harness = await runOnce();
    expect(harness.seen?.toolsMode).toEqual({ allow: NIGHTLY_TOOLS });
    const allowed = NIGHTLY_TOOLS;
    // Bash stays: the stage drives `phantombot memory …` through it.
    expect(allowed).toContain("Bash");
    // Glob/Grep are the walkers that trip TCC. They must not be granted.
    expect(allowed).not.toContain("Glob");
    expect(allowed).not.toContain("Grep");
  });
});

// A stage's whole job is editing its own memory/kb — exactly what the
// UNTRUSTED security-perimeter block tells a turn to escalate instead of
// doing. A harness that reads that block literally refuses its own task
// with no judge involved and nothing recorded — self-censorship off the
// prompt, not a hold. Pins the fix: nightly gets the TRUSTED prompt block
// (command authority over its own persona dir) while its provenance stays
// `other` (it is not the owner speaking, so it must not inflate to
// `principal` tier in the durable-fact pool — same call tick's task wakes
// make, and for the same reason, #327).
describe("runNightlyTurn — trusted prompt, untrusted provenance", () => {
  class CaptureHarness implements Harness {
    readonly id = "capture";
    seen: HarnessRequest | undefined;
    async available(): Promise<boolean> {
      return true;
    }
    async *invoke(req: HarnessRequest): AsyncGenerator<HarnessChunk> {
      this.seen = req;
      yield { type: "done", finalText: "ok" };
    }
  }

  test("selects the TRUSTED security-perimeter block, not the UNTRUSTED one", async () => {
    await writeFile(join(personaDir, "BOOT.md"), "# persona", "utf8");
    const memory = await openMemoryStore(":memory:");
    const harness = new CaptureHarness();
    try {
      await runNightlyTurn({
        persona: "phantom",
        conversation: "system:nightly:2026-05-10",
        userMessage: "distill",
        agentDir: personaDir,
        harnesses: [harness],
        memory,
      });
    } finally {
      await memory.close();
    }
    expect(harness.seen?.systemPrompt).toContain(
      "Security perimeter — TRUSTED turn",
    );
    expect(harness.seen?.systemPrompt).not.toContain(
      "Security perimeter — UNTRUSTED turn",
    );
  });

  test("still stamps both turns `other` — not `principal` — in the fact pool", async () => {
    await writeFile(join(personaDir, "BOOT.md"), "# persona", "utf8");
    const memory = await openMemoryStore(":memory:");
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
    try {
      await runNightlyTurn({
        persona: "phantom",
        conversation: "system:nightly:2026-05-10",
        userMessage: "distill",
        agentDir: personaDir,
        harnesses: [new CaptureHarness()],
        memory: spied,
      });
    } finally {
      await memory.close();
    }
    expect(pairCalls).toHaveLength(1);
    expect(pairCalls[0]!.user.source).toBe("other");
    expect(pairCalls[0]!.assistant.source).toBe("other");
  });
});

describe("runNightly — compaction stage (#410)", () => {
  const over = "x".repeat(20 * 1024);

  /** A stage stub that rewrites MEMORY.md to `after` when compaction runs. */
  function compactHarness(after: string | null) {
    const calls: string[] = [];
    return {
      calls,
      runStage: async (a: { stage: string; prompt: string }) => {
        calls.push(a.stage);
        if (a.stage === "compact") {
          const p = join(personaDir, "MEMORY.md");
          if (after === null) await rm(p);
          else await writeFile(p, after, "utf8");
        }
        return { finalReply: "done", durationMs: 1 };
      },
    };
  }

  test("runs once per sweep, not once per date, and only over budget", async () => {
    await daily("2026-05-01");
    await daily("2026-05-02");
    await writeFile(join(personaDir, "MEMORY.md"), over, "utf8");
    const h = compactHarness("x".repeat(15 * 1024));
    const out = new CaptureStream();
    const code = await runNightly({
      config, now, out,
      runStage: h.runStage as never,
      refreshIndex: async () => {},
    });
    expect(code).toBe(0);
    expect(h.calls.filter((s) => s === "compact")).toHaveLength(1);
    // and it runs after every date's stages
    expect(h.calls[h.calls.length - 1]).toBe("compact");

    const state = await loadNightlyState(personaDir);
    expect(state.compaction?.files).toHaveLength(1);
    expect(state.compaction?.bytes_before).toBe(20 * 1024);
    expect(state.compaction?.bytes_after).toBe(15 * 1024);
    expect(state.compaction?.files[0]!.status).toBe("compacted");
    expect(out.text).toContain("compaction");
  });

  test("STEADY STATE: runs with an empty queue, the night it matters most", async () => {
    // Regression: the sweep used to return as soon as no date was pending, so
    // compaction never reached the one shape that is the norm — a box whose
    // backlog is drained. It was reachable only during a backfill.
    await daily("2026-05-01");
    const first = compactHarness("x".repeat(15 * 1024));
    await runNightly({
      config, now, out: new CaptureStream(),
      runStage: first.runStage as never, refreshIndex: async () => {},
    });

    // Second sweep: the date is in the ledger and unchanged, so nothing pends.
    await writeFile(join(personaDir, "MEMORY.md"), over, "utf8");
    const h = compactHarness("x".repeat(15 * 1024));
    const out = new CaptureStream();
    const code = await runNightly({
      config, now, out,
      runStage: h.runStage as never, refreshIndex: async () => {},
    });
    expect(code).toBe(0);
    expect(out.text).toContain("nothing pending");
    expect(h.calls).toEqual(["compact"]);
    expect((await loadNightlyState(personaDir)).compaction?.files[0]!.status).toBe(
      "compacted",
    );
  });

  test("STEADY STATE: the sweep marker is held across an empty-queue compaction", async () => {
    // Regression: the in-flight marker was written only inside the date loop,
    // so the steady-state path — no date pending, compaction still running —
    // held no lock at all. Two sweeps would both reach `compact`, archive the
    // same pre-image and point concurrent LLM writers at the same files.
    await daily("2026-05-01");
    const drain = compactHarness("x".repeat(15 * 1024));
    await runNightly({
      config, now, out: new CaptureStream(),
      runStage: drain.runStage as never, refreshIndex: async () => {},
    });

    await writeFile(join(personaDir, "MEMORY.md"), over, "utf8");
    let release: () => void = () => {};
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    let compactEntered: () => void = () => {};
    const entered = new Promise<void>((r) => {
      compactEntered = r;
    });
    const first = {
      calls: [] as string[],
      runStage: async (a: { stage: string }) => {
        first.calls.push(a.stage);
        if (a.stage === "compact") {
          compactEntered();
          await blocked;
        }
        return { finalReply: "done", durationMs: 1 };
      },
    };
    const firstRun = runNightly({
      config, now, out: new CaptureStream(),
      runStage: first.runStage as never, refreshIndex: async () => {},
    });

    // With the first sweep parked inside compaction, a second one must see the
    // marker and stand down rather than start its own pass.
    await entered;
    const second = compactHarness("x".repeat(15 * 1024));
    const out = new CaptureStream();
    const code = await runNightly({
      config, now, out,
      runStage: second.runStage as never, refreshIndex: async () => {},
    });
    expect(code).toBe(0);
    expect(out.text).toContain("already in flight");
    expect(second.calls).not.toContain("compact");

    release();
    await firstRun;
    // …and the marker is cleared on the way out, so the next sweep is free.
    expect((await loadNightlyState(personaDir)).current ?? null).toBeNull();
  });

  test("a same-size rewrite still reconciles the index", async () => {
    // `unchanged` is a SIZE verdict. The stage can replace a file with
    // different content of exactly the same byte length; keying the
    // post-compaction index refresh on the byte count left FTS/vector serving
    // the pre-compaction text for a file that had in fact changed.
    await daily("2026-05-01");
    await writeFile(join(personaDir, "MEMORY.md"), over, "utf8");
    const rewrite = "y".repeat(20 * 1024);
    const events: string[] = [];
    const h = {
      runStage: async (a: { stage: string }) => {
        events.push(`stage:${a.stage}`);
        if (a.stage === "compact") {
          await writeFile(join(personaDir, "MEMORY.md"), rewrite, "utf8");
        }
        return { finalReply: "done", durationMs: 1 };
      },
    };
    await runNightly({
      config, now, out: new CaptureStream(),
      runStage: h.runStage as never,
      refreshIndex: async () => {
        events.push("index");
      },
    });
    // Same byte count, different bytes: the verdict says `unchanged`…
    const state = await loadNightlyState(personaDir);
    expect(state.compaction?.files[0]!.status).toBe("unchanged");
    expect(await Bun.file(join(personaDir, "MEMORY.md")).text()).toBe(rewrite);
    // …but the index is still reconciled afterwards.
    expect(events[events.length - 1]).toBe("index");
    expect(events.filter((e) => e === "index")).toHaveLength(2);
  });

  test("a rewritten daily is re-ledgered so the next sweep does not re-bill it", async () => {
    // Compaction rewrites the daily file, which changes the mtime/size/hash the
    // ledger keys on. Without reconciliation the next sweep sees `changed`,
    // re-queues the date and pays for both LLM stages again — every night.
    await daily("2026-05-01", "y".repeat(20 * 1024));
    const first = {
      calls: [] as string[],
      runStage: async (a: { stage: string }) => {
        first.calls.push(a.stage);
        if (a.stage === "compact") {
          await writeFile(
            join(personaDir, "memory", "2026-05-01.md"),
            "y".repeat(4 * 1024),
            "utf8",
          );
        }
        return { finalReply: "done", durationMs: 1 };
      },
    };
    // `now` is well past the daily age gate for 2026-05-01.
    await runNightly({
      config, now, out: new CaptureStream(), compactMinAgeDays: 1,
      runStage: first.runStage as never, refreshIndex: async () => {},
    });
    const state = await loadNightlyState(personaDir);
    expect(state.compaction?.files.some((f) => f.kind === "daily")).toBe(true);
    const rec = state.processed?.["2026-05-01"]!;
    const st = await stat(join(personaDir, "memory", "2026-05-01.md"));
    expect(rec.size).toBe(st.size);
    expect(rec.status).toBe("ok");
    expect(rec.stages_done).toEqual([...NIGHTLY_STAGES]);

    // Next sweep: nothing pending, so no distill/kb turn is spent on it again.
    const second = compactHarness("x");
    const out = new CaptureStream();
    await runNightly({
      config, now, out, compactMinAgeDays: 1,
      runStage: second.runStage as never, refreshIndex: async () => {},
    });
    expect(out.text).toContain("nothing pending");
    expect(second.calls).not.toContain("distill");
  });

  test("index is refreshed again after a rewrite, never before it", async () => {
    await daily("2026-05-01");
    await writeFile(join(personaDir, "MEMORY.md"), over, "utf8");
    const events: string[] = [];
    const h = {
      runStage: async (a: { stage: string }) => {
        events.push(`stage:${a.stage}`);
        if (a.stage === "compact") {
          await writeFile(join(personaDir, "MEMORY.md"), "x".repeat(15 * 1024), "utf8");
        }
        return { finalReply: "done", durationMs: 1 };
      },
    };
    await runNightly({
      config, now, out: new CaptureStream(),
      runStage: h.runStage as never,
      refreshIndex: async () => {
        events.push("index");
      },
    });
    expect(events[events.length - 1]).toBe("index");
    expect(events.filter((e) => e === "index")).toHaveLength(2);
  });

  test("nothing over budget → no compact turn at all", async () => {
    await daily("2026-05-01");
    await writeFile(join(personaDir, "MEMORY.md"), "small", "utf8");
    const h = compactHarness("x");
    await runNightly({
      config, now, out: new CaptureStream(),
      runStage: h.runStage as never,
      refreshIndex: async () => {},
    });
    expect(h.calls).not.toContain("compact");
    expect((await loadNightlyState(personaDir)).compaction).toBeUndefined();
  });

  test("an over-eager pass is reverted and recorded", async () => {
    await daily("2026-05-01");
    await writeFile(join(personaDir, "MEMORY.md"), over, "utf8");
    const h = compactHarness("gone");
    await runNightly({
      config, now, out: new CaptureStream(),
      runStage: h.runStage as never,
      refreshIndex: async () => {},
    });
    const state = await loadNightlyState(personaDir);
    expect(state.compaction?.files[0]!.status).toBe("reverted");
    expect(state.compaction?.bytes_after).toBe(20 * 1024);
    const live = await Bun.file(join(personaDir, "MEMORY.md")).text();
    expect(live).toBe(over);
  });

  test("a file deleted by the pass comes back from the archive", async () => {
    await daily("2026-05-01");
    await writeFile(join(personaDir, "MEMORY.md"), over, "utf8");
    const h = compactHarness(null);
    await runNightly({
      config, now, out: new CaptureStream(),
      runStage: h.runStage as never,
      refreshIndex: async () => {},
    });
    expect(await Bun.file(join(personaDir, "MEMORY.md")).text()).toBe(over);
  });

  test("--no-compact and --date backfills skip it", async () => {
    await daily("2026-05-01");
    await writeFile(join(personaDir, "MEMORY.md"), over, "utf8");

    const a = compactHarness("x");
    await runNightly({
      config, now, out: new CaptureStream(), skipCompaction: true,
      runStage: a.runStage as never, refreshIndex: async () => {},
    });
    expect(a.calls).not.toContain("compact");

    const b = compactHarness("x");
    await runNightly({
      config, now, out: new CaptureStream(), today: "2026-05-01",
      runStage: b.runStage as never, refreshIndex: async () => {},
    });
    expect(b.calls).not.toContain("compact");
  });

  test("a failed date stage stops compaction from touching the file", async () => {
    // Regression: compaction ran even when distill had errored. A distill turn
    // can partially rewrite MEMORY.md before failing, so the archive would have
    // captured the damaged state, and a second model rewrite would sit on top
    // of it. No compact turn, and no compaction ledger.
    await daily("2026-05-01");
    await writeFile(join(personaDir, "MEMORY.md"), over, "utf8");
    const calls: string[] = [];
    const out = new CaptureStream();
    const code = await runNightly({
      config, now, out,
      runStage: (async (a: { stage: string }) => {
        calls.push(a.stage);
        if (a.stage === "distill") {
          // partial rewrite, then failure
          await writeFile(join(personaDir, "MEMORY.md"), "half-written", "utf8");
          return { finalReply: "", errored: "timeout", durationMs: 1 };
        }
        if (a.stage === "compact") {
          await writeFile(join(personaDir, "MEMORY.md"), "x", "utf8");
        }
        return { finalReply: "done", durationMs: 1 };
      }) as never,
      refreshIndex: async () => {},
    });
    expect(code).toBe(1);
    expect(calls).not.toContain("compact");
    expect((await loadNightlyState(personaDir)).compaction).toBeUndefined();
    expect(await Bun.file(join(personaDir, "MEMORY.md")).text()).toBe(
      "half-written",
    );
    expect(out.text).toContain("compaction skipped");
  });

  test("a failed compact turn still settles the file and is reported", async () => {
    await daily("2026-05-01");
    await writeFile(join(personaDir, "MEMORY.md"), over, "utf8");
    const code = await runNightly({
      config, now, out: new CaptureStream(),
      runStage: (async (a: { stage: string }) => {
        if (a.stage === "compact") {
          await writeFile(join(personaDir, "MEMORY.md"), "wrecked", "utf8");
          return { finalReply: "", errored: "timeout", durationMs: 1 };
        }
        return { finalReply: "done", durationMs: 1 };
      }) as never,
      refreshIndex: async () => {},
    });
    expect(code).toBe(1);
    expect(await Bun.file(join(personaDir, "MEMORY.md")).text()).toBe(over);
    const state = await loadNightlyState(personaDir);
    expect(state.errors?.some((e) => e.startsWith("compaction:"))).toBe(true);
  });
});
