/**
 * The Doctor screen's checklist (Andrew, 2026-09-12).
 *
 * Reported: Telegram looked like a legacy check sitting on its own in the
 * doctor menu. It was not legacy — it was the only channel check the SCREEN
 * rendered. `runDoctor` computes a dozen more (systemd, timers, per-persona
 * maintenance, harness binaries, the Pi extension, ACP editors, MCP servers,
 * embeddings, service logs) and the screen dropped every one, so it could
 * paint four green ticks on a box whose doctor exit code was non-zero.
 *
 * These tests assert what lands ON SCREEN and what `doctorChecklist` returns
 * for a given report — never that a branch ran. The broken build's defect was
 * precisely that all its branches ran correctly on a report it then ignored.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { render } from "ink";

import { DoctorScreen } from "../src/tui/screens/Doctor.tsx";
import { TerminalSizeContext } from "../src/tui/terminal.ts";
import {
  checklistVerdict,
  doctorChecklist,
} from "../src/tui/doctorChecklist.ts";
import type { DoctorReport } from "../src/cli/doctor.ts";

/** A fully healthy report for a Linux box with every optional section present. */
function healthyReport(): DoctorReport {
  return {
    persona: "alice",
    telegram: {
      healthy: true,
      listeners: 2,
      personas: [
        { persona: "alice", stated: true, listeners: 1, healthy: true, detail: "runnable" },
        { persona: "bob", stated: true, listeners: 1, healthy: true, detail: "runnable" },
      ],
    },
    phantomchat: {
      healthy: true,
      listeners: 2,
      personas: [
        {
          persona: "alice",
          stated: true,
          npub: "npub1alice",
          relays: 3,
          allowed: 1,
          tofu: false,
          listener: true,
          healthy: true,
          detail: "runnable on 3 relay(s), 1 allowed sender(s)",
        },
        {
          persona: "bob",
          stated: true,
          npub: "npub1bob",
          relays: 3,
          allowed: 2,
          tofu: false,
          listener: true,
          healthy: true,
          detail: "runnable on 3 relay(s), 2 allowed sender(s)",
        },
      ],
    },
    vault: {
      healthy: true,
      personas: [
        {
          persona: "alice",
          present: true,
          identity: true,
          secrets: 7,
          undecryptable: [],
          healthy: true,
          detail: "7 secret(s) readable",
        },
      ],
    },
    nightly: { age_hours: 2, health: "ok", detail: "no backlog", backlog: 0 },
    memory_db: {
      path: "/x/memory.sqlite",
      healthy: true,
      detail: "integrity ok",
      bytes: 44040192,
      restore_points: [{ taken_at: "2026-09-11T02:00:00Z", bytes: 1, path: "/x/1" }],
      unretired_drawers: [],
    },
    capture: { window_hours: 24, user_turns: 10, captures: 9, dry_day: false },
    embeddings: { provider: "openai-compatible", semantic_search: true },
    update: { channel: "stable", version: "1.1.359" },
    systemd: {
      missing_unit_files: [],
      drifted_unit_files: [],
      inactive_timers: [],
      repaired: false,
    },
    timers: {
      heartbeat: { last_fired: "t", age_minutes: 4, stale: false, threshold_minutes: 45 },
      tick: { last_fired: "t", age_minutes: 1, stale: false, threshold_minutes: 10 },
    },
    maintenance: [
      { persona: "alice", heartbeat_stale: false, nightly_backlog: 0, heartbeat_age_minutes: 4 },
      { persona: "bob", heartbeat_stale: false, nightly_backlog: 0, heartbeat_age_minutes: 6 },
    ],
    default_persona: {
      resolved: "alice",
      provenance: "state",
      exists: true,
      served: true,
      defect: null,
      mcp_servers: 3,
      mcp_elsewhere: [],
      healthy: true,
      detail: "resolved from state.json",
    },
    harnesses: {
      path: "/usr/bin",
      checks: [{ id: "claude", bin: "claude", resolved: "/usr/bin/claude" }],
    },
    piExtension: { shouldExist: true, present: true, drifted: false, dir: "/x/.pi" },
    editorConnectors: [
      { editor: "zed", action: "current", settingsPath: "/x/zed.json" },
      { editor: "vscode", action: "current", settingsPath: "/x/vscode", proposedApi: "enabled" },
    ],
  };
}

