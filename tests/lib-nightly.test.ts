import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildNightlyPrompt,
  buildNightlyPromptForPersona,
  BACKLOG_STAGNANT_MS,
  buildNightlyStagePrompt,
  dailyFilePath,
  dateRecord,
  loadNightlyState,
  NIGHTLY_STAGES,
  type NightlyState,
  nightlyConversationKey,
  nightlyHealth,
  nightlyStatePath,
  pendingForDate,
  isProcessAlive,
  type NightlyCurrent,
  saveNightlyState,
  STALE_RUN_MS,
  processStartToken,
  selfStartToken,
  sweepLiveness,
  sweepDailyFiles,
} from "../src/lib/nightly.ts";
import { OKF_TYPES } from "../src/lib/okf.ts";

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-nightly-"));
  await mkdir(join(workdir, "memory"), { recursive: true });
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

/** Write a daily file and return its recorded mtime (ms, floored). */
async function daily(date: string, body = `notes for ${date}`): Promise<void> {
  await writeFile(dailyFilePath(workdir, date), body, "utf8");
}

/** Mark a date as fully processed in the ledger, matching what's on disk. */
async function markProcessed(date: string): Promise<void> {
  const sweep = await sweepDailyFiles(workdir, await loadNightlyState(workdir), "9999-12-31");
  const p = sweep.pending.find((x) => x.date === date);
  if (!p) throw new Error(`no pending entry for ${date}`);
  await saveNightlyState(workdir, {
    processed: { [date]: dateRecord(p, [...NIGHTLY_STAGES]) },
  });
}

describe("nightlyConversationKey", () => {
  test("uses system:nightly:<date> namespace", () => {
    expect(nightlyConversationKey("2026-05-02")).toBe(
      "system:nightly:2026-05-02",
    );
  });
});

describe("nightlyStatePath / dailyFilePath", () => {
  test("state lives at memory/.nightly-state.json", () => {
    expect(nightlyStatePath("/tmp/persona")).toBe(
      "/tmp/persona/memory/.nightly-state.json",
    );
  });

  // The filename IS the primary key: six call sites build it from the date,
  // and index paths + [[memory/…]] wikilinks point at it. Nothing may rename
  // a daily file (e.g. to a "_processed_" prefix) — captures written after a
  // pass would recreate the un-prefixed name and orphan the processed half.
  test("daily files are memory/<date>.md, never renamed", () => {
    expect(dailyFilePath("/tmp/persona", "2026-08-16")).toBe(
      "/tmp/persona/memory/2026-08-16.md",
    );
  });
});

describe("loadNightlyState / saveNightlyState", () => {
  test("returns {} when no state file exists", async () => {
    expect(await loadNightlyState(workdir)).toEqual({});
  });

  test("save then load round-trips", async () => {
    await saveNightlyState(workdir, {
      last_run: "2026-05-02T02:15:00Z",
      last_status: "ok",
      items_promoted: 5,
    });
    const r = await loadNightlyState(workdir);
    expect(r.last_run).toBe("2026-05-02T02:15:00Z");
    expect(r.last_status).toBe("ok");
    expect(r.items_promoted).toBe(5);
  });

  // The ledger is the whole idempotency mechanism: a patch carrying one date
  // must never clobber the rest of history, or every prior date reprocesses.
  test("processed entries merge key-by-key instead of replacing", async () => {
    await saveNightlyState(workdir, {
      processed: {
        "2026-05-01": {
          mtime_ms: 1,
          size: 1,
          hash: "a",
          stages_done: [...NIGHTLY_STAGES],
          completed_at: "x",
          status: "ok",
        },
      },
    });
    await saveNightlyState(workdir, {
      processed: {
        "2026-05-02": {
          mtime_ms: 2,
          size: 1,
          hash: "b",
          stages_done: [...NIGHTLY_STAGES],
          completed_at: "y",
          status: "ok",
        },
      },
    });
    const r = await loadNightlyState(workdir);
    expect(Object.keys(r.processed ?? {}).sort()).toEqual([
      "2026-05-01",
      "2026-05-02",
    ]);
  });

  test("current: null clears the in-flight marker", async () => {
    await saveNightlyState(workdir, {
      current: {
        date: "2026-05-02",
        index: 1,
        total: 1,
        started_at: "x",
        updated_at: "x",
      },
    });
    await saveNightlyState(workdir, { current: null });
    expect((await loadNightlyState(workdir)).current).toBeUndefined();
  });
});

