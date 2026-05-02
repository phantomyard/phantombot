/**
 * Tests for the process-group spawn + kill helpers.
 *
 * These actually spawn real subprocesses (cheap shells) and signal them.
 * No mocks here — the whole point of the helpers is that the kernel
 * routes signals to the right pids, and we can only verify that against
 * a real OS.
 *
 * The orphan-grandchild test is the load-bearing one: it demonstrates
 * the actual bug fix (gemini-usage-hung-TCP scenario, kw-openclaw
 * 2026-05-02). If it ever stops passing, phantombot has lost the
 * ability to clean up after wedged subprocesses.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  killProcessGroup,
  spawnInNewSession,
} from "../src/lib/processGroup.ts";

function isAlive(pid: number): boolean {
  try {
    // signal 0 = "are you there?" — no signal sent, just permission/existence check
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
    // EPERM means the process exists but we can't signal it. For our
    // tests, all processes are owned by us, so this shouldn't happen.
    throw e;
  }
}

/**
 * After a kill, a process can briefly remain in the kernel's process
 * table as a zombie (state Z) until its parent reaps it via wait().
 * `kill 0` returns success on zombies — they're "alive" by that test.
 * For grandchildren whose parent we just killed, init takes over
 * reaping but the window can be tens of ms. Poll briefly.
 */
async function isFullyDead(pid: number, withinMs = 1000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    // If still in table, check whether it's a zombie (state Z = the
    // process has terminated but isn't reaped). A zombie counts as
    // dead for our purposes — its work is done.
    try {
      const stat = await Bun.file(`/proc/${pid}/stat`).text();
      const fields = stat.split(" ");
      // Field 3 in /proc/<pid>/stat is the state code.
      if (fields[2] === "Z") return true;
    } catch {
      // /proc entry vanished — process is gone.
      return true;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

async function readUntilNewline(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    if (buf.includes("\n")) return buf.split("\n")[0]!;
  }
  return buf;
}

// Cleanup safety net: track every grandchild pid we discover so a
// failing test never leaks a 60s sleep into someone's process table.
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

describe("spawnInNewSession", () => {
  test("starts the binary with the same pid==pgid (the kill-the-group precondition)", async () => {
    // We can't observe pgid directly without /proc, but we CAN verify
    // that the process started and is reachable via its own pid.
    const proc = spawnInNewSession(["sleep", "30"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    trackedPids.push(proc.pid!);
    expect(isAlive(proc.pid!)).toBe(true);
    // Send to negative pid → kills the group. If pgid != pid, this would
    // either ESRCH or kill an unrelated group; either way the process
    // would NOT die. We assert it does die, which proves pid == pgid.
    process.kill(-proc.pid!, "SIGTERM");
    await proc.exited;
    expect(isAlive(proc.pid!)).toBe(false);
  });
});

describe("killProcessGroup — orphan grandchild fix", () => {
  test("SIGTERM to the group reaps both parent AND grandchild", async () => {
    // Shell spawns a backgrounded sleep, prints its pid, then waits.
    // Without process-group kill, killing the shell would leave the
    // sleep (the "grandchild") running forever — that's the kw-openclaw
    // gemini-usage bug, reproduced in miniature.
    const proc = spawnInNewSession(
      ["sh", "-c", "sleep 30 & echo $!; wait"],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    trackedPids.push(proc.pid!);

    const firstLine = await readUntilNewline(
      proc.stdout as ReadableStream<Uint8Array>,
    );
    const grandchildPid = Number(firstLine.trim());
    expect(Number.isInteger(grandchildPid)).toBe(true);
    expect(grandchildPid).toBeGreaterThan(0);
    trackedPids.push(grandchildPid);

    expect(isAlive(grandchildPid)).toBe(true);
    expect(isAlive(proc.pid!)).toBe(true);

    await killProcessGroup(proc, 1000);

    // Both parent and grandchild are gone — the whole point of the fix.
    // Grandchild may briefly be a zombie before init reaps it; isFullyDead
    // accepts either truly-gone or zombie state.
    expect(await isFullyDead(grandchildPid)).toBe(true);
    expect(await isFullyDead(proc.pid!)).toBe(true);
  });
});

describe("killProcessGroup — SIGTERM→SIGKILL escalation", () => {
  test("escalates to SIGKILL when SIGTERM is trapped/ignored", async () => {
    // Use a Bun process that registers a no-op SIGTERM handler so the
    // signal is delivered but the process keeps running. Only SIGKILL
    // (which can't be trapped) terminates it. Without escalation,
    // killProcessGroup would hang forever — proc.exited never resolves.
    //
    // We use bun-as-the-child rather than `sh -c "trap '' TERM; sleep 30"`
    // because the shell's child sleep would receive the same SIGTERM
    // (it's in the group too), die, and the shell would exit with it.
    const proc = spawnInNewSession(
      [
        process.execPath,
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 60_000);",
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    trackedPids.push(proc.pid!);

    // Give Bun a moment to register the handler before we signal.
    await new Promise((r) => setTimeout(r, 100));

    const start = Date.now();
    await killProcessGroup(proc, 250);
    const elapsedMs = Date.now() - start;

    // SIGTERM ignored → grace window → SIGKILL → process dies.
    // Lower bound: must wait at least the grace period.
    // Upper bound: should be quick once SIGKILL fires (well under 2s).
    expect(elapsedMs).toBeGreaterThanOrEqual(200);
    expect(elapsedMs).toBeLessThan(3000);
    expect(isAlive(proc.pid!)).toBe(false);
  });

  test("does NOT escalate when the process exits cleanly during the grace window", async () => {
    // Cooperative shell: receives SIGTERM and exits immediately.
    const proc = spawnInNewSession(["sleep", "30"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    trackedPids.push(proc.pid!);

    const start = Date.now();
    await killProcessGroup(proc, 5000);
    const elapsedMs = Date.now() - start;

    // SIGTERM honored → process exits within milliseconds; we should NOT
    // sit out the full 5s grace.
    expect(elapsedMs).toBeLessThan(500);
    expect(isAlive(proc.pid!)).toBe(false);
  });
});

describe("killProcessGroup — already-dead handling", () => {
  test("safe to call after the process has already exited", async () => {
    const proc = spawnInNewSession(["true"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
    // Should not throw, should not hang.
    await killProcessGroup(proc, 100);
  });
});
