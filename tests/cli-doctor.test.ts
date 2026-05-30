import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../src/cli/doctor.ts";
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
let config: Config;
let personaMemoryDir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-doctor-"));
  personaMemoryDir = join(workdir, "personas", "phantom", "memory");
  await mkdir(personaMemoryDir, { recursive: true });
  await writeFile(join(workdir, "personas", "phantom", "BOOT.md"), "# Phantom");
  config = {
    defaultPersona: "phantom",
    harnessIdleTimeoutMs: 600_000,
    harnessHardTimeoutMs: 600_000,
    personasDir: join(workdir, "personas"),
    memoryDbPath: join(workdir, "memory.sqlite"),
    configPath: join(workdir, "config.toml"),
    harnesses: {
      chain: ["claude"],
      claude: { bin: "claude", model: "opus", fallbackModel: "sonnet" },
      pi: { bin: "pi", maxPayloadBytes: 1_500_000 },
      gemini: { bin: "gemini", model: "" },
    },
    channels: {},
    embeddings: { provider: "none" },
    voice: { provider: "none" },
  };
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

async function writeState(obj: unknown): Promise<void> {
  await writeFile(
    join(personaMemoryDir, ".nightly-state.json"),
    JSON.stringify(obj),
    "utf8",
  );
}
async function writeProgress(obj: unknown): Promise<void> {
  await writeFile(
    join(personaMemoryDir, ".nightly-progress.json"),
    JSON.stringify(obj),
    "utf8",
  );
}

describe("runDoctor", () => {
  test("missing persona → exit 2", async () => {
    const err = new CaptureStream();
    const code = await runDoctor({
      config,
      persona: "nope",
      out: new CaptureStream(),
      err,
    });
    expect(code).toBe(2);
    expect(err.text).toContain("not found");
  });

  test("no nightly record → repair needed and spawned", async () => {
    const spawned: string[] = [];
    const out = new CaptureStream();
    const code = await runDoctor({
      config,
      out,
      spawnRepair: (p) => spawned.push(p),
    });
    expect(spawned).toEqual(["phantom"]);
    expect(out.text).toContain("never run");
    expect(code).toBe(0); // repair was triggered
  });

  test("fresh ok nightly → repair not needed", async () => {
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
    const spawned: string[] = [];
    const out = new CaptureStream();
    const code = await runDoctor({
      config,
      out,
      spawnRepair: (p) => spawned.push(p),
    });
    expect(spawned).toEqual([]);
    expect(code).toBe(0);
    expect(out.text).toContain("repair: not needed");
  });

  test("stale nightly (>24h) → repair needed", async () => {
    await writeState({
      last_run: new Date(Date.now() - 30 * 3_600_000).toISOString(),
      last_status: "ok",
    });
    const spawned: string[] = [];
    await runDoctor({ config, out: new CaptureStream(), spawnRepair: (p) => spawned.push(p) });
    expect(spawned).toEqual(["phantom"]);
  });

  test("partial checkpoint → repair needed, reason names the checkpoint", async () => {
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "partial",
    });
    await writeProgress({
      date: "2026-05-18",
      started_at: "x",
      updated_at: "x",
      completed_stages: ["essence", "promote"],
      status: "partial",
    });
    const spawned: string[] = [];
    const out = new CaptureStream();
    await runDoctor({ config, out, spawnRepair: (p) => spawned.push(p) });
    expect(spawned).toEqual(["phantom"]);
    expect(out.text).toContain("checkpoint");
    expect(out.text).toContain("2026-05-18");
  });

  test("no-repair mode reports but never spawns; exits 1 when repair needed", async () => {
    const spawned: string[] = [];
    const code = await runDoctor({
      config,
      repair: false,
      out: new CaptureStream(),
      spawnRepair: (p) => spawned.push(p),
    });
    expect(spawned).toEqual([]);
    expect(code).toBe(1);
  });

  test("json mode emits a parseable report", async () => {
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
    const out = new CaptureStream();
    await runDoctor({ config, json: true, out, spawnRepair: () => {} });
    const report = JSON.parse(out.text);
    expect(report.persona).toBe("phantom");
    expect(report.repair_needed).toBe(false);
    expect(report.capture).toBeDefined();
    expect(report.nightly.last_status).toBe("ok");
  });
});

