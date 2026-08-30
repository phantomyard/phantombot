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
  config = {
    defaultPersona: "phantom",
    harnessIdleTimeoutMs: 600_000,
    harnessHardTimeoutMs: 600_000, harnessStartupTimeoutMs: 600_000,
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

async function writeState(obj: unknown): Promise<void> {
  await writeFile(
    join(personaMemoryDir, ".nightly-state.json"),
    JSON.stringify(obj),
    "utf8",
  );
}
/** Write a daily file the sweep will see as unprocessed. */
async function writeDaily(date: string): Promise<void> {
  await writeFile(
    join(personaMemoryDir, `${date}.md`),
    `notes for ${date}`,
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

  // Doctor no longer owns nightly repair: the nightly is idempotent and
  // sweeps whatever is pending on its own schedule (plus on startup). Doctor
  // reads the ledger and reports — one owner for the job, not two.
  test("nothing pending → nightly ok, exit 0", async () => {
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
    const out = new CaptureStream();
    const code = await runDoctor({ config, out });
    expect(code).toBe(0);
    expect(out.text).toMatch(/nightly: ok/);
    expect(out.text).toContain("nothing pending");
  });

  test("stated but incomplete Telegram account is WARN and exits 1", async () => {
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
    const out = new CaptureStream();
    const broken = {
      ...config,
      channels: { telegramStated: true },
    } satisfies Config;

    const code = await runDoctor({
      config: broken,
      out,
      checkSystemd: false,
      checkTimers: false,
      checkHarnesses: false,
      checkPiExtension: false,
      checkEditorConnectors: false,
    });

    expect(code).toBe(1);
    expect(out.text).toContain("telegram: WARN");
    expect(out.text).toContain("persona 'phantom': 0 listener(s)");
    expect(out.text).toContain("states an account but has no bot_token");
  });

  test("intentional PhantomChat-only persona is healthy and silent about missing Telegram", async () => {
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
      checkHarnesses: false,
      checkPiExtension: false,
      checkEditorConnectors: false,
    });

    expect(code).toBe(0);
    expect(out.text).toContain("telegram: ok");
    expect(out.text).toContain("persona 'phantom': 0 listener(s), not configured");
    expect(out.text).not.toContain("no bot_token");
  });

  test("a migrated default account is healthy despite its retained legacy statement", async () => {
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
    const out = new CaptureStream();
    const migrated = {
      ...config,
      channels: {
        telegram: { token: "default", pollTimeoutS: 30, allowedUserIds: [] },
        telegramStated: true,
        telegramPersonasStated: ["phantom"],
      },
    } satisfies Config;

    expect(await runDoctor({
      config: migrated,
      out,
      checkSystemd: false,
      checkTimers: false,
      checkHarnesses: false,
      checkPiExtension: false,
      checkEditorConnectors: false,
    })).toBe(0);
    expect(out.text).toContain("telegram: ok — 1 listener(s) across 1 persona(s)");
    expect(out.text).toContain("persona 'phantom': 1 listener(s), runnable");
    expect(out.text).not.toContain("no bot_token");
  });

  test("doctor reports every boot persona and catches an incomplete autostart bot", async () => {
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
    await mkdir(join(workdir, "personas", "lena"), { recursive: true });
    const out = new CaptureStream();
    const host = {
      ...config,
      autostartPersonas: ["lena"],
      channels: {
        telegram: { token: "default", pollTimeoutS: 30, allowedUserIds: [] },
        telegramStated: true,
      },
    } satisfies Config;
    const lena = {
      ...config,
      personaLayer: "lena",
      channels: { telegramStated: true },
    } satisfies Config;

    const code = await runDoctor({
      config: host,
      personaConfigs: new Map([["lena", lena]]),
      out,
      checkSystemd: false,
      checkTimers: false,
      checkHarnesses: false,
      checkPiExtension: false,
      checkEditorConnectors: false,
    });

    expect(code).toBe(1);
    expect(out.text).toContain("persona 'phantom': 1 listener(s)");
    expect(out.text).toContain("persona 'lena': 0 listener(s)");
  });

  test("a complete non-rostered account is reported as unplanned, not tokenless", async () => {
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
    await mkdir(join(workdir, "personas", "lena"), { recursive: true });
    const out = new CaptureStream();
    const lena = {
      ...config,
      personaLayer: "lena",
      channels: {
        telegram: { token: "lena", pollTimeoutS: 30, allowedUserIds: [] },
        telegramStated: true,
      },
    } satisfies Config;

    expect(await runDoctor({
      config,
      personaConfigs: new Map([["lena", lena]]),
      out,
      checkSystemd: false,
      checkTimers: false,
      checkHarnesses: false,
      checkPiExtension: false,
      checkEditorConnectors: false,
    })).toBe(1);
    expect(out.text).toContain("persona 'lena': 0 listener(s), account resolved but no listener is planned");
    expect(out.text).not.toContain("persona 'lena': 0 listener(s), states an account but has no bot_token");
  });

  // Backlog is the only truth — a box that slept through 02:00 and swept on
  // boot is healthy, however long ago that was.
  test("a long-idle sweep with an empty backlog is still ok", async () => {
    await writeState({
      last_run: new Date(Date.now() - 30 * 24 * 3_600_000).toISOString(),
      last_status: "ok",
    });
    const out = new CaptureStream();
    expect(await runDoctor({ config, out })).toBe(0);
    expect(out.text).toMatch(/nightly: ok/);
  });

  test("a small backlog → WARN, exit 0, and points at the next sweep", async () => {
    await writeDaily("2026-05-01");
    await writeDaily("2026-05-02");
    const out = new CaptureStream();
    const code = await runDoctor({ config, out });
    expect(code).toBe(0);
    expect(out.text).toMatch(/nightly: WARN/);
    expect(out.text).toContain("2 date(s) pending");
  });

  // Depth alone never fails doctor — a backfill is queued work, and one sweep
  // takes the whole queue.
  test("a large backlog is still WARN and exit 0", async () => {
    for (const d of ["01", "02", "03", "04", "05"]) {
      await writeDaily(`2026-05-${d}`);
    }
    await writeState({
      last_run: new Date(Date.now() - 60 * 60_000).toISOString(),
      last_status: "ok",
    });
    const out = new CaptureStream();
    const code = await runDoctor({ config, out });
    expect(code).toBe(0);
    expect(out.text).toMatch(/nightly: WARN/);
    expect(out.text).toContain("5 date(s) pending");
  });

  test("a backlog with no sweep for over a day → ERR and exit 1", async () => {
    await writeDaily("2026-05-01");
    await writeState({
      last_run: new Date(Date.now() - 30 * 60 * 60_000).toISOString(),
      last_status: "ok",
    });
    const out = new CaptureStream();
    const code = await runDoctor({ config, out });
    expect(code).toBe(1);
    expect(out.text).toMatch(/nightly: ERR/);
  });

  test("an in-flight sweep is reported as RUNNING with progress", async () => {
    const now = new Date().toISOString();
    await writeState({
      last_run: now,
      last_status: "ok",
      current: {
        date: "2026-05-02",
        index: 2,
        total: 5,
        started_at: now,
        updated_at: now,
      },
    });
    const out = new CaptureStream();
    expect(await runDoctor({ config, out })).toBe(0);
    expect(out.text).toContain("nightly: RUNNING — 2/5 dates, on 2026-05-02");
  });

  test("surfaces the nightly errors array (human + json)", async () => {
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "error",
      errors: ["stage 'kb' (2026-05-01): pi exited with code 127"],
    });
    const out = new CaptureStream();
    await runDoctor({ config, out });
    expect(out.text).toContain("pi exited with code 127");
    expect(out.text).toMatch(/nightly: ERR/);

    const jsonOut = new CaptureStream();
    await runDoctor({ config, json: true, out: jsonOut });
    const report = JSON.parse(jsonOut.text);
    expect(report.nightly.errors).toEqual([
      "stage 'kb' (2026-05-01): pi exited with code 127",
    ]);
    expect(report.nightly.health).toBe("error");
  });

  test("omits the errors field when the last sweep was clean", async () => {
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
    const out = new CaptureStream();
    await runDoctor({ config, json: true, out });
    expect(JSON.parse(out.text).nightly.errors).toBeUndefined();
  });

  test("reports the release ring so a preview bug report is interpretable", async () => {
    // A config with no updateChannel is a pre-#432 host: it followed
    // /releases/latest, which IS the stable ring, so that is what doctor
    // must say — not "unknown".
    const out = new CaptureStream();
    await runDoctor({ config, json: true, out });
    const report = JSON.parse(out.text);
    expect(report.update.channel).toBe("stable");
    expect(report.update.version).toBeTypeOf("string");

    const human = new CaptureStream();
    await runDoctor({ config, out: human });
    expect(human.text).toContain("stable channel");
    expect(human.text).toContain("installs only promoted releases");
  });

  test("a preview host says so, and says where the setting lives", async () => {
    const previewConfig = { ...config, updateChannel: "preview" as const };
    const out = new CaptureStream();
    const code = await runDoctor({ config: previewConfig, out });
    // Informational only — a ring is a choice, never a health failure.
    expect(code).toBe(0);
    expect(out.text).toContain("preview channel");
    expect(out.text).toContain("every merge to main");
    expect(out.text).toContain("update_channel");
  });

  test("json mode emits a parseable report with ledger-derived health", async () => {
    await writeDaily("2026-05-01");
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
    const out = new CaptureStream();
    await runDoctor({ config, json: true, out });
    const report = JSON.parse(out.text);
    expect(report.persona).toBe("phantom");
    expect(report.capture).toBeDefined();
    expect(report.nightly.health).toBe("warning");
    expect(report.nightly.backlog).toBe(1);
    expect(report.nightly.oldest_pending).toBe("2026-05-01");
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
    // The stale heartbeat (with a real last_fired) was passed down — as
    // the DEFAULT persona's instance unit (#486).
    expect(receivedStale).toEqual(["phantombot-heartbeat@phantom.timer"]);
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
      "embeddings: semantic (vector) search off — OKF field-weighted BM25 " +
        "+ link-graph expansion active",
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

describe("runDoctor harness availability", () => {
  test("reports missing configured harness binaries and exits 1", async () => {
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
      checkHarnesses: async () => ({
        path: "/service/path",
        checks: [{ id: "pi", bin: "pi" }],
      }),
    });
    expect(code).toBe(1);
    expect(out.text).toContain("harnesses: WARN");
    expect(out.text).toContain("pi: 'pi' not found");
    expect(out.text).toContain("PHANTOMBOT_<HARNESS>_BIN");
  });

  test("json mode includes harness checks", async () => {
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
    const out = new CaptureStream();
    const code = await runDoctor({
      config,
      json: true,
      out,
      checkSystemd: false,
      checkTimers: false,
      checkHarnesses: async () => ({
        path: "/service/path",
        checks: [{ id: "claude", bin: "claude", resolved: "/bin/claude" }],
      }),
    });
    expect(code).toBe(0);
    const report = JSON.parse(out.text);
    expect(report.harnesses).toEqual({
      path: "/service/path",
      checks: [{ id: "claude", bin: "claude", resolved: "/bin/claude" }],
    });
  });

  test("json mode exits 1 when a configured harness is missing", async () => {
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
    const out = new CaptureStream();
    const code = await runDoctor({
      config,
      json: true,
      out,
      checkSystemd: false,
      checkTimers: false,
      checkHarnesses: async () => ({
        path: "/service/path",
        checks: [{ id: "pi", bin: "pi" }],
      }),
    });
    expect(code).toBe(1);
    expect(JSON.parse(out.text).harnesses.checks[0].resolved).toBeUndefined();
  });
});