const flat = (r: DoctorReport) => doctorChecklist(r).flatMap((s) => s.items);
const item = (r: DoctorReport, label: string) =>
  flat(r).find((i) => i.label === label);

describe("doctorChecklist", () => {
  test("a healthy box is all green and every check is one line", () => {
    const r = healthyReport();
    const items = flat(r);
    expect(items.every((i) => i.state === "ok")).toBe(true);
    // Rule 3: a hint is the "what to do" row, and there is nothing to do.
    expect(items.some((i) => i.hint)) .toBe(false);
    expect(checklistVerdict(doctorChecklist(r))).toBe("ok");
  });

  test("a green check NEVER carries a hint, on any report", () => {
    // The screen renders a hint whenever one is present, with no second
    // state check — so this invariant is what keeps a healthy box one line
    // per check. Asserted across degraded reports, not just the healthy one,
    // or it only pins a report that has no hints to begin with.
    const degraded: Array<(r: DoctorReport) => void> = [
      (r) => void (r.memory_db.healthy = false),
      (r) => void (r.capture.dry_day = true),
      (r) => void (r.nightly.health = "error"),
      (r) => void (r.nightly.backlog = 3),
      (r) => void (r.telegram.healthy = false),
      (r) => void (r.embeddings = { provider: "gemini", semantic_search: false }),
      (r) => void (r.timers!.tick.stale = true),
      (r) => void (r.systemd!.inactive_timers = ["phantombot-tick.timer"]),
      (r) => void (r.maintenance![0]!.heartbeat_stale = true),
      (r) => void (r.default_persona.healthy = false),
      (r) => void (r.harnesses!.checks = [{ id: "pi", bin: "pi" }]),
      (r) => void (r.piExtension!.drifted = true),
      (r) => void (r.default_persona.mcp_error = "bad JSON"),
      (r) => void (r.memory_db.unretired_drawers = ["people.md"]),
      (r) =>
        void (r.editorConnectors = [
          { editor: "zed", action: "error", settingsPath: "/x", error: "nope" },
        ]),
    ];
    for (const breakIt of degraded) {
      const r = healthyReport();
      breakIt(r);
      const items = flat(r);
      // The mutation has to actually degrade something, or this proves nothing.
      expect(items.some((i) => i.state !== "ok")).toBe(true);
      for (const i of items)
        if (i.state === "ok") expect(i.hint).toBeUndefined();
    }
  });

  test("every section the report computes reaches the checklist", () => {
    // The regression this whole change exists to prevent: a report section
    // that no one renders. Named explicitly rather than counted, so ADDING a
    // check to the report and forgetting the screen fails here.
    const labels = flat(healthyReport()).map((i) => i.label);
    for (const expected of [
      "memory database",
      "nightly sweep",
      "capture",
      "heartbeat timer",
      "tick timer",
      "systemd units",
      "persona maintenance",
      "default persona",
      "release ring",
      "telegram",
      "phantomchat",
      "secrets vault",
      "embeddings",
      "harness binaries",
      "mcp servers",
      "pi extension",
      "acp: zed",
      "acp: vscode",
    ])
      expect(labels).toContain(expected);
  });

  test("telegram is kept, not removed — and it keeps its per-persona detail", () => {
    const r = healthyReport();
    r.telegram.healthy = false;
    r.telegram.personas[1] = {
      persona: "bob",
      stated: true,
      listeners: 0,
      healthy: false,
      detail: "account resolved but no listener is planned",
    };
    const telegram = item(r, "telegram")!;
    expect(telegram.state).toBe("bad");
    expect(telegram.hint).toContain("bob");
    expect(telegram.hint).toContain("no listener is planned");
  });

  test("an unconfigured channel is green, not yellow — and stays quiet", () => {
    // The distinction that makes yellow worth having: a phantom that does not
    // use Telegram is not a degraded phantom. If "not configured" were yellow
    // every Telegram-less host would carry a permanent warning, and an
    // operator who learns yellow means nothing stops reading red too. Yellow
    // in CHANNELS is for a channel that IS configured and is failing.
    const r = healthyReport();
    r.telegram = { healthy: true, listeners: 0, personas: [] };
    const telegram = item(r, "telegram")!;
    expect(telegram.state).toBe("ok");
    expect(telegram.detail).toBe("not configured");
    // Rule 3: health is quiet. A green row carries no "what to do" line.
    expect(telegram.hint).toBeUndefined();
  });

  test("phantomchat gets the same treatment telegram does", () => {
    // Telegram read as legacy because it was ALONE, so the fix is only real
    // if its sibling is rendered to the same standard.
    const r = healthyReport();
    r.phantomchat.healthy = false;
    r.phantomchat.listeners = 1;
    r.phantomchat.personas[1] = {
      persona: "bob",
      stated: true,
      relays: 0,
      allowed: 0,
      tofu: false,
      listener: false,
      healthy: false,
      detail: "configured but not in autostart_personas — no listener is started",
    };
    const pc = item(r, "phantomchat")!;
    expect(pc.state).toBe("bad");
    expect(pc.hint).toContain("bob");
    expect(pc.hint).toContain("autostart_personas");
  });

  test("a persona that does not use phantomchat is green and quiet", () => {
    const r = healthyReport();
    r.phantomchat = { healthy: true, listeners: 0, personas: [] };
    const pc = item(r, "phantomchat")!;
    expect(pc.state).toBe("ok");
    expect(pc.detail).toBe("not configured");
    expect(pc.hint).toBeUndefined();
  });

  test("a vault that will not decrypt is red and names the persona", () => {
    const r = healthyReport();
    r.vault = {
      healthy: false,
      personas: [
        {
          persona: "alice",
          present: true,
          identity: false,
          secrets: 0,
          undecryptable: [],
          healthy: false,
          detail: "vault.sqlite present but identity.json is missing",
        },
      ],
    };
    const vault = item(r, "secrets vault")!;
    expect(vault.state).toBe("bad");
    expect(vault.hint).toContain("alice");
    expect(vault.hint).toContain("identity.json");
  });

  test("a box with no vault yet is green, not a warning", () => {
    const r = healthyReport();
    r.vault = {
      healthy: true,
      personas: [
        {
          persona: "alice",
          present: false,
          identity: true,
          secrets: 0,
          undecryptable: [],
          healthy: true,
          detail: "no vault yet",
        },
      ],
    };
    const vault = item(r, "secrets vault")!;
    expect(vault.state).toBe("ok");
    expect(vault.detail).toBe("no vault yet");
    expect(vault.hint).toBeUndefined();
  });

  test("a repaired fault says what was healed, not just green", () => {
    // Doctor repairs as well as reports. A self-healed unit rendered as plain
    // green loses the fact that something was broken.
    const r = healthyReport();
    r.systemd = {
      missing_unit_files: ["phantombot-tick.timer"],
      drifted_unit_files: [],
      inactive_timers: [],
      repaired: true,
    };
    const units = item(r, "systemd units")!;
    expect(units.state).toBe("warn");
    expect(units.hint).toContain("phantombot-tick.timer");
    expect(units.detail).toContain("repaired");
  });

  test("an unrepaired systemd fault is red, not yellow", () => {
    const r = healthyReport();
    r.systemd = {
      missing_unit_files: ["phantombot-tick.timer"],
      drifted_unit_files: [],
      inactive_timers: [],
      repaired: false,
    };
    expect(item(r, "systemd units")!.state).toBe("bad");
  });

  test("a configured-but-unusable embeddings provider says the key is the likely cause", () => {
    // The #516/#522 failure: a revoked key silently degrades search to
    // keyword-only, and the old screen did not mention embeddings at all.
    const r = healthyReport();
    r.embeddings = { provider: "openai-compatible", semantic_search: false };
    const e = item(r, "embeddings")!;
    expect(e.state).toBe("warn");
    expect(e.hint).toContain("revoked");
  });

  test("no embeddings provider at all is optional, not a degraded one", () => {
    const r = healthyReport();
    r.embeddings = { provider: "none", semantic_search: false };
    const e = item(r, "embeddings")!;
    expect(e.state).toBe("warn");
    expect(e.hint).toContain("optional");
    expect(e.hint).not.toContain("revoked");
  });

  test("maintenance collapses to one line when current, expands per persona when not", () => {
    const r = healthyReport();
    expect(item(r, "persona maintenance")!.detail).toBe("2 personas current");
    r.maintenance![1] = {
      persona: "bob",
      heartbeat_stale: true,
      nightly_backlog: 0,
    };
    expect(item(r, "persona maintenance")).toBeUndefined();
    const bob = item(r, "maintenance: bob")!;
    expect(bob.state).toBe("warn");
    expect(bob.hint).toContain("phantombot-heartbeat@bob.timer");
  });

  test("an MCP registry that does not load is red; an empty one is only odd next to a full one", () => {
    const r = healthyReport();
    r.default_persona.mcp_servers = 0;
    expect(item(r, "mcp servers")!.state).toBe("ok");
    r.default_persona.mcp_elsewhere = ["bob"];
    expect(item(r, "mcp servers")!.state).toBe("warn");
    r.default_persona.mcp_error = "mcp.json does not load: bad JSON";
    expect(item(r, "mcp servers")!.state).toBe("bad");
  });

  test("an editor that is not installed is green, not a warning on every headless box", () => {
    const r = healthyReport();
    r.editorConnectors = [
      { editor: "zed", action: "not-detected", settingsPath: "/x/zed.json" },
    ];
    const zed = item(r, "acp: zed")!;
    expect(zed.state).toBe("ok");
    expect(zed.detail).toContain("not installed");
  });

  test("a VS Code extension that is installed but not allow-listed is red, as the CLI counts it", () => {
    // `editorConnectorBroken` is the authority for BOTH the exit code and this
    // colour. A proposed-api allow-list miss degrades the extension to the
    // `@phantombot` participant, and doctor already exits non-zero on it — a
    // screen that painted that yellow would disagree with its own exit code.
    const r = healthyReport();
    r.editorConnectors = [
      {
        editor: "vscode",
        action: "current",
        settingsPath: "/x/vscode",
        proposedApi: "stale",
      },
    ];
    const code = item(r, "acp: vscode")!;
    expect(code.state).toBe("bad");
    expect(code.hint).toContain("argv.json");
  });

  test("sections with nothing in them are dropped, not left as empty headings", () => {
    // macOS has no systemd, a headless box no editors. A heading over nothing
    // reads as a check that failed to run.
    const r = healthyReport();
    delete r.systemd;
    delete r.timers;
    delete r.maintenance;
    delete r.harnesses;
    delete r.piExtension;
    delete r.editorConnectors;
    const sections = doctorChecklist(r);
    expect(sections.map((s) => s.title)).toEqual([
      "CORE",
      "CHANNELS",
      "INTEGRATIONS",
    ]);
    expect(sections.every((s) => s.items.length > 0)).toBe(true);
  });

  test("the verdict is the worst state anywhere, so the header cannot claim health", () => {
    const r = healthyReport();
    expect(checklistVerdict(doctorChecklist(r))).toBe("ok");
    r.capture.dry_day = true;
    expect(checklistVerdict(doctorChecklist(r))).toBe("warn");
    r.memory_db.healthy = false;
    expect(checklistVerdict(doctorChecklist(r))).toBe("bad");
  });
});