describe("runDoctor systemd health check", () => {
  // Driven by the checkSystemd test seam so we don't depend on real
  // systemctl. The new check catches the broken-symlink class of bug
  // where timers look enabled but never fire — exactly the failure that
  // stranded all scheduled tasks on hz-phantombot in May 2026.

  test("reports a healthy systemd subsystem in the human summary", async () => {
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
    const out = new CaptureStream();
    const code = await runDoctor({
      config,
      out,
      checkSystemd: async () => ({
        missing_unit_files: [],
        drifted_unit_files: [],
        inactive_timers: [],
        repaired: false,
      }),
    });
    expect(code).toBe(0);
    expect(out.text).toContain(
      "systemd: ok — all unit files present and current, all timers active",
    );
  });

  test("reports missing unit files and inactive timers", async () => {
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
    const out = new CaptureStream();
    const code = await runDoctor({
      config,
      out,
      checkSystemd: async () => ({
        missing_unit_files: ["phantombot-tick.timer"],
        drifted_unit_files: [],
        inactive_timers: ["phantombot-tick.timer"],
        repaired: false,
      }),
    });
    // Nightly is healthy, but systemd has unrepaired damage → exit 1.
    expect(code).toBe(1);
    expect(out.text).toContain("systemd: WARN");
    expect(out.text).toContain("missing: phantombot-tick.timer");
    expect(out.text).toContain("inactive: phantombot-tick.timer");
    expect(out.text).toContain("run `phantombot install` to repair");
  });

  test("repaired=true tells the user no manual action is needed", async () => {
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
    const out = new CaptureStream();
    const code = await runDoctor({
      config,
      out,
      checkSystemd: async () => ({
        missing_unit_files: ["phantombot-tick.timer"],
        drifted_unit_files: [],
        inactive_timers: [],
        repaired: true,
      }),
    });
    // Damage was healed → exit 0, message tells user it's fixed.
    expect(code).toBe(0);
    expect(out.text).toContain("re-rendered units and re-armed timers");
  });

  test("checkSystemd=false omits the systemd section entirely", async () => {
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
    const out = new CaptureStream();
    await runDoctor({
      config,
      out,
      checkSystemd: false,
    });
    expect(out.text).not.toContain("systemd:");
  });

  test("json mode includes the systemd block when checked", async () => {
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
    const out = new CaptureStream();
    await runDoctor({
      config,
      json: true,
      out,
      checkSystemd: async () => ({
        missing_unit_files: [],
        drifted_unit_files: [],
        inactive_timers: ["phantombot-tick.timer"],
        repaired: false,
      }),
    });
    const report = JSON.parse(out.text);
    expect(report.systemd).toEqual({
      missing_unit_files: [],
      drifted_unit_files: [],
      inactive_timers: ["phantombot-tick.timer"],
      repaired: false,
    });
  });

  test("reports drifted unit files and exits 1 when unrepaired", async () => {
    // A unit file that exists and is "active" but whose content no longer
    // matches the binary's template (the pre-OnCalendar heartbeat timer that
    // an in-place update left behind). missing/inactive stay empty, so only
    // the drift signal catches it — the gap that made doctor say "ok" while
    // a wedge-prone timer sat on disk.
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
    const out = new CaptureStream();
    const code = await runDoctor({
      config,
      out,
      checkSystemd: async () => ({
        missing_unit_files: [],
        drifted_unit_files: ["phantombot-heartbeat.timer"],
        inactive_timers: [],
        repaired: false,
      }),
    });
    expect(code).toBe(1);
    expect(out.text).toContain("systemd: WARN");
    expect(out.text).toContain("drifted: phantombot-heartbeat.timer");
    expect(out.text).toContain("run `phantombot install` to repair");
  });

  test("drift healed in place → exit 0 and no manual action needed", async () => {
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
    const out = new CaptureStream();
    const code = await runDoctor({
      config,
      out,
      checkSystemd: async () => ({
        missing_unit_files: [],
        drifted_unit_files: ["phantombot-heartbeat.timer"],
        inactive_timers: [],
        repaired: true,
      }),
    });
    expect(code).toBe(0);
    expect(out.text).toContain("re-rendered units and re-armed timers");
  });
});

