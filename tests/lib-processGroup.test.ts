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
import { delimiter, dirname } from "node:path";
import {
  killProcessGroup,
  spawnInNewSession,
  withCommandDirOnPath,
  withPhantombotBinDirOnPath,
} from "../src/lib/processGroup.ts";

// The spawn/kill tests below drive real POSIX subprocesses (`sleep`, `sh -c`,
// `#!/usr/bin/env node` shebangs) and the negative-pid group signal — none of
// which exist on Windows, where the equivalent path is taskkill /T (covered by
// its own Windows-only test at the bottom). Skip the POSIX-model suites on
// Windows rather than assert against a process model that isn't there.
const isWin = process.platform === "win32";
const describePosix = isWin ? describe.skip : describe;
const describeWin = isWin ? describe : describe.skip;

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

describePosix("spawnInNewSession", () => {
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

describePosix("killProcessGroup — orphan grandchild fix", () => {
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

describePosix("killProcessGroup — SIGTERM→SIGKILL escalation", () => {
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

// These are pure string tests with no subprocess, so they run on every
// platform. We build expected PATHs from the host's `path.delimiter`
// (":" on POSIX, ";" on Windows) and `path.dirname` — the same primitives
// withCommandDirOnPath uses — so the assertions hold on both without
// hardcoding a POSIX separator.
describe("withCommandDirOnPath — shebang interpreter resolution", () => {
  test("prepends an absolute binary's own dir to PATH", () => {
    const bin = "/opt/nvm/versions/node/v24/bin/pi";
    const before = ["/usr/bin", "/bin"].join(delimiter);
    const out = withCommandDirOnPath(bin, { PATH: before });
    expect(out.PATH).toBe([dirname(bin), before].join(delimiter));
  });

  test("is a no-op when the dir is already on PATH", () => {
    const bin = "/opt/nvm/versions/node/v24/bin/pi";
    const env = { PATH: [dirname(bin), "/usr/bin"].join(delimiter) };
    const out = withCommandDirOnPath(bin, env);
    // Same object reference back — nothing to change, no needless clone churn.
    expect(out).toBe(env);
    expect(out.PATH).toBe([dirname(bin), "/usr/bin"].join(delimiter));
  });

  test("handles an empty/absent PATH by seeding it with the bin dir", () => {
    expect(withCommandDirOnPath("/opt/tools/bin/pi", {}).PATH).toBe(
      "/opt/tools/bin",
    );
    expect(withCommandDirOnPath("/opt/tools/bin/pi", { PATH: "" }).PATH).toBe(
      "/opt/tools/bin",
    );
  });

  test("leaves a bare (PATH-resolved) command name untouched", () => {
    const env = { PATH: "/usr/bin:/bin" };
    const out = withCommandDirOnPath("pi", env);
    // A relative command is resolved via the existing PATH; dirname("pi")
    // is ".", which must NEVER be injected.
    expect(out).toBe(env);
    expect(out.PATH).toBe("/usr/bin:/bin");
  });

  test("never mutates the caller's env object", () => {
    const env = { PATH: "/usr/bin" };
    const out = withCommandDirOnPath("/opt/bin/pi", env);
    expect(out).not.toBe(env);
    expect(env.PATH).toBe("/usr/bin"); // original untouched
  });
});

// Pure string tests, cross-platform: a leading-slash path is absolute on both
// POSIX and Windows, and we build expected PATHs from the host `delimiter`/
// `dirname`, so these hold without hardcoding a separator. process.execPath is
// a writable property; we override it per-test and restore in a finally.
describe("withPhantombotBinDirOnPath — CLI self-call resolution", () => {
  function withExecPath<T>(exe: string, fn: () => T): T {
    const orig = process.execPath;
    try {
      Object.defineProperty(process, "execPath", {
        value: exe,
        configurable: true,
      });
      return fn();
    } finally {
      Object.defineProperty(process, "execPath", {
        value: orig,
        configurable: true,
      });
    }
  }

  test("prepends phantombot's own install dir when running as the binary", () => {
    withExecPath("/opt/programs/phantombot/phantombot", () => {
      const before = ["/usr/bin", "/bin"].join(delimiter);
      const out = withPhantombotBinDirOnPath({ PATH: before });
      expect(out.PATH).toBe(
        ["/opt/programs/phantombot", before].join(delimiter),
      );
    });
  });

  test("matches the Windows .exe name (case-insensitive)", () => {
    withExecPath("/opt/programs/phantombot/Phantombot.exe", () => {
      const out = withPhantombotBinDirOnPath({ PATH: "/usr/bin" });
      expect(out.PATH).toBe(
        ["/opt/programs/phantombot", "/usr/bin"].join(delimiter),
      );
    });
  });

  test("no-ops under a source run (execPath is bun/node, not phantombot)", () => {
    withExecPath("/usr/local/bin/bun", () => {
      const env = { PATH: "/usr/bin" };
      const out = withPhantombotBinDirOnPath(env);
      expect(out).toBe(env); // same reference — untouched
    });
  });

  test("is a no-op when the install dir is already on PATH", () => {
    withExecPath("/opt/programs/phantombot/phantombot", () => {
      const env = {
        PATH: ["/opt/programs/phantombot", "/usr/bin"].join(delimiter),
      };
      const out = withPhantombotBinDirOnPath(env);
      expect(out).toBe(env);
    });
  });

  test("seeds an empty/absent PATH with the install dir", () => {
    withExecPath("/opt/programs/phantombot/phantombot", () => {
      expect(withPhantombotBinDirOnPath({}).PATH).toBe(
        "/opt/programs/phantombot",
      );
      expect(withPhantombotBinDirOnPath({ PATH: "" }).PATH).toBe(
        "/opt/programs/phantombot",
      );
    });
  });

  test("never mutates the caller's env object", () => {
    withExecPath("/opt/programs/phantombot/phantombot", () => {
      const env = { PATH: "/usr/bin" };
      const out = withPhantombotBinDirOnPath(env);
      expect(out).not.toBe(env);
      expect(env.PATH).toBe("/usr/bin");
    });
  });
});

describeWin("killProcessGroup — Windows taskkill tree", () => {
  test("force-terminates a spawned console process tree via taskkill /T /F", async () => {
    // Windows analog of the orphan-grandchild test: `cmd /c ping -n 60` spawns
    // a child ping and blocks for ~60s. killProcessGroup must bring the whole
    // tree down with `taskkill /T /F` and resolve. Regression guard for the
    // exit-128 bug: `taskkill /T` WITHOUT /F returns 128 on a live console
    // tree, which we previously misread as "already gone" and then hung on
    // proc.exited. This must complete promptly, not sit out the grace window.
    const proc = spawnInNewSession(
      ["cmd", "/c", "ping -n 60 127.0.0.1 >NUL"],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    trackedPids.push(proc.pid!);
    expect(isAlive(proc.pid!)).toBe(true);

    const start = Date.now();
    await killProcessGroup(proc, 2000);
    const elapsedMs = Date.now() - start;

    // A forced kill resolves proc.exited well inside the grace window, so this
    // returns fast rather than waiting out the full 2s.
    expect(elapsedMs).toBeLessThan(2000);
    expect(isAlive(proc.pid!)).toBe(false);
  }, 15000);
});

describePosix("spawnInNewSession — shebang interpreter on a narrow PATH", () => {
  test("a #!/usr/bin/env node script beside its interpreter runs with a stripped PATH", async () => {
    // Reproduce the systemd exit-127 bug in miniature: put a Node-shebang
    // script in the SAME dir as a `node` symlink, then spawn it with a PATH
    // that does NOT contain that dir. Without the fix, `env node` fails
    // (exit 127); with it, the binary's own dir is prepended and node
    // resolves.
    const dir = `/tmp/pg-shebang-${process.pid}-${Date.now()}`;
    await Bun.$`mkdir -p ${dir}`.quiet();
    // Symlink a real node interpreter next to the script (mirrors nvm layout).
    await Bun.$`ln -sf ${process.execPath} ${dir}/node`.quiet();
    const script = `${dir}/fakepi`;
    await Bun.write(script, "#!/usr/bin/env node\nprocess.stdout.write('ok');\n");
    await Bun.$`chmod +x ${script}`.quiet();

    const proc = spawnInNewSession([script], {
      // Deliberately narrow PATH — the bin dir is NOT here.
      env: { PATH: "/usr/bin:/bin" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    trackedPids.push(proc.pid!);
    const out = await new Response(proc.stdout as ReadableStream).text();
    const code = await proc.exited;

    expect(code).toBe(0); // not 127
    expect(out).toBe("ok");

    await Bun.$`rm -rf ${dir}`.quiet();
  });
});

describePosix("killProcessGroup — already-dead handling", () => {
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