describe("runDoctor pi extension health check", () => {
  // Nightly is healthy in every case here, so the exit code is driven solely
  // by the managed Pi capability-routing extension report.
  beforeEach(async () => {
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
  });

  const isolate = {
    checkSystemd: false as const,
    checkTimers: false as const,
    checkHarnesses: false as const,
  };

  test("drifted + not repaired (--no-repair) → WARN and exit 1", async () => {
    const out = new CaptureStream();
    const code = await runDoctor({
      config,
      out,
      repair: false,
      ...isolate,
      checkPiExtension: async () => ({
        shouldExist: true,
        present: false,
        drifted: true,
        dir: "/home/x/.pi/agent/extensions/capability-routing",
      }),
    });
    // Unrepaired drift is a health failure, same class as systemd/harness.
    expect(code).toBe(1);
    expect(out.text).toContain("pi extension: WARN");
  });

  test("drifted but repaired this run → ok and exit 0", async () => {
    const out = new CaptureStream();
    const code = await runDoctor({
      config,
      out,
      ...isolate,
      checkPiExtension: async () => ({
        shouldExist: true,
        present: true,
        drifted: true,
        dir: "/home/x/.pi/agent/extensions/capability-routing",
        repaired: true,
      }),
    });
    expect(code).toBe(0);
    expect(out.text).toContain("pi extension: ok");
  });

  test("healthy extension (present, no drift) → exit 0", async () => {
    const out = new CaptureStream();
    const code = await runDoctor({
      config,
      out,
      ...isolate,
      checkPiExtension: async () => ({
        shouldExist: true,
        present: true,
        drifted: false,
        dir: "/home/x/.pi/agent/extensions/capability-routing",
      }),
    });
    expect(code).toBe(0);
  });

  test("stale dir present but no capability, --no-repair → WARN and exit 1", async () => {
    const out = new CaptureStream();
    const code = await runDoctor({
      config,
      out,
      repair: false,
      ...isolate,
      checkPiExtension: async () => ({
        shouldExist: false,
        present: true,
        drifted: true,
        dir: "/home/x/.pi/agent/extensions/capability-routing",
      }),
    });
    expect(code).toBe(1);
    expect(out.text).toContain("pi extension: WARN");
  });
});