describe("runDoctor timer-fired staleness check", () => {
  // Driven by the checkTimers test seam so we don't read real marker
  // files. Catches the long-uptime failure mode where the timer is
  // "active" but hasn't actually fired in hours (bus drop, host
  // suspend, etc.) — the only signal is what tick + heartbeat wrote
  // to disk on their last successful fire.

  test("fresh heartbeat + tick markers pass with exit 0", async () => {
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
    const out = new CaptureStream();
    const code = await runDoctor({
      config,
      out,
      checkTimers: async () => ({
        heartbeat: {
          last_fired: "2026-05-20T08:55:00.000Z",
          age_minutes: 2,
          stale: false,
          threshold_minutes: 75,
        },
        tick: {
          last_fired: "2026-05-20T08:57:30.000Z",
          age_minutes: 0,
          stale: false,
          threshold_minutes: 5,
        },
      }),
    });
    expect(code).toBe(0);
    expect(out.text).toContain("heartbeat: ok");
    expect(out.text).toContain("tick: ok");
    expect(out.text).toContain("2m ago");
  });

  test("stale heartbeat → WARN + exit 1", async () => {
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
    const out = new CaptureStream();
    const code = await runDoctor({
      config,
      out,
      checkTimers: async () => ({
        heartbeat: {
          last_fired: "2026-05-20T05:00:00.000Z",
          age_minutes: 240,
          stale: true,
          threshold_minutes: 75,
        },
        tick: {
          last_fired: "2026-05-20T08:57:30.000Z",
          age_minutes: 0,
          stale: false,
          threshold_minutes: 5,
        },
      }),
    });
    expect(code).toBe(1);
    expect(out.text).toContain("heartbeat: WARN");
    expect(out.text).toContain("240m ago");
    expect(out.text).toContain("STALE");
    expect(out.text).toContain("tick: ok");
  });

  test("missing marker → reported as never recorded + stale", async () => {
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
    const out = new CaptureStream();
    const code = await runDoctor({
      config,
      out,
      checkTimers: async () => ({
        heartbeat: {
          stale: true,
          threshold_minutes: 75,
        },
        tick: {
          last_fired: "2026-05-20T08:57:30.000Z",
          age_minutes: 0,
          stale: false,
          threshold_minutes: 5,
        },
      }),
    });
    expect(code).toBe(1);
    expect(out.text).toContain("heartbeat: WARN — never recorded");
  });

  test("checkTimers=false omits the timer sections entirely", async () => {
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
    const out = new CaptureStream();
    await runDoctor({
      config,
      out,
      checkSystemd: false,
      checkTimers: false,
    });
    expect(out.text).not.toContain("heartbeat:");
    expect(out.text).not.toContain("tick:");
  });

  test("json mode emits the timers block when checked", async () => {
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
    const out = new CaptureStream();
    await runDoctor({
      config,
      json: true,
      out,
      checkSystemd: false,
      checkTimers: async () => ({
        heartbeat: {
          last_fired: "2026-05-20T08:55:00.000Z",
          age_minutes: 2,
          stale: false,
          threshold_minutes: 75,
        },
        tick: {
          last_fired: "2026-05-20T08:57:30.000Z",
          age_minutes: 0,
          stale: false,
          threshold_minutes: 5,
        },
      }),
    });
    const report = JSON.parse(out.text);
    expect(report.timers.heartbeat.age_minutes).toBe(2);
    expect(report.timers.tick.age_minutes).toBe(0);
    expect(report.timers.heartbeat.stale).toBe(false);
    expect(report.timers.tick.stale).toBe(false);
  });
});

