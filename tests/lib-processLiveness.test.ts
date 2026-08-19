import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  cachedSpawnToken,
  isSameProcess,
  osStartProbeEnabled,
  parseWindowsStart,
  probeOutcomeForError,
  resetStartProbeCachesForTests,
  windowsStartToken,
  type ProbeRunner,
} from "../src/lib/processLiveness.ts";

describe("parseWindowsStart", () => {
  test("parses a PowerShell round-trip ISO 8601 datetime", () => {
    const out = "2026-08-19T14:22:31.1234567+02:00\r\n";
    expect(parseWindowsStart(out)).toBe("2026-08-19T14:22:31.1234567+02:00");
  });

  test("parses a wmic CIM_DATETIME", () => {
    // yyyymmddhhmmss.uuuuuu+timezone
    const out = "20260819142231.123456+120\r\n";
    expect(parseWindowsStart(out)).toBe("20260819142231.123456+120");
  });

  test("parses a UTC wmic datetime with +0 offset", () => {
    const out = "20260819142231.123456+0\r\n";
    expect(parseWindowsStart(out)).toBe("20260819142231.123456+0");
  });

  test("skips the wmic header row and returns the value", () => {
    // wmic output includes a "CreationDate" header before the actual value
    const out = "CreationDate\r\n20260819142231.123456+120\r\n\r\n";
    expect(parseWindowsStart(out)).toBe("20260819142231.123456+120");
  });

  test("returns the FIRST matching line when multiple are present", () => {
    const out =
      "2026-08-19T14:22:31.1234567+02:00\r\n2026-08-19T14:25:00.0000000+02:00\r\n";
    expect(parseWindowsStart(out)).toBe("2026-08-19T14:22:31.1234567+02:00");
  });

  test("returns null for an empty string (process exited before probe)", () => {
    expect(parseWindowsStart("")).toBeNull();
    expect(parseWindowsStart("   ")).toBeNull();
    expect(parseWindowsStart("\r\n\r\n")).toBeNull();
  });

  test("returns null for the bare header with no data row", () => {
    expect(parseWindowsStart("CreationDate\r\n\r\n")).toBeNull();
  });

  test("returns null for a localized error message", () => {
    // wmic may emit error text in the system locale
    expect(parseWindowsStart("ERROR - Description = Not found")).toBeNull();
  });

  test("returns null for a partial datetime (not a valid identity)", () => {
    // A partial match would be an identity that changes on its own — rejected
    expect(parseWindowsStart("2026-08-19")).toBeNull();
    expect(parseWindowsStart("14:22:31")).toBeNull();
    expect(parseWindowsStart("20260819142231")).toBeNull(); // missing fractional + tz
  });

  test("returns null for a PowerShell error stream", () => {
    // PowerShell may emit errors on stdout in some configurations
    expect(
      parseWindowsStart(
        "Get-CimInstance : Cannot find the process\r\n    + CategoryInfo : ...",
      ),
    ).toBeNull();
  });

  test("handles Unix newlines (LF) as well as Windows (CRLF)", () => {
    expect(parseWindowsStart("2026-08-19T14:22:31.1234567+02:00\n")).toBe(
      "2026-08-19T14:22:31.1234567+02:00",
    );
  });

  test("trims whitespace around the value", () => {
    expect(parseWindowsStart("  2026-08-19T14:22:31.1234567+02:00  \r\n")).toBe(
      "2026-08-19T14:22:31.1234567+02:00",
    );
  });
});

/**
 * Cost tests for the Windows ladder.
 *
 * These assert HOW MANY times the OS is asked, not just what comes back — which
 * is the actual contract. The first cut of this probe returned the correct
 * token and was still a defect: it asked PowerShell first (a .NET runtime start)
 * with a 10s timeout, on a path whose entire budget is ~120ms, for every foreign
 * ticket on every retry. A contended guard spawned dozens of interpreters, an
 * in-process registry test blew its 5s timeout at 5021ms, and on a
 * console-less phantombot each spawn flashed a black window at the user.
 *
 * The runner is injected, so the ladder's order, its pinning and its give-up
 * state are all exercised here rather than only on a Windows runner.
 */
