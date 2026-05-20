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
        inactive_timers: [],
        repaired: false,
      }),
    });
    expect(code).toBe(0);
    expect(out.text).toContain(
      "systemd: ok — all unit files present, all timers active",
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
        inactive_timers: ["phantombot-tick.timer"],
        repaired: false,
      }),
    });
    const report = JSON.parse(out.text);
    expect(report.systemd).toEqual({
      missing_unit_files: [],
      inactive_timers: ["phantombot-tick.timer"],
      repaired: false,
    });
  });
});