describe("runDoctor zombie-timer re-arm wiring", () => {
  // A timer can sit in `active (elapsed)` — systemd's is-active says
  // "active" but it has stopped firing. is-active/missing-file checks
  // can't see this; only the last-fired marker can. These tests verify
  // that a stale marker drives the systemd heal step to force-re-arm the
  // corresponding timer (and that a never-fired marker does not).

  test("stale heartbeat marker → systemd heal force-re-arms that timer", async () => {
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
    let receivedStale: string[] | undefined;
    const out = new CaptureStream();
    const code = await runDoctor({
      config,
      out,
      checkSystemd: async (staleTimers) => {
        receivedStale = staleTimers;
        return {
          missing_unit_files: [],
          drifted_unit_files: [],
          inactive_timers: [],
          repaired: staleTimers.length > 0,
        };
      },
      checkTimers: async () => ({
        heartbeat: {
          last_fired: "2026-05-14T06:52:00.000Z",
          age_minutes: 11_520,
          stale: true,
          threshold_minutes: 75,
        },
        tick: {
          last_fired: "2026-05-20T08:57:30.000Z",
          age_minutes: 0,
          stale: false,
          threshold_minutes: 5,
        },
      }),
    });
    // The stale heartbeat (with a real last_fired) was passed down.
    expect(receivedStale).toEqual(["phantombot-heartbeat.timer"]);
    // Marker is still stale this run, so exit 1 (visibility) — the
    // re-arm fires a catch-up that refreshes the marker for next time.
    expect(code).toBe(1);
    // The systemd line acknowledges the re-arm even though no unit file
    // was missing or inactive.
    expect(out.text).toContain("(re-armed a stalled timer)");
  });

  test("never-fired marker (no last_fired) is NOT force-re-armed", async () => {
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
    let receivedStale: string[] | undefined;
    const out = new CaptureStream();
    await runDoctor({
      config,
      out,
      checkSystemd: async (staleTimers) => {
        receivedStale = staleTimers;
        return {
          missing_unit_files: [],
          drifted_unit_files: [],
          inactive_timers: [],
          repaired: false,
        };
      },
      checkTimers: async () => ({
        // Missing last_fired = fresh install, first fire imminent. Stale
        // but must not trigger a restart — the install/inactive checks
        // own that case.
        heartbeat: { stale: true, threshold_minutes: 75 },
        tick: { stale: true, threshold_minutes: 5 },
      }),
    });
    expect(receivedStale).toEqual([]);
  });

  test("stale tick marker → tick timer re-armed", async () => {
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
    let receivedStale: string[] | undefined;
    await runDoctor({
      config,
      out: new CaptureStream(),
      checkSystemd: async (staleTimers) => {
        receivedStale = staleTimers;
        return {
          missing_unit_files: [],
          drifted_unit_files: [],
          inactive_timers: [],
          repaired: staleTimers.length > 0,
        };
      },
      checkTimers: async () => ({
        heartbeat: {
          last_fired: "2026-05-20T08:55:00.000Z",
          age_minutes: 2,
          stale: false,
          threshold_minutes: 75,
        },
        tick: {
          last_fired: "2026-05-20T08:30:00.000Z",
          age_minutes: 27,
          stale: true,
          threshold_minutes: 5,
        },
      }),
    });
    expect(receivedStale).toEqual(["phantombot-tick.timer"]);
  });
});

describe("runDoctor embeddings status line", () => {
  // The embeddings line is purely informational: it tells the operator
  // whether semantic (vector) search is live, but absence is a valid,
  // fully-working config — so it must NEVER turn into a WARN or change
  // the exit code. These tests pin both the wording and that invariant.

  test("provider 'none' → neutral 'off' line, exit stays 0", async () => {
    // config fixture defaults to embeddings.provider = "none".
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
    const out = new CaptureStream();
    const code = await runDoctor({
      config,
      out,
      checkSystemd: false,
      checkTimers: false,
    });
    expect(code).toBe(0);
    expect(out.text).toContain(
      "embeddings: semantic (vector) search off — keyword (BM25) search active",
    );
    expect(out.text).toContain("phantombot embedding");
    // Crucially, NOT a WARN — the marker must never appear on this line.
    expect(out.text).not.toContain("embeddings: WARN");
  });

  test("gemini provider with key → 'ON' line", async () => {
    config.embeddings = {
      provider: "gemini",
      gemini: {
        apiKey: "AIzaTEST123",
        model: "gemini-embedding-001",
        dims: 1536,
      },
    };
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
    const out = new CaptureStream();
    const code = await runDoctor({
      config,
      out,
      checkSystemd: false,
      checkTimers: false,
    });
    expect(code).toBe(0);
    expect(out.text).toContain(
      "embeddings: semantic (vector) search ON — provider 'gemini'",
    );
  });

  test("gemini provider but EMPTY key → still reported off", async () => {
    // Provider says gemini but no usable key = keyword-only in practice.
    config.embeddings = {
      provider: "gemini",
      gemini: { apiKey: "", model: "gemini-embedding-001", dims: 1536 },
    };
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
    const out = new CaptureStream();
    await runDoctor({ config, out, checkSystemd: false, checkTimers: false });
    expect(out.text).toContain("semantic (vector) search off");
  });

  test("json mode includes the embeddings block", async () => {
    config.embeddings = {
      provider: "gemini",
      gemini: {
        apiKey: "AIzaTEST123",
        model: "gemini-embedding-001",
        dims: 1536,
      },
    };
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
    const out = new CaptureStream();
    await runDoctor({
      config,
      json: true,
      out,
      checkSystemd: false,
      checkTimers: false,
    });
    const report = JSON.parse(out.text);
    expect(report.embeddings).toEqual({
      provider: "gemini",
      semantic_search: true,
    });
  });
});
