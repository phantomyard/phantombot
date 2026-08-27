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
  drainStderr,
  isShutdownExit,
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

describe("createKillCoordinator — startup timer", () => {
  test("startup timer fires when the subprocess emits NO output before startupTimeoutMs", async () => {
    // Process is silent for 30s (mimics `claude --print` wedged on its MCP
    // init handshake — nothing ever reaches stdout). firstOutput() is never
    // called, so the startup timer must fire and kill the group.
    const proc = spawnInNewSession(["sh", "-c", "sleep 30"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    trackedPids.push(proc.pid!);

    const killer = createKillCoordinator({
      proc,
      idleTimeoutMs: 10_000, // long; would NOT fire in this window
      hardTimeoutMs: 10_000,
      startupTimeoutMs: 150,
      harnessId: "test",
    });

    await proc.exited;
    await killer.dispose();

    expect(killer.killCause()).toBe("startup");
  });

  test("firstOutput() cancels the startup timer so a slow-but-alive turn survives", async () => {
    // Emits one line immediately, then goes quiet for 300ms — longer than the
    // 100ms startup window but well under the 5s idle window. firstOutput() on
    // the first byte must cancel the startup timer; the idle timer governs from
    // there, so the process runs to completion uncancelled.
    const proc = spawnInNewSession(["sh", "-c", "echo hi; sleep 0.3"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    trackedPids.push(proc.pid!);

    const killer = createKillCoordinator({
      proc,
      idleTimeoutMs: 5000,
      hardTimeoutMs: 10_000,
      startupTimeoutMs: 100,
      harnessId: "test",
    });

    const decoder = new TextDecoder();
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const { value } = await reader.read();
    killer.firstOutput(); // first byte: cancels the startup timer
    if (value) killer.touch();
    expect(decoder.decode(value)).toContain("hi");
    reader.releaseLock();

    await proc.exited;
    await killer.dispose();

    // Startup timer was cancelled; idle window (5s) never elapsed → clean exit.
    expect(killer.killCause()).toBeUndefined();
  });

  test("no startupTimeoutMs → startup timer disabled (legacy behaviour)", async () => {
    // Silent process, but startupTimeoutMs omitted: only the idle window bounds
    // startup silence. With a long idle window the process is NOT startup-killed.
    const proc = spawnInNewSession(["sh", "-c", "sleep 0.3"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    trackedPids.push(proc.pid!);

    const killer = createKillCoordinator({
      proc,
      idleTimeoutMs: 5000,
      hardTimeoutMs: 10_000,
      harnessId: "test",
    });

    await proc.exited;
    await killer.dispose();

    expect(killer.killCause()).toBeUndefined();
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

  // The orchestrator branches on the STRUCTURED cause, not on the prose
  // (issue #459): an idle kill that had already produced output is resumed
  // with context, a hard-cap timeout never is. Losing this field would
  // silently disable the recovery, so pin it for every cause.
  test.each([
    ["timeout"],
    ["idle"],
    ["startup"],
    ["aborted"],
    ["policy"],
  ] as const)("%s cause is carried structurally as killCause", (cause) => {
    const c = killCauseToErrorChunk(cause, "pi", 60_000, 300_000, 45_000);
    expect(c?.killCause).toBe(cause);
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

  test("startup cause → recoverable error mentioning the startup window", () => {
    const c = killCauseToErrorChunk("startup", "claude", 60_000, 300_000, 45_000);
    expect(c).toMatchObject({
      type: "error",
      recoverable: true,
    });
    expect(c?.error).toContain("45000ms");
    expect(c?.error).toContain("no output");
    expect(c?.error).toContain("handshake");
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

describe("runHarnessProcess — startup wedge", () => {
  test("a silent subprocess yields a recoverable 'startup' error fast", async () => {
    // Mimics a foreground harness wedged before any output (blocked MCP init).
    // startupTimeoutMs is short; the runner must surface a recoverable error
    // WELL before the (long) idle window would have fired.
    const proc = spawnInNewSession(["sleep", "30"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    trackedPids.push(proc.pid!);

    const startTime = Date.now();
    const chunks: any[] = [];
    const generator = runHarnessProcess({
      proc,
      harnessId: "test-harness",
      req: {
        idleTimeoutMs: 10_000, // would NOT fire in the test window
        hardTimeoutMs: 10_000,
        startupTimeoutMs: 200,
        workingDir: process.cwd(),
        persona: "test",
        trusted: true,
        conversation: "test",
        userMessage: "test",
      } as any,
      stdinPayload: "hi",
      parseEvent: () => undefined,
      activity: () => "productive",
      buildDoneMeta: () => ({}),
    });

    for await (const chunk of generator) {
      chunks.push(chunk);
    }

    expect(Date.now() - startTime).toBeLessThan(5000);
    const errorChunk = chunks.find((c) => c.type === "error");
    expect(errorChunk).toBeDefined();
    expect(errorChunk.error).toContain("no output");
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

describe("isShutdownExit", () => {
  test("SIGTERM from outside phantombot is a shutdown, not a harness fault", () => {
    expect(isShutdownExit("SIGTERM", 143)).toBe(true);
    expect(isShutdownExit(undefined, 143)).toBe(true);
    expect(isShutdownExit("SIGINT", 130)).toBe(true);
    expect(isShutdownExit("SIGHUP", 129)).toBe(true);
  });

  test("SIGKILL is NOT — that's as often the OOM killer as a stop", () => {
    expect(isShutdownExit("SIGKILL", 137)).toBe(false);
  });

  test("ordinary failures are unaffected", () => {
    expect(isShutdownExit(undefined, 1)).toBe(false);
    expect(isShutdownExit(undefined, 127)).toBe(false);
  });
});

describe("runHarnessProcess — shutdown signal", () => {
  test("a SIGTERMed child yields a NON-recoverable error (no fallback spawn)", async () => {
    // Emit one line so the stream is live, then sit still and get SIGTERMed
    // from outside — exactly what systemd does to the whole cgroup on
    // `phantombot restart`, and what made Robbie spawn a paid fallback for a
    // reply nobody would receive.
    const proc = spawnInNewSession(
      ["sh", "-c", 'echo \'{"text":"hi"}\'; sleep 30'],
      { stdout: "pipe", stderr: "pipe" },
    );
    trackedPids.push(proc.pid!);
    setTimeout(() => {
      try {
        // Signal the whole group, like systemd does to the cgroup — killing
        // only `sh` would leave `sleep` holding the pipe open.
        process.kill(-proc.pid!, "SIGTERM");
      } catch {
        /* already gone */
      }
    }, 250);

    const chunks: any[] = [];
    const generator = runHarnessProcess({
      proc,
      harnessId: "test-harness",
      req: {
        idleTimeoutMs: 30_000,
        hardTimeoutMs: 30_000,
        workingDir: process.cwd(),
        persona: "test",
        conversation: "test",
        userMessage: "test",
      } as any,
      parseEvent: (parsed: any) =>
        parsed?.text ? { type: "text", text: parsed.text } : undefined,
      activity: () => "productive",
      buildDoneMeta: () => ({}),
    });
    for await (const chunk of generator) chunks.push(chunk);

    const err = chunks.find((c) => c.type === "error");
    expect(err).toBeDefined();
    expect(err.recoverable).toBe(false);
    expect(err.error).toContain("shutting down");
  });
});

describe("runHarnessProcess — stderr capture (issue #462)", () => {
  test("non-zero exit attaches stderrTail to the error chunk", async () => {
    // A subprocess that writes to stderr then exits non-zero. The ring
    // buffer should capture the lines and attach them as `stderrTail`.
    const proc = spawnInNewSession(
      ["sh", "-c", 'echo "error: something broke" >&2; echo "error: more details" >&2; exit 1'],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    trackedPids.push(proc.pid!);

    const chunks: any[] = [];
    for await (const chunk of runHarnessProcess({
      proc,
      harnessId: "test-harness",
      req: {
        idleTimeoutMs: 10_000,
        hardTimeoutMs: 10_000,
        workingDir: process.cwd(),
        persona: "test",
        conversation: "test",
        userMessage: "test",
      } as any,
      parseEvent: () => undefined,
      activity: () => "productive",
      buildDoneMeta: () => ({}),
    })) {
      chunks.push(chunk);
    }

    const err = chunks.find((c) => c.type === "error");
    expect(err).toBeDefined();
    expect(err.error).toContain("exited with code 1");
    expect(Array.isArray(err.stderrTail)).toBe(true);
    expect(err.stderrTail).toContain("error: something broke");
    expect(err.stderrTail).toContain("error: more details");
  });

  test("exit 0 with stderr stays quiet — no warn-level stderrTail", async () => {
    // A subprocess that writes to stderr but exits 0. The stderrTail is
    // still attached (the ring buffer captures regardless of exit code),
    // but the log level must NOT be promoted to warn — exit 0 is a happy
    // path. We verify the chunk is a clean `done`, not an error.
    const proc = spawnInNewSession(
      ["sh", "-c", 'echo "some warning text" >&2; echo \'{}\''],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    trackedPids.push(proc.pid!);

    const chunks: any[] = [];
    for await (const chunk of runHarnessProcess({
      proc,
      harnessId: "test-harness",
      req: {
        idleTimeoutMs: 10_000,
        hardTimeoutMs: 10_000,
        workingDir: process.cwd(),
        persona: "test",
        conversation: "test",
        userMessage: "test",
      } as any,
      parseEvent: () => ({ type: "done", finalText: "ok", meta: {} } as const),
      activity: () => "productive",
      buildDoneMeta: () => ({}),
    })) {
      chunks.push(chunk);
    }

    // No error chunk — the done is clean.
    const err = chunks.find((c) => c.type === "error");
    expect(err).toBeUndefined();
    const done = chunks.find((c) => c.type === "done");
    expect(done).toBeDefined();
    // stderrTail is NOT on the done chunk — it only goes on error chunks.
    expect(done.stderrTail).toBeUndefined();
  });

  test("ring buffer is bounded at 20 lines", async () => {
    // Write 30 stderr lines, exit non-zero. Only the last 20 should survive
    // in stderrTail — the ring buffer evicts the oldest.
    const proc = spawnInNewSession(
      [
        "sh",
        "-c",
        "for i in $(seq 1 30); do echo \"line $i\" >&2; done; exit 1",
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    trackedPids.push(proc.pid!);

    const chunks: any[] = [];
    for await (const chunk of runHarnessProcess({
      proc,
      harnessId: "test-harness",
      req: {
        idleTimeoutMs: 10_000,
        hardTimeoutMs: 10_000,
        workingDir: process.cwd(),
        persona: "test",
        conversation: "test",
        userMessage: "test",
      } as any,
      parseEvent: () => undefined,
      activity: () => "productive",
      buildDoneMeta: () => ({}),
    })) {
      chunks.push(chunk);
    }

    const err = chunks.find((c) => c.type === "error");
    expect(err).toBeDefined();
    expect(err.stderrTail.length).toBe(20);
    // The oldest lines (1-10) are evicted; the tail starts at line 11.
    expect(err.stderrTail[0]).toContain("line 11");
    expect(err.stderrTail[19]).toContain("line 30");
  });
});

describe("runHarnessProcess — stderr capture hardening (PR #464 review)", () => {
  const run = async (cmd: string[]) => {
    const proc = spawnInNewSession(cmd, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    trackedPids.push(proc.pid!);
    const chunks: any[] = [];
    for await (const chunk of runHarnessProcess({
      proc,
      harnessId: "test-harness",
      req: {
        idleTimeoutMs: 10_000,
        hardTimeoutMs: 30_000,
        workingDir: process.cwd(),
        persona: "test",
        conversation: "test",
        userMessage: "test",
      } as any,
      parseEvent: () => undefined,
      activity: () => "productive",
      buildDoneMeta: () => ({}),
    })) {
      chunks.push(chunk);
    }
    return chunks;
  };

  test("captures the FINAL unterminated stderr line (no trailing newline)", async () => {
    // The exact repro from review: a fatal written without a newline before
    // exit 1 must still land in stderrTail.
    const chunks = await run([
      "sh",
      "-c",
      'printf "warn: booting\\n" >&2; printf fatal >&2; exit 1',
    ]);
    const err = chunks.find((c) => c.type === "error");
    expect(err).toBeDefined();
    expect(err.stderrTail).toContain("warn: booting");
    expect(err.stderrTail).toContain("fatal");
  });

  test("10 MiB of unterminated stderr stays bounded — captured, not buffered whole", async () => {
    const chunks = await run([
      "sh",
      "-c",
      'head -c 10485760 /dev/zero | tr "\\0" "x" >&2; exit 1',
    ]);
    const err = chunks.find((c) => c.type === "error");
    expect(err).toBeDefined();
    expect(Array.isArray(err.stderrTail)).toBe(true);
    // Bounded: at least one line captured (not zero), each line within the
    // 1MB pending cap — never the full 10 MiB buffered or in the chunk. The
    // ring further caps each stored line to 500 chars (~8KB total).
    expect(err.stderrTail.length).toBeGreaterThanOrEqual(1);
    for (const line of err.stderrTail) {
      expect(line.length).toBeLessThanOrEqual(1_000_000);
      expect(line.length).toBeLessThanOrEqual(500);
    }
  });

  test("credential-shaped stderr is redacted before it becomes a HarnessChunk", async () => {
    // stderrTail flows into failover alerts that are broadcast (Telegram /
    // PhantomChat) and persisted as assistant turns — those paths do NOT go
    // through the logger's redaction choke point, so redaction must happen
    // at capture time. This mirrors the review repro.
    const chunks = await run([
      "sh",
      "-c",
      'echo "API_KEY=super-secret-value-123456789" >&2; exit 1',
    ]);
    const err = chunks.find((c) => c.type === "error");
    expect(err).toBeDefined();
    expect(err.stderrTail.join("\n")).toContain("API_KEY=[REDACTED]");
    expect(err.stderrTail.join("\n")).not.toContain("super-secret-value");
  });
});

describe("drainStderr — over-cap boundary never splits a credential (PR #464)", () => {
  const streamFrom = (chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });

  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

  test("an over-cap unterminated line is replaced whole, never emitted as fragments", async () => {
    // The review repro, deterministic: chunk 1 ends EXACTLY at the pending
    // cap with the credential label, chunk 2 carries the naked value. The
    // old slice-emit path produced the bare label line, then the naked
    // secret value as an independent "line" — each fragment evades the
    // redactor. The line must instead be replaced wholesale by a marker and
    // its remainder swallowed up to the newline.
    const cap = 6;
    const label = "TOKEN="; // exactly cap bytes — the repro's precise boundary
    const secret = "super-secret-value-123456789";
    const collected: string[] = [];
    await drainStderr(
      streamFrom([enc(label), enc(`${secret}\nafter\n`)]),
      (line) => collected.push(line),
      cap,
    );
    // The oversized line collapsed into a single truncation marker; the
    // following short line survived; neither fragment of the credential
    // appears anywhere.
    expect(collected).toContain(`[stderr line truncated: exceeded ${cap} bytes]`);
    expect(collected).toContain("after");
    expect(collected.join("\n")).not.toContain("TOKEN=");
    expect(collected.join("\n")).not.toContain(secret);
  });

  test("oversized tail at stream end is not re-emitted after the marker", async () => {
    // If the stream ends mid-oversized-line, the final-flush path must not
    // leak the swallowed remainder (the marker already replaced that line).
    const cap = 8;
    const collected: string[] = [];
    await drainStderr(
      streamFrom([enc("AAAAAAAAAAAA"), enc("BBBBBBBBBBsecret")]),
      (line) => collected.push(line),
      cap,
    );
    expect(collected).toEqual([`[stderr line truncated: exceeded ${cap} bytes]`]);
    expect(collected.join("")).not.toContain("secret");
  });
});
