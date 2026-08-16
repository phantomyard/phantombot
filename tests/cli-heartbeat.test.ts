import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rmrf } from "./fixtures/rmrf.ts";
import { runHeartbeatCli } from "../src/cli/heartbeat.ts";
import type { Config } from "../src/config.ts";
import { heartbeatMarkerPath } from "../src/lib/timerHealth.ts";

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

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-hbcli-"));
  await mkdir(join(workdir, "personas", "phantom", "memory"), {
    recursive: true,
  });
  await mkdir(join(workdir, "personas", "phantom", "kb"), {
    recursive: true,
  });
  process.env.XDG_DATA_HOME = workdir;
  // Redirect the timer-fired marker path so heartbeat writes into the
  // test workdir, not the developer's real ~/.local/state/.
  process.env.XDG_STATE_HOME = workdir;
  config = {
    defaultPersona: "phantom",
    harnessIdleTimeoutMs: 600_000, harnessHardTimeoutMs: 600_000, harnessStartupTimeoutMs: 600_000,
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
  await rmrf(workdir);
});

/**
 * Write the heartbeat's last-fired marker with an explicit timestamp, so a
 * test can model "the previous fire was yesterday" without waiting a day.
 * Same format `recordHeartbeatFired` writes.
 */
async function writeMarker(at: Date): Promise<void> {
  const p = heartbeatMarkerPath();
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, `ISO=${at.toISOString()} runs=1\n`, "utf8");
}

