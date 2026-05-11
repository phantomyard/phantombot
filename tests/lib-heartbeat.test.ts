/**
 * Tests for the heartbeat job (no LLM, no network).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkStaleness,
  extractRecentSection,
  promoteTaggedLines,
  runHeartbeat,
} from "../src/lib/heartbeat.ts";
import { MemoryIndex } from "../src/lib/memoryIndex.ts";

let workdir: string;
let personaDir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-hb-"));
  personaDir = join(workdir, "persona");
  await mkdir(join(personaDir, "memory"), { recursive: true });
  await mkdir(join(personaDir, "kb"), { recursive: true });
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

async function file(rel: string, content: string) {
  await writeFile(join(personaDir, rel), content);
}

describe("promoteTaggedLines", () => {
  test("appends [decision] / [lesson] / [person] / [commitment] lines to the right drawers", async () => {
    await file(
      "memory/2026-05-02.md",
      [
        "# 2026-05-02",
        "",
        "## 14:00",
        "[decision] Switched to deepseek for kai's heartbeat",
        "[lesson] Bun.spawn doesn't see runtime process.env mutations",
        "[person] Andrew prefers blunt > polished",
        "[commitment] Ship phase 26 today",
        "[unrelated] not a recognized tag — should be skipped",
      ].join("\n"),
    );
    // Empty drawer files (the scaffold would normally make them with placeholders)
    for (const d of ["decisions.md", "lessons.md", "people.md", "commitments.md"]) {
      await file(`memory/${d}`, `# ${d}\n\n## (no entries yet)\n`);
    }

    const r = await promoteTaggedLines(personaDir, "2026-05-02");
    const drawers = r.map((p) => p.drawer).sort();
    expect(drawers).toEqual([
      "memory/commitments.md",
      "memory/decisions.md",
      "memory/lessons.md",
      "memory/people.md",
    ]);

    const decisions = await readFile(
      join(personaDir, "memory/decisions.md"),
      "utf8",
    );
    expect(decisions).toContain("[decision] Switched to deepseek");
    expect(decisions).toContain("## 2026-05-02");
  });

  test("dedups against existing drawer content (no double-promotion)", async () => {
    await file(
      "memory/2026-05-02.md",
      "[decision] Use SQLite WAL for memory store",
    );
    await file(
      "memory/decisions.md",
      "# Decisions\n\n## 2026-05-02\n\n- [decision] Use SQLite WAL for memory store\n",
    );
    const r = await promoteTaggedLines(personaDir, "2026-05-02");
    expect(r).toEqual([]);
    const after = await readFile(
      join(personaDir, "memory/decisions.md"),
      "utf8",
    );
    // Still only one occurrence
    expect(
      after.match(/Use SQLite WAL for memory store/g)?.length,
    ).toBe(1);
  });

  test("returns [] when today's daily file is missing", async () => {
    expect(await promoteTaggedLines(personaDir, "2026-05-02")).toEqual([]);
  });

  test("ignores non-tag lines + unknown tags", async () => {
    await file(
      "memory/2026-05-02.md",
      "## morning\n\nplain text line\n[unknown] not a real tag\n",
    );
    expect(await promoteTaggedLines(personaDir, "2026-05-02")).toEqual([]);
  });
});

describe("extractRecentSection", () => {
  test("extracts the body between ## Recent and the next ## header", () => {
    const md = `# Memory

## Always

- I am Phantom

## Recent
- 2026-05-01 deployed phantombot
- 2026-05-02 fixed Pi parser

## Notes

- something else
`;
    const recent = extractRecentSection(md);
    expect(recent).toContain("2026-05-01 deployed");
    expect(recent).toContain("2026-05-02 fixed");
    expect(recent).not.toContain("something else");
    expect(recent).not.toContain("I am Phantom");
  });

  test("returns undefined if there's no ## Recent header", () => {
    expect(extractRecentSection("# nope\n\njust text\n")).toBeUndefined();
  });
});

describe("checkStaleness", () => {
  test("flags lines whose date is older than the threshold", async () => {
    await file(
      "MEMORY.md",
      `# memory

## Recent
- 2026-04-25 old item
- 2026-04-29 still old
- 2026-05-02 fresh
`,
    );
    const now = new Date("2026-05-02T10:00:00Z");
    const r = await checkStaleness(personaDir, now);
    expect(r).toHaveLength(2);
    expect(r[0]?.line).toContain("old item");
    expect(r[0]?.ageHours).toBeGreaterThan(48);
  });

  test("returns [] when MEMORY.md is missing", async () => {
    expect(await checkStaleness(personaDir, new Date())).toEqual([]);
  });

  test("returns [] when ## Recent is missing", async () => {
    await file("MEMORY.md", "# memory\n\nsome content\n");
    expect(await checkStaleness(personaDir, new Date())).toEqual([]);
  });
});

describe("runHeartbeat (integration)", () => {
  test("promotes + indexes + reports", async () => {
    await file(
      "memory/2026-05-02.md",
      "[decision] Promote me",
    );
    await file("memory/decisions.md", "# Decisions\n");
    await file(
      "MEMORY.md",
      `# memory

## Recent
- 2026-04-25 stale
- 2026-05-02 fresh
`,
    );
    await file("kb/Note.md", "indexable");
    const ix = await MemoryIndex.open(":memory:");
    const r = await runHeartbeat({
      personaDir,
      today: "2026-05-02",
      now: new Date("2026-05-02T10:00:00Z"),
      index: ix,
    });
    expect(r.promoted).toHaveLength(1);
    expect(r.staleRecent).toHaveLength(1);
    expect(r.indexedFiles).toBeGreaterThan(0);
    // Without config/currentVersion, the update check is skipped.
    expect(r.updateCheck).toBeUndefined();
    ix.close();
  });
});

// ---------------------------------------------------------------------------
// runHeartbeat — update-check hook
// ---------------------------------------------------------------------------

describe("runHeartbeat update check hook", () => {
  // Minimal config shape for the heartbeat — we only need telegram for the
  // notify-once flow to reach the send step.
  function configWithTelegram() {
    return {
      defaultPersona: "phantom",
      harnessIdleTimeoutMs: 1000,
      harnessHardTimeoutMs: 1000,
      personasDir: "/tmp",
      memoryDbPath: ":memory:",
      configPath: "/tmp/c.toml",
      harnesses: {
        chain: ["claude"],
        claude: { bin: "claude", model: "opus", fallbackModel: "sonnet" },
        pi: { bin: "pi", maxPayloadBytes: 1 },
        gemini: { bin: "gemini", model: "" },
      },
      channels: {
        telegram: {
          token: "fake-token",
          pollTimeoutS: 30,
          allowedUserIds: [42],
        },
      },
      embeddings: { provider: "none" as const },
      voice: { provider: "none" as const },
    };
  }

  // Minimal Telegram release fixture matching the linux-x64 asset
  // expected by checkAndNotifyOnce running on a Linux x64 host.
  function releaseFetch(tag: string): typeof fetch {
    const ASSET = `phantombot-${tag}-linux-x64`;
    const body = {
      tag_name: tag,
      body: "test",
      assets: [
        { name: ASSET, browser_download_url: "x", size: 1 },
        { name: "SHA256SUMS", browser_download_url: "x", size: 1 },
      ],
    };
    return (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("api.github.com")) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
  }

  test("with config + newer release → fires the update notification", async () => {
    // Skip the update check on non-linux-x64 hosts (the test would still
    // run on linux-arm64 if the fixture's asset name doesn't match).
    if (process.platform !== "linux" || process.arch !== "x64") {
      return;
    }
    let sent = 0;
    const transport = {
      async sendMessage() {
        sent++;
      },
      // Stubs to satisfy the TelegramTransport interface — none of these
      // are reached on the notify path used here.
      async getUpdates() {
        return { updates: [], nextOffset: 0 };
      },
      async sendTyping() {},
      async sendRecording() {},
      async sendVoice() {},
      async downloadFile() {
        return { data: Buffer.alloc(0), mime: "" };
      },
    };
    const lastNotifiedPath = join(workdir, "last-notified");
    const r = await runHeartbeat({
      personaDir,
      today: "2026-05-02",
      now: new Date("2026-05-02T10:00:00Z"),
      config: configWithTelegram(),
      currentVersion: "1.0.42",
      fetchImpl: releaseFetch("v1.0.99"),
      transport,
      lastNotifiedPath,
    });
    expect(r.updateCheck?.status).toBe("notified");
    expect(r.updateCheck?.latestVersion).toBe("1.0.99");
    expect(sent).toBe(1);
  });

  test("with config but already on latest → status already_current, no send", async () => {
    if (process.platform !== "linux" || process.arch !== "x64") return;
    let sent = 0;
    const transport = {
      async sendMessage() {
        sent++;
      },
      async getUpdates() {
        return { updates: [], nextOffset: 0 };
      },
      async sendTyping() {},
      async sendRecording() {},
      async sendVoice() {},
      async downloadFile() {
        return { data: Buffer.alloc(0), mime: "" };
      },
    };
    const r = await runHeartbeat({
      personaDir,
      today: "2026-05-02",
      now: new Date("2026-05-02T10:00:00Z"),
      config: configWithTelegram(),
      currentVersion: "1.0.99",
      fetchImpl: releaseFetch("v1.0.99"),
      transport,
      lastNotifiedPath: join(workdir, "last-notified"),
    });
    expect(r.updateCheck?.status).toBe("already_current");
    expect(sent).toBe(0);
  });

  test("github error in update check doesn't fail the heartbeat", async () => {
    const failingFetch = (async () => {
      throw new Error("ENETUNREACH");
    }) as unknown as typeof fetch;
    const r = await runHeartbeat({
      personaDir,
      today: "2026-05-02",
      now: new Date("2026-05-02T10:00:00Z"),
      config: configWithTelegram(),
      currentVersion: "1.0.42",
      fetchImpl: failingFetch,
      lastNotifiedPath: join(workdir, "last-notified"),
    });
    // The heartbeat itself succeeded — promotions/staleness/index work
    // happened. The update-check result records the failure but doesn't
    // bubble it up.
    expect(r.updateCheck?.status).toBe("release_check_failed");
    expect(r.ranAt).toBeDefined();
  });
});