describe("windowsStartToken — probe ladder cost", () => {
  const ISO = "2026-08-19T14:22:31.1234567+02:00";

  /** Records every command asked for; answers per a canned policy. */
  function runner(policy: Record<string, "answer" | "empty" | "unusable">) {
    const calls: string[] = [];
    const run: ProbeRunner = (cmd) => {
      calls.push(cmd);
      const verdict = policy[cmd] ?? "unusable";
      if (verdict === "unusable") return { status: "unusable" };
      return { status: "answered", out: verdict === "answer" ? ISO : "" };
    };
    return { calls, run };
  }

  beforeEach(() => resetStartProbeCachesForTests());
  afterEach(() => {
    resetStartProbeCachesForTests();
    delete process.env.PHANTOMBOT_PROCESS_START_PROBE;
  });

  test("asks the cheap probe (wmic) before PowerShell", () => {
    const { calls, run } = runner({ wmic: "answer" });
    expect(windowsStartToken(4321, run)).toBe(ISO);
    // Not merely "wmic was asked" — asked FIRST, and PowerShell not at all.
    expect(calls).toEqual(["wmic"]);
  });

  test("a working probe is remembered, so later pids skip the failed rung", () => {
    const { calls, run } = runner({ "powershell.exe": "answer" });
    expect(windowsStartToken(1, run)).toBe(ISO);
    expect(calls).toEqual(["wmic", "powershell.exe"]);

    // Second question: the dead rung is not re-tried. Without pinning, every
    // liveness check on a wmic-less box pays a doomed spawn first.
    calls.length = 0;
    expect(windowsStartToken(2, run)).toBe(ISO);
    expect(calls).toEqual(["powershell.exe"]);
  });

  test("a box where nothing answers is asked exactly once, ever", () => {
    const { calls, run } = runner({});
    expect(windowsStartToken(1, run)).toBeNull();
    expect(calls).toEqual(["wmic", "powershell.exe"]);

    // The give-up state. A policy-blocked PowerShell with no wmic would
    // otherwise re-run the whole ladder — two failed spawns — for the life of
    // the process, on every single liveness question.
    calls.length = 0;
    expect(windowsStartToken(2, run)).toBeNull();
    expect(windowsStartToken(3, run)).toBeNull();
    expect(calls).toEqual([]);
  });

  test("a pid that has already exited does not demote the probe", () => {
    // wmic exits non-zero ("No Instance(s) Available") for a dead pid. That is
    // the probe working: treating it as unusable would send every dead pid
    // down the whole ladder and then permanently give up.
    const { calls, run } = runner({ wmic: "empty" });
    expect(windowsStartToken(1, run)).toBeNull();
    expect(calls).toEqual(["wmic"]);

    calls.length = 0;
    expect(windowsStartToken(2, run)).toBeNull();
    expect(calls).toEqual(["wmic"]);
  });

  test("a pinned probe that stops working falls back to rediscovery", () => {
    const policy: Record<string, "answer" | "empty" | "unusable"> = {
      wmic: "answer",
    };
    const { calls, run } = runner(policy);
    expect(windowsStartToken(1, run)).toBe(ISO);

    // wmic is removed under us (a 24H2 upgrade mid-process is the honest
    // version of this). The next call answers null, but must not conclude the
    // box is hopeless — PowerShell has not been asked yet.
    policy.wmic = "unusable";
    policy["powershell.exe"] = "answer";
    calls.length = 0;
    expect(windowsStartToken(2, run)).toBeNull();
    expect(calls).toEqual(["wmic"]);

    calls.length = 0;
    expect(windowsStartToken(3, run)).toBe(ISO);
    expect(calls).toEqual(["wmic", "powershell.exe"]);
  });

  test("the off-switch spawns nothing at all", () => {
    // For a box where the interpreter is blocked by policy, or where an
    // operator simply will not have phantombot starting shells. Degrades to
    // the pid-only check that every non-Linux platform had before the token.
    process.env.PHANTOMBOT_PROCESS_START_PROBE = "0";
    const { calls, run } = runner({ wmic: "answer" });
    expect(osStartProbeEnabled()).toBe(false);
    expect(windowsStartToken(1, run)).toBeNull();
    expect(calls).toEqual([]);
  });

  test("a non-integer pid never reaches a command line", () => {
    const { calls, run } = runner({ wmic: "answer" });
    expect(windowsStartToken(Number("1; rm -rf /"), run)).toBeNull();
    expect(windowsStartToken(-1, run)).toBeNull();
    expect(windowsStartToken(1.5, run)).toBeNull();
    expect(calls).toEqual([]);
  });
});

/**
 * The identity check must degrade to "still the same process" when it cannot
 * tell — including when the operator has switched the probe off. Reading a
 * missing token as a MISMATCH would evict live holders from the workspace
 * guard, which is the two-writer state the whole module exists to prevent.
 */
describe("isSameProcess with the probe disabled", () => {
  afterEach(() => {
    resetStartProbeCachesForTests();
    delete process.env.PHANTOMBOT_PROCESS_START_PROBE;
  });

  test("an unreadable token leaves a live pid alive", () => {
    process.env.PHANTOMBOT_PROCESS_START_PROBE = "off";
    expect(isSameProcess(process.pid, "a-token-from-another-boot", () => true, () => null)).toBe(
      true,
    );
  });

  test("a dead pid is still dead, probe or no probe", () => {
    process.env.PHANTOMBOT_PROCESS_START_PROBE = "off";
    expect(isSameProcess(4242, "tok", () => false, () => null)).toBe(false);
  });
});

/**
 * The per-pid memo.
 *
 * The guard re-examines the same foreign tickets on every retry (six of them),
 * and `readRegistry` re-examines the same pids on every read. Without this, one
 * contended acquire on Windows was up to 42 interpreter starts — the reason
 * `entered` was 0 and the runner reported dangling processes.
 */
