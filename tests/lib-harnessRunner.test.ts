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
      parseActivity: () => "productive",
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