// ---------------------------------------------------------------------------
// And the paint, because a checklist that is correct and off-screen is the bug
// this replaced.
// ---------------------------------------------------------------------------

function fakeStdin() {
  const s = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: () => void;
    ref: () => void;
    unref: () => void;
  };
  s.isTTY = true;
  s.setRawMode = () => {};
  s.ref = () => {};
  s.unref = () => {};
  return s;
}

function fakeStdout(rows = 60) {
  const frames: string[] = [];
  const s = new EventEmitter() as EventEmitter & {
    columns: number;
    rows: number;
    write: (c: string) => void;
    frames: string[];
  };
  s.columns = 110;
  s.rows = rows;
  s.frames = frames;
  s.write = (c: string) => void frames.push(c);
  return s;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mountDoctor(report: DoctorReport, rows = 60) {
  const stdin = fakeStdin();
  const stdout = fakeStdout(rows);
  const instance = render(
    // The size comes from the ROOT's context in the real app (terminal.ts is
    // the only place allowed to measure), so a standalone mount has to supply
    // it or every screen lays out against the 24-row fallback.
    <TerminalSizeContext.Provider value={{ rows, columns: 110 }}>
      <DoctorScreen
        report={report}
        running={false}
        onRerun={() => {}}
        onBack={() => {}}
      />
    </TerminalSizeContext.Provider>,
    {
      stdin: stdin as never,
      stdout: stdout as never,
      debug: true,
      exitOnCtrlC: false,
    },
  );
  await sleep(60);
  return {
    frame: () => stdout.frames.at(-1) ?? "",
    press: async (bytes: string) => {
      stdin.write(bytes);
      await sleep(60);
    },
    unmount: () => instance.unmount(),
  };
}

describe("the doctor screen", () => {
  test("renders the grouped checklist, not four checks out of sixteen", async () => {
    const app = await mountDoctor(healthyReport());
    const frame = app.frame();
    expect(frame).toContain("CORE");
    expect(frame).toContain("CHANNELS");
    expect(frame).toContain("INTEGRATIONS");
    expect(frame).toContain("telegram");
    expect(frame).toContain("acp: vscode");
    expect(frame).toContain("mcp servers");
    expect(frame).toContain("harness binaries");
    // Green means quiet: no hint rows anywhere on a healthy box.
    expect(frame).not.toContain("→");
    expect(frame).toContain("healthy");
    app.unmount();
  });

  test("a failing check gets its hint row and the header stops saying healthy", async () => {
    const r = healthyReport();
    r.memory_db.healthy = false;
    r.memory_db.detail = "integrity_check: malformed";
    const app = await mountDoctor(r);
    const frame = app.frame();
    expect(frame).toContain("memory database");
    expect(frame).toContain("→");
    expect(frame).toContain("no verified snapshot");
    expect(frame).toContain("needs attention");
    expect(frame).not.toContain("✔ healthy");
    app.unmount();
  });

  test("a report taller than the window scrolls instead of overwriting rows", async () => {
    // Yoga shrinks children to fit rather than clipping, so a too-tall body
    // paints rows on top of each other (see scroll.ts). The marker is the
    // proof the window is doing its job.
    const app = await mountDoctor(healthyReport(), 16);
    // The MARKER alone proves nothing — it is computed from the row count, so
    // it shows even if every row is still painted. The evidence is that the
    // rows past the window are genuinely absent, and that scrolling trades
    // one end for the other.
    expect(app.frame()).toContain("memory database");
    expect(app.frame()).not.toContain("acp: vscode");
    expect(app.frame()).toContain("more below");

    for (let i = 0; i < 12; i++) await app.press("\x1b[B");
    expect(app.frame()).toContain("acp: vscode");
    expect(app.frame()).not.toContain("memory database");
    expect(app.frame()).toContain("more above");
    app.unmount();
  });
});