describe("cachedSpawnToken", () => {
  beforeEach(() => resetStartProbeCachesForTests());
  afterEach(() => resetStartProbeCachesForTests());

  test("asks the OS once per pid inside the window", () => {
    let calls = 0;
    const probe = () => {
      calls += 1;
      return "tok";
    };
    const t0 = 1_000_000;
    for (let i = 0; i < 6; i += 1) {
      expect(cachedSpawnToken(99, probe, t0 + i)).toBe("tok");
    }
    expect(calls).toBe(1);
  });

  test("caches per pid, not globally", () => {
    const seen: number[] = [];
    const probe = (pid: number) => {
      seen.push(pid);
      return `tok-${pid}`;
    };
    expect(cachedSpawnToken(1, probe, 5)).toBe("tok-1");
    expect(cachedSpawnToken(2, probe, 5)).toBe("tok-2");
    expect(cachedSpawnToken(1, probe, 5)).toBe("tok-1");
    expect(seen).toEqual([1, 2]);
  });

  test("caches a null answer too", () => {
    // "Can't tell" is the expensive answer to compute and the most likely one
    // on a locked-down box; re-deriving it every time is the whole cost.
    let calls = 0;
    const probe = () => {
      calls += 1;
      return null;
    };
    expect(cachedSpawnToken(7, probe, 100)).toBeNull();
    expect(cachedSpawnToken(7, probe, 200)).toBeNull();
    expect(calls).toBe(1);
  });

  test("re-asks once the entry has aged out", () => {
    let calls = 0;
    const probe = () => {
      calls += 1;
      return `tok-${calls}`;
    };
    expect(cachedSpawnToken(7, probe, 0)).toBe("tok-1");
    expect(cachedSpawnToken(7, probe, 14_999)).toBe("tok-1");
    // Staleness is bounded on purpose: a stale hit can only ever say "the same
    // process still holds this pid", i.e. still held — the safe direction — so
    // the window trades a few seconds of over-holding for the spawn storm.
    expect(cachedSpawnToken(7, probe, 15_001)).toBe("tok-2");
  });

  test("does not grow without bound", () => {
    const probe = (pid: number) => `tok-${pid}`;
    for (let pid = 1; pid <= 300; pid += 1) cachedSpawnToken(pid, probe, 0);
    // Nothing observable but the ceiling itself: re-asking for an evicted pid
    // is correct, just not free.
    expect(cachedSpawnToken(1, probe, 0)).toBe("tok-1");
  });
});

/**
 * Console-window suppression.
 *
 * `windowsHide` maps to CREATE_NO_WINDOW. Without it, a phantombot with no
 * console of its own — the scheduled-task and service installs, which is how it
 * actually runs on Windows — makes Windows allocate a NEW console per child, so
 * the user watches black windows flash past. There is no way to observe that
 * from a Linux test run and no way to observe it from a return value, so the
 * invariant is asserted against the source: every spawn on a Windows-reachable
 * path in these two modules carries the flag.
 */
describe("Windows spawns are hidden", () => {
  test("every spawn in processLiveness and filePermissions sets windowsHide", () => {
    for (const mod of ["processLiveness", "filePermissions"]) {
      const src = readFileSync(join(import.meta.dir, "..", "src", "lib", `${mod}.ts`), "utf8");
      const spawns = src.match(/(?:execFileSync|Bun\.spawnSync)\(/g) ?? [];
      const hidden = src.match(/windowsHide: true/g) ?? [];
      expect(spawns.length).toBeGreaterThan(0);
      expect(hidden.length).toBe(spawns.length);
    }
  });
});

/**
 * Failure classification.
 *
 * Not reachable through the injected runner the ladder tests use, and the most
 * consequential branch in the module: get it wrong and asking about ONE dead
 * pid convinces the ladder that the whole box is hopeless, permanently
 * disabling pid-reuse detection.
 */
describe("probeOutcomeForError", () => {
  const err = (fields: Record<string, unknown>) =>
    Object.assign(new Error("probe"), fields) as NodeJS.ErrnoException & {
      signal?: string | null;
    };

  test("a missing binary is unusable (wmic removed in 24H2+)", () => {
    expect(probeOutcomeForError(err({ code: "ENOENT" })).status).toBe("unusable");
  });

  test("a policy block is unusable", () => {
    expect(probeOutcomeForError(err({ code: "EACCES" })).status).toBe("unusable");
    expect(probeOutcomeForError(err({ code: "EPERM" })).status).toBe("unusable");
  });

  test("a probe we killed on our own timeout is unusable", () => {
    // Too slow for a path budgeted in tens of milliseconds. Answering "can't
    // tell" fast beats answering correctly after three seconds.
    expect(probeOutcomeForError(err({ code: "ETIMEDOUT" })).status).toBe("unusable");
    expect(probeOutcomeForError(err({ signal: "SIGTERM" })).status).toBe("unusable");
  });

  test("a non-zero exit is the probe ANSWERING about a dead pid", () => {
    // wmic: "No Instance(s) Available.", exit 1. The rung stays good.
    const outcome = probeOutcomeForError(err({ status: 1, signal: null }));
    expect(outcome).toEqual({ status: "answered", out: "" });
  });
});