describe("runDoctor — editor connectors", () => {
  beforeEach(async () => {
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
  });

  const isolate = {
    checkSystemd: false as const,
    checkTimers: false as const,
    checkHarnesses: false as const,
    checkPiExtension: false as const,
  };

  test("editor not installed → ok and exit 0", async () => {
    const out = new CaptureStream();
    const code = await runDoctor({
      config,
      out,
      ...isolate,
      checkEditorConnectors: () => [
        { editor: "zed", action: "not-detected", settingsPath: "/x/zed" },
      ],
    });
    expect(code).toBe(0);
    expect(out.text).toContain("editor (zed): ok");
    expect(out.text).toContain("not installed");
  });

  test("already current → ok and exit 0", async () => {
    const out = new CaptureStream();
    const code = await runDoctor({
      config,
      out,
      ...isolate,
      checkEditorConnectors: () => [
        { editor: "zed", action: "current", settingsPath: "/x/zed" },
      ],
    });
    expect(code).toBe(0);
    expect(out.text).toContain("editor (zed): ok");
  });

  test("registered this run → ok and exit 0", async () => {
    const out = new CaptureStream();
    const code = await runDoctor({
      config,
      out,
      ...isolate,
      checkEditorConnectors: () => [
        { editor: "zed", action: "registered", settingsPath: "/x/zed" },
      ],
    });
    expect(code).toBe(0);
    expect(out.text).toContain("registered phantombot");
  });

  test("stale under --no-repair → WARN and exit 1", async () => {
    const out = new CaptureStream();
    const code = await runDoctor({
      config,
      out,
      repair: false,
      ...isolate,
      checkEditorConnectors: (repair) => {
        // doctor must pass repair through so report-only mode reports drift.
        expect(repair).toBe(false);
        return [{ editor: "zed", action: "stale", settingsPath: "/x/zed" }];
      },
    });
    expect(code).toBe(1);
    expect(out.text).toContain("editor (zed): WARN");
  });

  test("unparseable settings (error) → WARN and exit 1", async () => {
    const out = new CaptureStream();
    const code = await runDoctor({
      config,
      out,
      ...isolate,
      checkEditorConnectors: () => [
        {
          editor: "zed",
          action: "error",
          settingsPath: "/x/zed",
          error: "settings file not parseable as JSONC — left untouched",
        },
      ],
    });
    expect(code).toBe(1);
    expect(out.text).toContain("editor (zed): WARN");
    expect(out.text).toContain("not parseable");
  });
});