describe("runHeartbeatCli", () => {
  test("happy path returns 0 and prints summary", async () => {
    await writeFile(
      join(workdir, "personas", "phantom", "memory", `${new Date().toISOString().slice(0, 10)}.md`),
      "[decision] something\n",
    );
    await writeFile(
      join(workdir, "personas", "phantom", "memory", "decisions.md"),
      "# Decisions\n",
    );
    const out = new CaptureStream();
    const code = await runHeartbeatCli({
      config,
      out,
      err: new CaptureStream(),
    });
    expect(code).toBe(0);
    expect(out.text).toContain("heartbeat ok:");
    expect(out.text).toContain("promoted 1");
  });

  test("missing persona → exit 2", async () => {
    const err = new CaptureStream();
    const code = await runHeartbeatCli({
      config,
      persona: "doesnotexist",
      out: new CaptureStream(),
      err,
    });
    expect(code).toBe(2);
    expect(err.text).toContain("not found");
  });

  test("happy path records a fire-marker for the doctor staleness check", async () => {
    await writeFile(
      join(workdir, "personas", "phantom", "memory", "decisions.md"),
      "# Decisions\n",
    );
    const code = await runHeartbeatCli({
      config,
      out: new CaptureStream(),
      err: new CaptureStream(),
      // Skip the real systemd self-heal — we're testing the marker write.
      healSystemd: false,
    });
    expect(code).toBe(0);
    expect(existsSync(heartbeatMarkerPath())).toBe(true);
  });

  test("healSystemd seam runs after the heartbeat body", async () => {
    let healCalled = false;
    await runHeartbeatCli({
      config,
      out: new CaptureStream(),
      err: new CaptureStream(),
      healSystemd: async () => {
        healCalled = true;
      },
    });
    expect(healCalled).toBe(true);
  });

  test("healSystemd throwing does not break the heartbeat", async () => {
    const out = new CaptureStream();
    const code = await runHeartbeatCli({
      config,
      out,
      err: new CaptureStream(),
      healSystemd: async () => {
        throw new Error("systemctl exploded");
      },
    });
    // Primary work still completes and exit is 0; the heal failure is logged but swallowed.
    expect(code).toBe(0);
    expect(out.text).toContain("heartbeat ok");
  });

  test("a day boundary since the last fire spawns the nightly sweep", async () => {
    // This is the replacement for the 02:00 timer: the heartbeat sees that the
    // previous fire was recorded on an earlier calendar day, which means
    // yesterday's daily file has closed, and fires a detached sweep.
    await writeMarker(new Date(Date.now() - 36 * 3_600_000));
    const spawned: Array<[string, string]> = [];
    const out = new CaptureStream();
    const code = await runHeartbeatCli({
      config,
      out,
      err: new CaptureStream(),
      healSystemd: false,
      embedNotes: false,
      triggerNightly: (persona, reason) => spawned.push([persona, reason]),
    });
    expect(code).toBe(0);
    expect(spawned).toEqual([["phantom", "rollover"]]);
    expect(out.text).toContain("day rolled over");
  });

  test("a fire earlier the same day does not spawn a sweep", async () => {
    await writeMarker(new Date());
    const spawned: string[] = [];
    const out = new CaptureStream();
    const code = await runHeartbeatCli({
      config,
      out,
      err: new CaptureStream(),
      healSystemd: false,
      embedNotes: false,
      triggerNightly: (persona) => spawned.push(persona),
    });
    expect(code).toBe(0);
    expect(spawned).toEqual([]);
    expect(out.text).not.toContain("day rolled over");
  });

  test("first-ever heartbeat (no marker) does not spawn a sweep", async () => {
    // `run` already fires a startup sweep; guessing here would double up.
    const spawned: string[] = [];
    const code = await runHeartbeatCli({
      config,
      out: new CaptureStream(),
      err: new CaptureStream(),
      healSystemd: false,
      embedNotes: false,
      triggerNightly: (persona) => spawned.push(persona),
    });
    expect(code).toBe(0);
    expect(spawned).toEqual([]);
  });

  test("a spawn failure does not break the heartbeat", async () => {
    await writeMarker(new Date(Date.now() - 36 * 3_600_000));
    const out = new CaptureStream();
    const code = await runHeartbeatCli({
      config,
      out,
      err: new CaptureStream(),
      healSystemd: false,
      embedNotes: false,
      triggerNightly: () => {
        throw new Error("fork failed");
      },
    });
    expect(code).toBe(0);
    expect(out.text).toContain("heartbeat ok");
  });

  test("embedNotes seam result appends the embedded count to the summary", async () => {
    await writeFile(
      join(workdir, "personas", "phantom", "memory", "decisions.md"),
      "# Decisions\n",
    );
    const out = new CaptureStream();
    const code = await runHeartbeatCli({
      config,
      out,
      err: new CaptureStream(),
      healSystemd: false,
      embedNotes: async () => ({ embedded: 3, skipped: 7, failed: 0 }),
    });
    expect(code).toBe(0);
    expect(out.text).toContain("embedded 3");
  });

  test("embedNotes seam with nothing to embed prints no embed line", async () => {
    await writeFile(
      join(workdir, "personas", "phantom", "memory", "decisions.md"),
      "# Decisions\n",
    );
    const out = new CaptureStream();
    const code = await runHeartbeatCli({
      config,
      out,
      err: new CaptureStream(),
      healSystemd: false,
      embedNotes: async () => ({ embedded: 0, skipped: 12, failed: 0 }),
    });
    expect(code).toBe(0);
    expect(out.text).not.toContain("embedded");
  });

  test("embedNotes returning null (no embedder) prints no embed line", async () => {
    await writeFile(
      join(workdir, "personas", "phantom", "memory", "decisions.md"),
      "# Decisions\n",
    );
    const out = new CaptureStream();
    const code = await runHeartbeatCli({
      config,
      out,
      err: new CaptureStream(),
      healSystemd: false,
      embedNotes: async () => null,
    });
    expect(code).toBe(0);
    expect(out.text).not.toContain("embedded");
  });

  test("embedNotes throwing does not break the heartbeat", async () => {
    await writeFile(
      join(workdir, "personas", "phantom", "memory", "decisions.md"),
      "# Decisions\n",
    );
    const out = new CaptureStream();
    const code = await runHeartbeatCli({
      config,
      out,
      err: new CaptureStream(),
      healSystemd: false,
      embedNotes: async () => {
        throw new Error("gemini exploded");
      },
    });
    // Embed failure is logged but swallowed; primary work still completes.
    expect(code).toBe(0);
    expect(out.text).toContain("heartbeat ok");
  });

  test("embedNotes: false skips the pass and still completes cleanly", async () => {
    await writeFile(
      join(workdir, "personas", "phantom", "memory", "decisions.md"),
      "# Decisions\n",
    );
    const out = new CaptureStream();
    const code = await runHeartbeatCli({
      config,
      out,
      err: new CaptureStream(),
      healSystemd: false,
      // `false` short-circuits the pass entirely — the primary heartbeat
      // work still runs and no embed line is printed.
      embedNotes: false,
    });
    expect(code).toBe(0);
    expect(out.text).toContain("heartbeat ok");
    expect(out.text).not.toContain("embedded");
  });
});