describe("sweepDailyFiles", () => {
  test("every daily file is pending on a virgin ledger, oldest first", async () => {
    await daily("2026-05-01");
    await daily("2026-05-03");
    await daily("2026-05-02");
    const r = await sweepDailyFiles(workdir, {}, "2026-06-01");
    expect(r.pending.map((p) => p.date)).toEqual([
      "2026-05-01",
      "2026-05-02",
      "2026-05-03",
    ]);
    expect(r.pending.every((p) => p.reason === "new")).toBe(true);
  });

  // The point of the ledger: a second sweep with nothing new does no work.
  test("a processed, unchanged date is skipped", async () => {
    await daily("2026-05-01");
    await markProcessed("2026-05-01");
    const r = await sweepDailyFiles(workdir, await loadNightlyState(workdir), "2026-06-01");
    expect(r.pending).toEqual([]);
    expect(r.seen).toEqual(["2026-05-01"]);
  });

  // A day can keep receiving captures AFTER its pass (the heartbeat and
  // `memory capture` both append). Content growth must re-queue it — this is
  // the case a "rename to _processed_" scheme could never see.
  test("a date whose content grew after processing is pending again", async () => {
    await daily("2026-05-01");
    await markProcessed("2026-05-01");
    await writeFile(dailyFilePath(workdir, "2026-05-01"), "more content", "utf8");
    const r = await sweepDailyFiles(workdir, await loadNightlyState(workdir), "2026-06-01");
    expect(r.pending.map((p) => p.date)).toEqual(["2026-05-01"]);
    expect(r.pending[0]!.reason).toBe("changed");
  });

  // mtime moved but bytes identical (a touch, a restore, a copy): no turn is
  // spent, the ledger's mtime is just refreshed so the cheap path resumes.
  test("a touched-but-identical file is 'touched', not pending", async () => {
    await daily("2026-05-01");
    await markProcessed("2026-05-01");
    const future = new Date(Date.now() + 10_000);
    await utimes(dailyFilePath(workdir, "2026-05-01"), future, future);
    const r = await sweepDailyFiles(workdir, await loadNightlyState(workdir), "2026-06-01");
    expect(r.pending).toEqual([]);
    expect(r.touched.map((t) => t.date)).toEqual(["2026-05-01"]);
  });

  // Today is still being written to. Distilling it would file drawers from a
  // half-finished file, and its hash would change minutes later anyway.
  test("the boundary date is exclusive — today is never swept", async () => {
    await daily("2026-05-01");
    await daily("2026-05-02");
    const r = await sweepDailyFiles(workdir, {}, "2026-05-02");
    expect(r.pending.map((p) => p.date)).toEqual(["2026-05-01"]);
  });

  test("non-daily files in memory/ are ignored", async () => {
    await daily("2026-05-01");
    await writeFile(join(workdir, "memory", "decisions.md"), "x", "utf8");
    await writeFile(join(workdir, "memory", "2026-05.md"), "x", "utf8");
    const r = await sweepDailyFiles(workdir, {}, "2026-06-01");
    expect(r.pending.map((p) => p.date)).toEqual(["2026-05-01"]);
  });

  // A pass that half-finished (one stage errored) is recorded as partial, so
  // resume is automatic — it is simply a date the ledger doesn't call done.
  test("a partially processed date is pending with reason 'incomplete'", async () => {
    await daily("2026-05-01");
    const sweep = await sweepDailyFiles(workdir, {}, "2026-06-01");
    await saveNightlyState(workdir, {
      processed: {
        "2026-05-01": dateRecord(sweep.pending[0]!, ["distill"], "kb blew up"),
      },
    });
    const r = await sweepDailyFiles(workdir, await loadNightlyState(workdir), "2026-06-01");
    expect(r.pending.map((p) => p.reason)).toEqual(["incomplete"]);
  });

  test("missing memory dir yields an empty sweep", async () => {
    const empty = await mkdtemp(join(tmpdir(), "phantombot-nightly-empty-"));
    try {
      expect(await sweepDailyFiles(empty, {}, "2026-06-01")).toEqual({
        pending: [],
        touched: [],
        seen: [],
      });
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe("pendingForDate", () => {
  test("returns an entry for an existing daily file, ledger ignored", async () => {
    await daily("2026-05-01");
    await markProcessed("2026-05-01");
    const p = await pendingForDate(workdir, "2026-05-01");
    expect(p?.date).toBe("2026-05-01");
    expect(p?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("returns null when there is no daily file", async () => {
    expect(await pendingForDate(workdir, "2026-05-09")).toBeNull();
  });
});

describe("dateRecord", () => {
  test("all stages, no error → ok", async () => {
    await daily("2026-05-01");
    const p = (await sweepDailyFiles(workdir, {}, "2026-06-01")).pending[0]!;
    const rec = dateRecord(p, [...NIGHTLY_STAGES]);
    expect(rec.status).toBe("ok");
    expect(rec.hash).toBe(p.hash);
    expect(rec.mtime_ms).toBe(p.mtime_ms);
  });

  test("some stages + error → partial; no stages + error → error", async () => {
    await daily("2026-05-01");
    const p = (await sweepDailyFiles(workdir, {}, "2026-06-01")).pending[0]!;
    expect(dateRecord(p, ["distill"], "boom").status).toBe("partial");
    expect(dateRecord(p, [], "boom").status).toBe("error");
  });
});

/**
 * Issue #402. The in-flight marker used to be judged purely on its timestamp,
 * which is precisely wrong for the way sweeps actually die: the sweep runs
 * inside the daemon's process, so a crash or a restart kills it while its last
 * beat is seconds old, and the sweep the restart spawns then stands down out
 * of deference to a process that no longer exists.
 */
describe("sweepLiveness", () => {
  const now = new Date("2026-05-18T09:00:00Z");
  function marker(
    beatAgoMs: number,
    pid?: number,
    pidStart?: string,
  ): NightlyCurrent {
    const at = new Date(now.getTime() - beatAgoMs).toISOString();
    return {
      date: "2026-05-01",
      index: 1,
      total: 3,
      started_at: at,
      updated_at: at,
      ...(pid === undefined ? {} : { pid }),
      ...(pidStart === undefined ? {} : { pid_start: pidStart }),
    };
  }

  test("a dead owner is dead however fresh its last beat looks", () => {
    expect(sweepLiveness(marker(1_000, 4242), now, () => false)).toBe("dead");
  });

  test("a live owner with a fresh beat is running", () => {
    expect(sweepLiveness(marker(1_000, 4242), now, () => true)).toBe("running");
  });

  // A process that exists but has stopped beating is a wedged turn, not a
  // crash — the pre-existing 45-minute rule still retires it.
  test("a live owner past STALE_RUN_MS is stalled", () => {
    expect(
      sweepLiveness(marker(STALE_RUN_MS + 1_000, 4242), now, () => true),
    ).toBe("stalled");
  });

  // Markers written before this change carry no pid; they must keep behaving
  // exactly as they did, or an upgrade would start stealing live sweeps.
  test("a marker with no pid falls back to the clock", () => {
    expect(sweepLiveness(marker(1_000), now, () => false)).toBe("running");
    expect(sweepLiveness(marker(STALE_RUN_MS + 1_000), now, () => false)).toBe(
      "stalled",
    );
  });

  test("an unparseable beat is stalled, not running", () => {
    const bad: NightlyCurrent = {
      date: "2026-05-01",
      index: 1,
      total: 1,
      started_at: "not-a-date",
      updated_at: "not-a-date",
    };
    expect(sweepLiveness(bad, now, () => true)).toBe("stalled");
  });

  // Pids wrap. Between the sweep dying and the next start an unrelated
  // process can inherit the number, and the pid check alone would then hold
  // the lock until the 45-minute stall timer expired — the very delay #402
  // set out to remove.
  test("a reused pid is dead, not running", () => {
    const m = marker(1_000, 4242, "8899001");
    expect(sweepLiveness(m, now, () => true, () => "9911002")).toBe("dead");
  });

  test("the same pid with the same start time is still running", () => {
    const m = marker(1_000, 4242, "8899001");
    expect(sweepLiveness(m, now, () => true, () => "8899001")).toBe("running");
  });

  // "Can't tell" must never read as "different". An unsupported platform, a
  // permission error or a racing exit all yield null, and stealing a live
  // sweep on that basis would double-file the drawers.
  test("an unavailable start token leaves the pid check in charge", () => {
    const m = marker(1_000, 4242, "8899001");
    expect(sweepLiveness(m, now, () => true, () => null)).toBe("running");
    expect(sweepLiveness(m, now, () => false, () => null)).toBe("dead");
  });

  // Markers from the first #403 build carry a pid but no pid_start. They
  // must not gain a start-time opinion retroactively.
  test("a marker with no pid_start never consults the probe", () => {
    let probed = false;
    const m = marker(1_000, 4242);
    const seen = sweepLiveness(m, now, () => true, () => {
      probed = true;
      return "whatever";
    });
    expect(seen).toBe("running");
    expect(probed).toBe(false);
  });
});

describe("processStartToken", () => {
  // Only meaningful where a probe exists. Every supported desktop platform
  // has one now: /proc on Linux, ps on macOS, Win32_Process.CreationDate on
  // Windows (a ticket written with NO pid_start could not survive a pid
  // recycle — see workspaceLock). Elsewhere null remains the contract.
  const supported =
    process.platform === "linux" ||
    process.platform === "darwin" ||
    process.platform === "win32";

  test("is stable across calls for this process", () => {
    const a = processStartToken(process.pid);
    const b = processStartToken(process.pid);
    expect(a).toBe(b);
    if (supported) expect(a).not.toBeNull();
  });

  test("returns null rather than throwing for a pid that cannot exist", () => {
    expect(processStartToken(-1)).toBeNull();
  });

  test("selfStartToken agrees with a direct probe of our own pid", () => {
    expect(selfStartToken()).toBe(processStartToken(process.pid));
  });
});

describe("isProcessAlive", () => {
  test("true for this very process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test("false for a pid that has exited", async () => {
    // Spawn bun itself rather than a shell: this suite also runs on Windows.
    const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"]);
    const pid = child.pid;
    await child.exited;
    expect(isProcessAlive(pid)).toBe(false);
  });

  // On POSIX pid 1 always exists and is not ours, so kill(2) answers EPERM —
  // "there, but not yours", which must still count as alive or we would take
  // over a sweep owned by another user. Windows has no equivalent pid.
  test.skipIf(process.platform === "win32")(
    "a pid we may not signal still counts as alive",
    () => {
      expect(isProcessAlive(1)).toBe(true);
    },
  );
});

describe("nightlyHealth", () => {
  const now = new Date("2026-05-10T09:00:00Z");

  test("nothing pending → ok", async () => {
    await daily("2026-05-01");
    await markProcessed("2026-05-01");
    const h = await nightlyHealth(workdir, { now });
    expect(h.status).toBe("ok");
    expect(h.backlog).toBe(0);
  });

  // Explicitly schedule-blind: a laptop asleep at 02:00 that swept on boot is
  // just as healthy as a server that swept on the timer. Backlog is the truth.
  test("a long-idle ledger with nothing pending is still ok", async () => {
    await saveNightlyState(workdir, {
      last_run: "2026-01-01T02:00:00Z",
      last_status: "ok",
    });
    expect((await nightlyHealth(workdir, { now })).status).toBe("ok");
  });

  test("pending dates → warning", async () => {
    await daily("2026-05-01");
    await daily("2026-05-02");
    const h = await nightlyHealth(workdir, { now });
    expect(h.status).toBe("warning");
    expect(h.backlog).toBe(2);
    expect(h.oldest_pending).toBe("2026-05-01");
    expect(h.detail).toContain("2 dates pending");
  });

  // Depth is not a fault: one sweep drains the whole queue, so a months-deep
  // backfill reads as work-in-progress, not as a broken nightly.
  test("a deep backlog is still only a warning while sweeps are running", async () => {
    for (let d = 1; d <= 20; d++) {
      await daily(`2026-04-${String(d).padStart(2, "0")}`);
    }
    await saveNightlyState(workdir, {
      last_run: new Date(now.getTime() - 60 * 60_000).toISOString(),
      last_status: "ok",
    });
    const h = await nightlyHealth(workdir, { now });
    expect(h.status).toBe("warning");
    expect(h.backlog).toBe(20);
  });

  // The real fault is a backlog nobody is picking up — the trigger is dead.
  test("pending dates with no sweep for over a day → error", async () => {
    await daily("2026-05-01");
    await saveNightlyState(workdir, {
      last_run: new Date(now.getTime() - BACKLOG_STAGNANT_MS - 60_000).toISOString(),
      last_status: "ok",
    });
    const h = await nightlyHealth(workdir, { now });
    expect(h.status).toBe("error");
    expect(h.detail).toContain("no sweep since");
  });

  // A fresh install has a backlog and no last_run; that is queued work, not a
  // stuck trigger — `run` stamps last_run within a minute of starting.
  test("a never-swept ledger with a backlog → warning, not error", async () => {
    for (let d = 1; d <= 12; d++) {
      await daily(`2026-04-${String(d).padStart(2, "0")}`);
    }
    const h = await nightlyHealth(workdir, { now });
    expect(h.status).toBe("warning");
  });

  // /status must separate the two failure modes: a dead owner is a crash to
  // investigate, a stalled one is a hung turn. A dead owner is also reportable
  // at once, instead of reading "running" for the first 45 minutes.
  test("a fresh marker whose owner is gone reports died, not running", async () => {
    await daily("2026-05-01");
    await saveNightlyState(workdir, {
      current: {
        date: "2026-05-01",
        index: 2,
        total: 9,
        started_at: new Date(now.getTime() - 10_000).toISOString(),
        updated_at: new Date(now.getTime() - 10_000).toISOString(),
        pid: 4242,
      },
    });
    const h = await nightlyHealth(workdir, { now, isAlive: () => false });
    expect(h.status).toBe("error");
    expect(h.detail).toContain("sweep died on 2026-05-01");
    expect(h.detail).toContain("4242");
  });

  test("an in-flight sweep with a fresh beat → running with progress", async () => {
    await daily("2026-05-01");
    await saveNightlyState(workdir, {
      current: {
        date: "2026-05-01",
        index: 2,
        total: 5,
        started_at: "2026-05-10T08:55:00Z",
        updated_at: "2026-05-10T08:59:00Z",
      },
    });
    const h = await nightlyHealth(workdir, { now });
    expect(h.status).toBe("running");
    expect(h.detail).toBe("2/5 dates, on 2026-05-01");
  });

  // A crashed sweep leaves its marker behind. Without staleness detection
  // /status would report RUNNING forever and the backlog would look attended.
  test("an in-flight marker older than STALE_RUN_MS → error", async () => {
    await daily("2026-05-01");
    await saveNightlyState(workdir, {
      current: {
        date: "2026-05-01",
        index: 1,
        total: 1,
        started_at: "2026-05-10T07:00:00Z",
        updated_at: new Date(now.getTime() - STALE_RUN_MS - 1000).toISOString(),
      },
    });
    const h = await nightlyHealth(workdir, { now });
    expect(h.status).toBe("error");
    expect(h.detail).toContain("stalled");
  });

  test("last sweep errored → error even with an empty backlog", async () => {
    const state: NightlyState = {
      last_run: "2026-05-10T02:00:00Z",
      last_status: "error",
      errors: ["stage 'kb' (2026-05-01): timed out"],
    };
    await saveNightlyState(workdir, state);
    const h = await nightlyHealth(workdir, { now });
    expect(h.status).toBe("error");
    expect(h.detail).toContain("timed out");
  });

  test("a date recorded partial → warning once its backlog is drained", async () => {
    // File processed with one stage failing, then reprocessed successfully is
    // the happy path; a lingering partial record with no pending work is the
    // "it finished, but not cleanly" state.
    await saveNightlyState(workdir, {
      last_status: "ok",
      processed: {
        "2026-05-01": {
          mtime_ms: 1,
          size: 1,
          hash: "a",
          stages_done: ["distill"],
          completed_at: "2026-05-02T02:00:00Z",
          status: "partial",
          error: "kb blew up",
        },
      },
    });
    expect((await nightlyHealth(workdir, { now })).status).toBe("warning");
  });
});

describe("buildNightlyStagePrompt", () => {
  test("there are exactly two stages: distill and kb", () => {
    expect([...NIGHTLY_STAGES]).toEqual(["distill", "kb"]);
  });

  test("embeds persona, date and the isolation note", () => {
    const p = buildNightlyStagePrompt("robbie", "2026-05-18", "distill");
    expect(p).toContain("persona 'robbie'");
    expect(p).toContain("system:nightly:2026-05-18");
  });

  // The daily file is the ledger's hash input. A stage that writes to it (the
  // old "day essence" header did) makes the date look changed forever, so the
  // pass would re-run that day on every single sweep.
  test("every stage is told never to write to the daily file", () => {
    for (const s of NIGHTLY_STAGES) {
      const p = buildNightlyStagePrompt("robbie", "2026-05-18", s);
      expect(p).toContain("NEVER write to memory/2026-05-18.md");
    }
  });

  // Index refresh is deterministic work; it now runs in code after the join.
  // Leaving it in the prompt would race the sibling stage's writes.
  test("no stage asks the model to run the index", () => {
    for (const s of NIGHTLY_STAGES) {
      const p = buildNightlyStagePrompt("robbie", "2026-05-18", s);
      expect(p).not.toContain("memory index --rebuild");
      expect(p).toContain("Do NOT run `phantombot memory index`");
    }
  });

  test("the stages declare disjoint write targets so they can run concurrently", () => {
    const distill = buildNightlyStagePrompt("robbie", "2026-05-18", "distill");
    const kb = buildNightlyStagePrompt("robbie", "2026-05-18", "kb");
    expect(distill).toContain("do not touch kb/");
    expect(kb).toContain("do not\ntouch memory/ files");
  });

  test("distill fills AND trims MEMORY.md, and files the drawers", () => {
    const p = buildNightlyStagePrompt("robbie", "2026-05-18", "distill");
    expect(p).toContain("memory/decisions.md");
    expect(p).toContain("memory/commitments.md");
    expect(p).toContain("FILL");
    expect(p).toContain("TRIM");
    expect(p).toContain("## Recent");
  });

  // The KB stage must RECONCILE, not append: a note that became wrong has to
  // stop being served as current truth while surviving as changelog history.
  test("kb instructs supersession, not just append", () => {
    const p = buildNightlyStagePrompt("robbie", "2026-05-18", "kb");
    expect(p).toContain("RECONCILE");
    expect(p).toMatch(/CONTRADICTS|INVALIDATES/);
    expect(p).toContain("## Changelog");
    expect(p).toContain("status: obsolete");
    expect(p).toContain("2026-05-18: was X → now Y");
  });

  // Without embeddings, recall is BM25 only: it can match a note only on words
  // the note literally contains. A single-phrase dedup search therefore misses
  // paraphrased coverage and the stage creates a duplicate — the one failure
  // mode that compounds, since each duplicate dilutes every later query.
  test("kb stage requires multi-angle dedup search", () => {
    const p = buildNightlyStagePrompt("robbie", "2026-05-18", "kb");
    expect(p).toContain("MORE THAN ONE ANGLE");
    expect(p).toMatch(/two or three times/);
  });

  test("kb stage requires the full OKF frontmatter set", () => {
    const p = buildNightlyStagePrompt("robbie", "2026-05-18", "kb");
    for (const field of [
      "type",
      "title",
      "description",
      "aliases",
      "tags",
      "created",
      "updated",
    ]) {
      expect(p).toContain(field);
    }
  });

  test("kb stage lists the controlled vocabulary from okf.ts", () => {
    const p = buildNightlyStagePrompt("robbie", "2026-05-18", "kb");
    for (const t of OKF_TYPES) {
      expect(p).toContain(t);
    }
    expect(p).toContain("Never invent a new type");
  });

  // On a no-embeddings install the link graph IS the semantic index: recall
  // expands outward from a lexical hit along [[wikilinks]]. An unlinked note
  // is reachable only by exact wording, so linking is a retrieval requirement
  // rather than a tidiness preference.
  test("kb stage requires new notes to be linked in", () => {
    const p = buildNightlyStagePrompt("robbie", "2026-05-18", "kb");
    expect(p).toContain("[[wikilinks]]");
    expect(p).toContain("nearest existing");
  });

  test("no stage mentions the removed day-essence header", () => {
    for (const s of NIGHTLY_STAGES) {
      expect(
        buildNightlyStagePrompt("robbie", "2026-05-18", s),
      ).not.toContain("Day essence");
    }
  });
});

describe("buildNightlyPromptForPersona — override", () => {
  test("falls back to the built-in monolithic prompt with both stages", async () => {
    const built = await buildNightlyPromptForPersona(
      workdir,
      "kai",
      "2026-05-02",
    );
    expect(built).toContain("persona 'kai'");
    expect(built).toContain("STAGE: DISTILL");
    expect(built).toContain("STAGE: KB");
  });

  test("uses the override file with {{persona}} / {{today}} substitution", async () => {
    await writeFile(
      join(workdir, "nightly-prompt.md"),
      "Hey {{persona}}, today is {{today}}. Do the thing.",
      "utf8",
    );
    expect(
      await buildNightlyPromptForPersona(workdir, "robbie", "2026-05-02"),
    ).toBe("Hey robbie, today is 2026-05-02. Do the thing.");
  });

  test("buildNightlyPrompt runs both stages in one turn", () => {
    const p = buildNightlyPrompt("robbie", "2026-05-18");
    expect(p).toContain("Run BOTH stages below");
  });
});