describe("runDoctor — memory database (#417)", () => {
  test("a corrupt memory database is exit 1, with the recovery command", async () => {
    // The drawers live here now, so this is the most serious thing doctor can
    // find: every other check is about a process, this one is about the data.
    await writeState({ last_run: new Date().toISOString(), last_status: "ok" });
    await writeFile(config.memoryDbPath, "not a database", "utf8");
    // A restore point taken while it was healthy.
    const { mkdir: mk } = await import("node:fs/promises");
    await mk(join(workdir, "backups"), { recursive: true });
    const point = join(workdir, "memory.20260821T000000Z.sqlite");
    const { Database } = await import("bun:sqlite");
    const db = new Database(join(workdir, "backups", "memory.20260821T000000Z.sqlite"), { create: true });
    db.exec("CREATE TABLE t (v TEXT)");
    db.close();
    void point;

    const out = new CaptureStream();
    expect(await runDoctor({ config, out, checkEditorConnectors: false })).toBe(1);
    expect(out.text).toMatch(/memory db: WARN/);
    expect(out.text).toContain("phantombot memory restore --from");
  });

  test("a healthy database with no restore points is ok, and says so", async () => {
    // NOT a failure: a box installed this afternoon has none yet, and crying
    // WARN there teaches the operator to ignore the line that matters.
    await writeState({ last_run: new Date().toISOString(), last_status: "ok" });
    const { Database } = await import("bun:sqlite");
    const db = new Database(config.memoryDbPath, { create: true });
    db.exec("CREATE TABLE t (v TEXT)");
    db.close();

    const out = new CaptureStream();
    expect(await runDoctor({ config, out, checkEditorConnectors: false })).toBe(0);
    expect(out.text).toMatch(/memory db: ok/);
    expect(out.text).toContain("no restore points yet");
  });

  test("a markdown drawer still on disk is surfaced, not silently ignored", async () => {
    await writeState({ last_run: new Date().toISOString(), last_status: "ok" });
    const { Database } = await import("bun:sqlite");
    const db = new Database(config.memoryDbPath, { create: true });
    db.exec("CREATE TABLE t (v TEXT)");
    db.close();
    await writeFile(join(personaMemoryDir, "norms.md"), "# Norms\n", "utf8");

    const out = new CaptureStream();
    await runDoctor({ config, out, checkEditorConnectors: false });
    expect(out.text).toContain("memory/norms.md");
    expect(out.text).toContain("--retire");
  });
  describe("service logs (#428)", () => {
    async function logDir(): Promise<string> {
      const d = join(workdir, "logs");
      await mkdir(d, { recursive: true });
      return d;
    }

    test("reports size and flags a log over the cap", async () => {
      const d = await logDir();
      await writeFile(join(d, "tick.out.log"), "x".repeat(2048));
      await writeFile(join(d, "tick.out.log.1"), "x".repeat(1024));
      process.env.PHANTOMBOT_LOG_MAX_BYTES = "1000";
      const out = new CaptureStream();

      const code = await runDoctor({ config, out, serviceLogDir: d });

      delete process.env.PHANTOMBOT_LOG_MAX_BYTES;
      expect(code).toBe(0);
      expect(out.text).toContain("service logs:");
      // Rotated generations count toward the footprint …
      expect(out.text).toContain("0 MB in ");
      // … but only the live log is named as a rotation candidate.
      expect(out.text).toContain("over cap: tick.out.log");
      expect(out.text).not.toContain("tick.out.log.1");
    });

    test("no over-cap log → no over-cap list", async () => {
      const d = await logDir();
      await writeFile(join(d, "tick.out.log"), "x".repeat(10));
      const out = new CaptureStream();

      expect(await runDoctor({ config, out, serviceLogDir: d })).toBe(0);
      expect(out.text).toContain("service logs:");
      expect(out.text).not.toContain("over cap");
    });

    test("a platform with no file logs omits the section entirely", async () => {
      const out = new CaptureStream();
      expect(await runDoctor({ config, out, serviceLogDir: null })).toBe(0);
      expect(out.text).not.toContain("service logs:");
    });

    test("json report carries the same numbers", async () => {
      const d = await logDir();
      await writeFile(join(d, "tick.out.log"), "x".repeat(2048));
      process.env.PHANTOMBOT_LOG_MAX_BYTES = "1000";
      const out = new CaptureStream();

      await runDoctor({ config, out, json: true, serviceLogDir: d });

      delete process.env.PHANTOMBOT_LOG_MAX_BYTES;
      const report = JSON.parse(out.text);
      expect(report.service_logs.dir).toBe(d);
      expect(report.service_logs.bytes).toBe(2048);
      expect(report.service_logs.max_bytes).toBe(1000);
      expect(report.service_logs.over_cap).toEqual(["tick.out.log"]);
    });
  });
});

