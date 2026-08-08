/**
 * Tests for the kill coordinator: idle timer reset, hard timer, and
 * abort-signal hookup. The coordinator is what every harness leans on
 * to translate "subprocess wedged for 120s" into a recoverable error.
 *
 * Real subprocess + real timers — the kill semantics are precisely the
 * thing we want to verify against the kernel, not against a stub.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  createKillCoordinator,
  killCauseToErrorChunk,
  runHarnessProcess,
} from "../src/lib/harnessRunner.ts";
import { spawnInNewSession } from "../src/lib/processGroup.ts";

const trackedPids: number[] = [];
afterEach(() => {
  for (const pid of trackedPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  trackedPids.length = 0;
});

describe("createKillCoordinator — idle timer", () => {
  test("touch() prevents idle kill while the process is producing output", async () => {
    // Process emits a line every 50ms for ~500ms total. Idle window is
    // 200ms, so without touch() it would fire mid-stream. With touch()
    // it never fires.
    const proc = spawnInNewSession(
      [
        "sh",
        "-c",
        "for i in 1 2 3 4 5 6 7 8; do echo $i; sleep 0.05; done",
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    trackedPids.push(proc.pid!);

    const killer = createKillCoordinator({
      proc,
      idleTimeoutMs: 200,
      hardTimeoutMs: 5000,
      harnessId: "test",
    });

    const decoder = new TextDecoder();
    let bytes = 0;
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      killer.touch();
      bytes += decoder.decode(chunk, { stream: true }).length;
    }
    await killer.dispose();

    expect(killer.killCause()).toBeUndefined();
    expect(bytes).toBeGreaterThan(8); // 8 lines of "n\n"
    expect(await proc.exited).toBe(0);
  });

  test("idle timer fires when stdout goes silent past idleTimeoutMs", async () => {
    // Process emits one line then sleeps. We touch() once after the
    // first line, then stop reading. Idle timer should fire and kill
    // the process group.
    const proc = spawnInNewSession(
      ["sh", "-c", "echo first; sleep 30"],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    trackedPids.push(proc.pid!);

    const killer = createKillCoordinator({
      proc,
      idleTimeoutMs: 150,
      hardTimeoutMs: 10_000,
      harnessId: "test",
    });

    const decoder = new TextDecoder();
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const { value } = await reader.read();
    if (value) killer.touch();
    expect(decoder.decode(value)).toContain("first");
    // Don't read again. Don't touch again. Idle timer fires after 150ms.

    await proc.exited;
    await killer.dispose();
    reader.releaseLock();

    expect(killer.killCause()).toBe("idle");
  });
});

describe("createKillCoordinator — tool cap (issue #351)", () => {
  test("sustained 'tool' activity past toolTimeoutMs lets the idle kill fire", async () => {
    // A wedged-but-chattery tool: we drive touch("tool") forever. Without a
    // cap that would reset the idle timer indefinitely and defeat the watchdog
    // up to the hard cap. With toolTimeoutMs the tool-run's idle-reset budget
    // runs out and the idle timer finally fires — even though tool activity
    // never stops. That's the fix: the kill is caused by the cap, not silence.
    const proc = spawnInNewSession(["sleep", "30"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    trackedPids.push(proc.pid!);

    const killer = createKillCoordinator({
      proc,
      idleTimeoutMs: 150,
      toolTimeoutMs: 300,
      hardTimeoutMs: 10_000,
      harnessId: "test",
    });

    // Hammer tool activity the whole time — proving it's the cap, not a lull.
    const interval = setInterval(() => killer.touch("tool"), 30);
    try {
      await proc.exited; // killed once the cap + idle window elapse (~450ms)
    } finally {
      clearInterval(interval);
      await killer.dispose();
    }
    expect(killer.killCause()).toBe("idle");
  });

  test("without a tool cap, sustained 'tool' activity keeps the process alive", async () => {
    // Legacy behaviour (toolTimeoutMs omitted): a long-but-working tool that
    // keeps emitting activity must never be killed. Held well past what the
    // capped test kills at.
    const proc = spawnInNewSession(["sleep", "30"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    trackedPids.push(proc.pid!);

    const killer = createKillCoordinator({
      proc,
      idleTimeoutMs: 150,
      hardTimeoutMs: 10_000,
      harnessId: "test",
    });

    const interval = setInterval(() => killer.touch("tool"), 30);
    await Bun.sleep(700);
    clearInterval(interval);
    await killer.dispose();
    expect(killer.killCause()).toBeUndefined();
  });

  test("productive output resets the tool-run budget", async () => {
    // Two tool-runs, each under the cap, separated by productive output. Total
    // tool time exceeds toolTimeoutMs, but no SINGLE contiguous run does — so a
    // healthy turn interleaving tools with text is never killed.
    const proc = spawnInNewSession(["sleep", "30"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    trackedPids.push(proc.pid!);

    const killer = createKillCoordinator({
      proc,
      idleTimeoutMs: 200,
      toolTimeoutMs: 300,
      hardTimeoutMs: 10_000,
      harnessId: "test",
    });

    const interval = setInterval(() => killer.touch("tool"), 30);
    await Bun.sleep(250); // first tool-run, under the 300ms cap
    killer.touch("productive"); // resets the budget (toolRunStart cleared)
    await Bun.sleep(250); // second tool-run, again under the cap
    clearInterval(interval);
    await killer.dispose();
    expect(killer.killCause()).toBeUndefined();
  });
});

describe("createKillCoordinator — hard timer", () => {
  test("hard timer fires regardless of touch() activity", async () => {
    // Process keeps emitting (so idle never fires) but hard cap is short.
    const proc = spawnInNewSession(
      [
        "sh",
        "-c",
        "while true; do echo tick; sleep 0.05; done",
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    trackedPids.push(proc.pid!);

    const killer = createKillCoordinator({
      proc,
      idleTimeoutMs: 5_000,
      hardTimeoutMs: 250,
      harnessId: "test",
    });

    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      killer.touch(); // keep idle timer happy
      void chunk;
    }
    await killer.dispose();

    expect(killer.killCause()).toBe("timeout");
  });
});

describe("createKillCoordinator — abort signal", () => {
  test("AbortSignal triggers the same kill path with cause='aborted'", async () => {
    const proc = spawnInNewSession(["sleep", "30"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    trackedPids.push(proc.pid!);

    const ac = new AbortController();
    const killer = createKillCoordinator({
      proc,
      idleTimeoutMs: 30_000,
      hardTimeoutMs: 30_000,
      signal: ac.signal,
      harnessId: "test",
    });

    setTimeout(() => ac.abort(), 50);
    await proc.exited;
    await killer.dispose();

    expect(killer.killCause()).toBe("aborted");
  });

  test("pre-aborted signal kills immediately on coordinator creation", async () => {
    const proc = spawnInNewSession(["sleep", "30"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    trackedPids.push(proc.pid!);

    const ac = new AbortController();
    ac.abort();
    const killer = createKillCoordinator({
      proc,
      idleTimeoutMs: 30_000,
      hardTimeoutMs: 30_000,
      signal: ac.signal,
      harnessId: "test",
    });

    await proc.exited;
    await killer.dispose();
    expect(killer.killCause()).toBe("aborted");
  });
});

describe("killCauseToErrorChunk", () => {
  test("undefined cause → undefined chunk (process exited normally)", () => {
    expect(killCauseToErrorChunk(undefined, "claude", 1000, 100)).toBeUndefined();
  });

  test("timeout cause → recoverable error mentioning the hard cap", () => {
    const c = killCauseToErrorChunk("timeout", "claude", 60_000, 1000);
    expect(c).toMatchObject({
      type: "error",
      recoverable: true,
    });
    expect(c?.error).toContain("60000ms");
    expect(c?.error).toContain("hard wall-clock");
  });

  test("idle cause → recoverable error mentioning 'no output'", () => {
    const c = killCauseToErrorChunk("idle", "gemini", 60_000, 200);
    expect(c).toMatchObject({
      type: "error",
      recoverable: true,
    });
    expect(c?.error).toContain("200ms");
    expect(c?.error).toContain("no output");
  });

  test("aborted cause → non-recoverable 'stopped'", () => {
    const c = killCauseToErrorChunk("aborted", "pi", 1000, 100);
    expect(c).toMatchObject({
      type: "error",
      error: "stopped",
      recoverable: false,
    });
  });
});

describe("runHarnessProcess — regression: stdin blocking hang", () => {
  test("hard timeout fires even when stdin.write blocks on pipe backpressure", async () => {
    // We spawn a child that never reads stdin (sleep).
    // We send a large payload (multi-MB) to fill the OS pipe buffer.
    // hardTimeoutMs is very short.
    // If the killer arms AFTER stdin.write, we'll hang here forever.
    // If the killer arms BEFORE, the hard timeout will kill the process,
    // causing the blocked write to fail with EPIPE, and the turn recovers.
    const proc = spawnInNewSession(["sleep", "30"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    trackedPids.push(proc.pid!);

    // 5 MB of junk to ensure we hit backpressure
    const largePayload = Buffer.alloc(5 * 1024 * 1024, "x").toString();

    const startTime = Date.now();
    const chunks: any[] = [];
    
    // We run the generator. 
    // hardTimeoutMs = 200ms. 
    // We expect it to return within a small window (< 2s) with a timeout error.
    const generator = runHarnessProcess({
      proc,
      harnessId: "test-harness",
      req: {
        idleTimeoutMs: 10_000,
        hardTimeoutMs: 200,
        workingDir: process.cwd(),
        persona: "test",
        trusted: true,
        conversation: "test",
        userMessage: "test",
      } as any,
      stdinPayload: largePayload,
      parseEvent: () => undefined,
      activity: () => "productive",
      buildDoneMeta: () => ({}),
    });

    for await (const chunk of generator) {
      chunks.push(chunk);
    }

    const duration = Date.now() - startTime;
    
    // If it took > 5s, something is wrong (the hard timeout is 200ms).
    expect(duration).toBeLessThan(5000);
    
    // Verify we got the timeout error
    const errorChunk = chunks.find(c => c.type === "error");
    expect(errorChunk).toBeDefined();
    expect(errorChunk.error).toContain("hard wall-clock");
    expect(errorChunk.recoverable).toBe(true);
  });
});

describe("runHarnessProcess — terminal policy tripwire", () => {
  test("kills the child and suppresses ALL post-tripwire output", async () => {
    // Regression for the PR #321 review: pre-fix, a parser's recoverable
    // tripwire error was yielded but the runner kept consuming stdout, so a
    // CLI emitting [text, tripwire, more text] would stream "more text" to
    // the user before fallback. Now the terminal error must end the stream:
    // the child is killed and no chunk after the error is yielded — not even
    // lines that arrived in the SAME stdout batch.
    const proc = spawnInNewSession(
      [
        "sh",
        "-c",
        'echo \'{"kind":"text","v":"before "}\'; ' +
          'echo \'{"kind":"tripwire"}\'; ' +
          'echo \'{"kind":"text","v":"after"}\'; ' +
          "sleep 30",
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    trackedPids.push(proc.pid!);

    const start = Date.now();
    const chunks: unknown[] = [];
    for await (const chunk of runHarnessProcess({
      proc,
      harnessId: "test-harness",
      req: {
        idleTimeoutMs: 10_000,
        hardTimeoutMs: 20_000,
        workingDir: process.cwd(),
        persona: "test",
        conversation: "test",
        userMessage: "test",
      } as never,
      parseEvent: (parsed: unknown) => {
        const p = parsed as { kind?: string; v?: string };
        if (p.kind === "tripwire") {
          return {
            type: "error",
            error: "policy violation",
            recoverable: true,
            terminal: true,
          } as const;
        }
        if (p.kind === "text") return { type: "text", text: p.v ?? "" } as const;
        return undefined;
      },
      activity: () => "productive",
      buildDoneMeta: () => ({}),
    })) {
      chunks.push(chunk);
    }

    // Exactly two chunks: pre-tripwire text, then the terminal error. The
    // post-tripwire "after" line must NOT appear, and no `done` is
    // synthesized on top of a policy violation.
    expect(chunks).toEqual([
      { type: "text", text: "before " },
      {
        type: "error",
        error: "policy violation",
        recoverable: true,
        terminal: true,
      },
    ]);

    // The child was killed promptly — not left to run out its sleep 30 and
    // the 10s idle timer.
    const code = await proc.exited;
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(code).not.toBe(0);
  });

  test("a non-terminal recoverable error still streams like before", async () => {
    // Guard the other direction: ordinary recoverable parser errors (API
    // gate, mid-stream 4XX-style) do NOT kill the child or truncate the
    // stream — only `terminal: true` gets the new semantics.
    const proc = spawnInNewSession(
      [
        "sh",
        "-c",
        'echo \'{"kind":"err"}\'; echo \'{"kind":"text","v":"still here"}\'',
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    trackedPids.push(proc.pid!);

    const chunks: unknown[] = [];
    for await (const chunk of runHarnessProcess({
      proc,
      harnessId: "test-harness",
      req: {
        idleTimeoutMs: 5_000,
        workingDir: process.cwd(),
        persona: "test",
        conversation: "test",
        userMessage: "test",
      } as never,
      parseEvent: (parsed: unknown) => {
        const p = parsed as { kind?: string; v?: string };
        if (p.kind === "err") {
          return { type: "error", error: "transient", recoverable: true } as const;
        }
        if (p.kind === "text") return { type: "text", text: p.v ?? "" } as const;
        return undefined;
      },
      activity: () => "productive",
      buildDoneMeta: () => ({}),
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { type: "error", error: "transient", recoverable: true },
      { type: "text", text: "still here" },
      { type: "done", finalText: "still here", meta: {} },
    ]);
    expect(await proc.exited).toBe(0);
  });
});