describe("runDoctor per-persona maintenance coverage (#486)", () => {
  test("renders the per-persona section, warns on a stale persona, exit stays 0", async () => {
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
      checkMaintenance: async () => [
        {
          persona: "phantom",
          last_heartbeat: new Date().toISOString(),
          heartbeat_age_minutes: 4,
          heartbeat_stale: false,
          nightly_backlog: 0,
        },
        {
          persona: "kai",
          heartbeat_stale: true,
          nightly_backlog: 3,
          nightly_oldest_pending: "2026-08-26",
        },
      ],
    });
    // Warn-only: a persona behind on maintenance never fails doctor.
    expect(code).toBe(0);
    expect(out.text).toContain("maintenance per persona:");
    expect(out.text).toContain("phantom: ok");
    expect(out.text).toContain("kai: WARN — heartbeat never fired");
    expect(out.text).toContain("nightly 3 date(s) pending (oldest 2026-08-26)");
    expect(out.text).toContain("phantombot-heartbeat@<persona>.timer");
  });

  test("a stale non-default persona drives a force-re-arm of ITS instance", async () => {
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
          repaired: true,
        };
      },
      checkTimers: false,
      checkMaintenance: async () => [
        {
          persona: "phantom",
          last_heartbeat: new Date().toISOString(),
          heartbeat_age_minutes: 4,
          heartbeat_stale: false,
          nightly_backlog: 0,
        },
        {
          persona: "kai",
          last_heartbeat: "2026-05-14T06:52:00.000Z",
          heartbeat_age_minutes: 11_520,
          heartbeat_stale: true,
          nightly_backlog: 0,
        },
      ],
    });
    expect(receivedStale).toEqual(["phantombot-heartbeat@kai.timer"]);
  });

  test("checkMaintenance=false omits the section", async () => {
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
      checkMaintenance: false,
    });
    expect(out.text).not.toContain("maintenance per persona:");
  });

  test("json mode emits the maintenance block", async () => {
    await writeState({
      last_run: new Date().toISOString(),
      last_status: "ok",
    });
    const out = new CaptureStream();
    await runDoctor({
      config,
      out,
      json: true,
      checkSystemd: false,
      checkTimers: false,
      checkMaintenance: async () => [
        {
          persona: "kai",
          heartbeat_stale: true,
          nightly_backlog: 2,
          nightly_oldest_pending: "2026-08-27",
        },
      ],
    });
    const report = JSON.parse(out.text);
    expect(report.maintenance).toEqual([
      {
        persona: "kai",
        heartbeat_stale: true,
        nightly_backlog: 2,
        nightly_oldest_pending: "2026-08-27",
      },
    ]);
  });
});

describe("runDoctor — the host default persona (#505)", () => {
  const SAVED_STATE = process.env.PHANTOMBOT_STATE;
  beforeEach(() => {
    // Hermetic: provenance reads state.json, and the real one must not leak in.
    process.env.PHANTOMBOT_STATE = join(workdir, "state.json");
  });
  afterEach(() => {
    if (SAVED_STATE === undefined) delete process.env.PHANTOMBOT_STATE;
    else process.env.PHANTOMBOT_STATE = SAVED_STATE;
  });

  test("names the resolved default, its provenance, and stays exit 0", async () => {
    await writeState({ last_run: new Date().toISOString(), last_status: "ok" });
    await writeFile(
      join(workdir, "state.json"),
      JSON.stringify({ default_persona: "phantom" }),
      "utf8",
    );
    const out = new CaptureStream();
    const code = await runDoctor({
      config,
      out,
      checkSystemd: false,
      checkTimers: false,
      checkMaintenance: false,
    });
    expect(code).toBe(0);
    expect(out.text).toContain("default persona: ok — 'phantom' (from state.json)");
    // The lever operators reach for first is the one that loses.
    expect(out.text).toContain("state.json OUTRANKS config.toml");
  });

  test("an empty MCP registry next to a populated sibling WARNs, but never fails", async () => {
    // The exact shape of a migrated-away default: the dir is still here, so
    // every persona-scoped read succeeds against the wrong, empty persona.
    await writeState({ last_run: new Date().toISOString(), last_status: "ok" });
    await mkdir(join(workdir, "personas", "kai"), { recursive: true });
    await writeFile(
      join(workdir, "personas", "kai", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          mailspring: { transport: "http", url: "http://127.0.0.1:2587" },
        },
      }),
      "utf8",
    );
    const out = new CaptureStream();
    const code = await runDoctor({
      config,
      out,
      checkSystemd: false,
      checkTimers: false,
      checkMaintenance: false,
    });
    // Warn-only: plenty of hosts legitimately register no MCP servers.
    expect(code).toBe(0);
    expect(out.text).toContain("default persona: WARN");
    expect(out.text).toContain("no MCP servers registered while kai has some");
  });

  test("a default whose dir is gone fails doctor", async () => {
    await writeState({ last_run: new Date().toISOString(), last_status: "ok" });
    const out = new CaptureStream();
    const code = await runDoctor({
      config: { ...config, defaultPersona: "ghost" },
      persona: "phantom",
      out,
      checkSystemd: false,
      checkTimers: false,
      checkMaintenance: false,
    });
    expect(code).toBe(1);
    expect(out.text).toContain("NOT usable: no persona dir on disk");
  });

  test("json mode carries the whole default-persona block", async () => {
    await writeState({ last_run: new Date().toISOString(), last_status: "ok" });
    const out = new CaptureStream();
    await runDoctor({
      config,
      out,
      json: true,
      checkSystemd: false,
      checkTimers: false,
      checkMaintenance: false,
    });
    const report = JSON.parse(out.text);
    expect(report.default_persona.resolved).toBe("phantom");
    expect(report.default_persona.exists).toBe(true);
    expect(report.default_persona.served).toBe(true);
    expect(report.default_persona.defect).toBeNull();
    expect(report.default_persona.provenance).toBe("builtin");
  });
});
