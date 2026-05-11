/**
 * Unit tests for the slash command dispatcher (src/channels/commands.ts).
 *
 * The dispatcher is pure-ish: it reads the supplied context and mutates
 * what's passed in (memory store, harness chain, AbortController).
 * These tests exercise each command with stub contexts — no Telegram, no
 * subprocesses. End-to-end "/stop kills a hung Gemini turn" lives in
 * channels-telegram.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  handleSlashCommand,
  nominalContextWindow,
  type ActiveTurnHandle,
  type SlashCommandContext,
} from "../src/channels/commands.ts";
import type { Harness, HarnessChunk, HarnessRequest } from "../src/harnesses/types.ts";
import { openMemoryStore, type MemoryStore } from "../src/memory/store.ts";

class StubHarness implements Harness {
  constructor(
    public readonly id: string,
    private readonly _available: boolean = true,
  ) {}
  async available(): Promise<boolean> {
    return this._available;
  }
  async *invoke(_req: HarnessRequest): AsyncGenerator<HarnessChunk> {
    yield { type: "done", finalText: "" };
  }
}

let memory: MemoryStore;
beforeEach(async () => {
  memory = await openMemoryStore(":memory:");
});
afterEach(async () => {
  await memory.close();
});

function ctx(
  overrides: Partial<SlashCommandContext> = {},
): SlashCommandContext {
  return {
    chatId: 42,
    persona: "phantom",
    conversation: "telegram:42",
    memory,
    harnesses: [new StubHarness("claude"), new StubHarness("pi")],
    startedAt: Date.now() - 65_000, // ~1m 5s of fake uptime
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Recognition + parsing
// ---------------------------------------------------------------------------

describe("handleSlashCommand recognition", () => {
  test("returns null for non-slash text — caller falls through to LLM", async () => {
    const r = await handleSlashCommand("hello there", ctx());
    expect(r).toBeNull();
  });

  test("returns null for unknown slash commands so personas can handle them", async () => {
    const r = await handleSlashCommand("/remember the milk", ctx());
    expect(r).toBeNull();
  });

  test("strips @BotName suffix (Telegram group convention)", async () => {
    const r = await handleSlashCommand("/help@PhantomBot", ctx());
    expect(r).not.toBeNull();
    expect(r!.reply).toContain("/stop");
  });

  test("is case-insensitive on the command itself", async () => {
    const r = await handleSlashCommand("/HELP", ctx());
    expect(r).not.toBeNull();
    expect(r!.reply).toContain("/stop");
  });

  test("tolerates leading/trailing whitespace", async () => {
    const r = await handleSlashCommand("   /help   ", ctx());
    expect(r).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// /stop
// ---------------------------------------------------------------------------

describe("/stop", () => {
  test("aborts the active turn's controller", async () => {
    const controller = new AbortController();
    const handle: ActiveTurnHandle = {
      controller,
      startTime: Date.now() - 1500,
    };
    const r = await handleSlashCommand("/stop", ctx({ activeTurn: handle }));
    expect(controller.signal.aborted).toBe(true);
    expect(r!.reply).toContain("stopped");
    // Includes the elapsed time so the user knows what got killed.
    expect(r!.reply).toMatch(/\d+\.\d+s/);
  });

  test("with no active turn replies politely instead of aborting nothing", async () => {
    const r = await handleSlashCommand("/stop", ctx());
    expect(r!.reply).toContain("no active turn");
  });
});

// ---------------------------------------------------------------------------
// /reset
// ---------------------------------------------------------------------------

describe("/reset", () => {
  test("deletes turns for the active conversation only", async () => {
    // Seed two conversations under the same persona.
    await memory.appendTurn({
      persona: "phantom",
      conversation: "telegram:42",
      role: "user",
      text: "a",
    });
    await memory.appendTurn({
      persona: "phantom",
      conversation: "telegram:42",
      role: "assistant",
      text: "b",
    });
    await memory.appendTurn({
      persona: "phantom",
      conversation: "telegram:99",
      role: "user",
      text: "should survive",
    });

    const r = await handleSlashCommand("/reset", ctx());
    expect(r!.reply).toContain("2 turns");

    expect(await memory.recentTurns("phantom", "telegram:42", 10)).toEqual([]);
    expect(await memory.recentTurns("phantom", "telegram:99", 10)).toEqual([
      { role: "user", text: "should survive" },
    ]);
  });

  test("reports zero gracefully when there's nothing to clear", async () => {
    const r = await handleSlashCommand("/reset", ctx());
    expect(r!.reply).toContain("0 turns");
  });

  test("singular noun for exactly one turn deleted", async () => {
    await memory.appendTurn({
      persona: "phantom",
      conversation: "telegram:42",
      role: "user",
      text: "lonely",
    });
    const r = await handleSlashCommand("/reset", ctx());
    expect(r!.reply).toContain("1 turn ");
    expect(r!.reply).not.toContain("1 turns");
  });

  test("aborts an in-flight turn so the post-reset persist doesn't refill the cleared conversation", async () => {
    const controller = new AbortController();
    const handle: ActiveTurnHandle = {
      controller,
      startTime: Date.now() - 2_500,
    };
    const r = await handleSlashCommand("/reset", ctx({ activeTurn: handle }));
    expect(controller.signal.aborted).toBe(true);
    // Reply mentions the in-flight stop so the user knows the reset
    // really did clean up everything, not just the persisted history.
    expect(r!.reply).toMatch(/stopped an in-flight turn that was \d+\.\ds in/);
  });

  test("no in-flight mention when there's no active turn", async () => {
    const r = await handleSlashCommand("/reset", ctx());
    expect(r!.reply).not.toContain("in-flight");
  });
});

// ---------------------------------------------------------------------------
// /status
// ---------------------------------------------------------------------------

describe("/status", () => {
  test("reports primary harness, chain, uptime, context %, and active state", async () => {
    await memory.appendTurn({
      persona: "phantom",
      conversation: "telegram:42",
      role: "user",
      text: "x".repeat(400), // ~100 tokens at 4 chars/token
    });
    const r = await handleSlashCommand("/status", ctx());
    expect(r!.reply).toContain("harness: claude");
    expect(r!.reply).toContain("claude → pi");
    expect(r!.reply).toMatch(/uptime:\s+1m \d+s/);
    expect(r!.reply).toContain("context:");
    expect(r!.reply).toContain("active:  no");
  });

  test("shows active turn elapsed time when one is running", async () => {
    const controller = new AbortController();
    const handle: ActiveTurnHandle = {
      controller,
      startTime: Date.now() - 800,
    };
    const r = await handleSlashCommand(
      "/status",
      ctx({ activeTurn: handle }),
    );
    expect(r!.reply).toMatch(/active:\s+yes \(\d+\.\d+s\)/);
    // No 'running:' line when no progress note has been captured.
    expect(r!.reply).not.toContain("running:");
  });

  test("includes 'running:' line with last progress note when present", async () => {
    const controller = new AbortController();
    const handle: ActiveTurnHandle = {
      controller,
      startTime: Date.now() - 1500,
      lastProgressNote: "tool_execution_start: BashTool",
    };
    const r = await handleSlashCommand(
      "/status",
      ctx({ activeTurn: handle }),
    );
    expect(r!.reply).toContain("running: tool_execution_start: BashTool");
  });

  test("truncates very long progress notes to keep /status readable", async () => {
    const longNote = "a".repeat(500);
    const handle: ActiveTurnHandle = {
      controller: new AbortController(),
      startTime: Date.now(),
      lastProgressNote: longNote,
    };
    const r = await handleSlashCommand(
      "/status",
      ctx({ activeTurn: handle }),
    );
    expect(r!.reply).toContain("running:");
    expect(r!.reply).toContain("…");
    // Must not embed the entire 500-char note.
    expect(r!.reply.length).toBeLessThan(longNote.length);
  });

  test("uptime formatter handles seconds, minutes, hours, days", async () => {
    const cases: Array<[number, RegExp]> = [
      [Date.now() - 5_000, /uptime:\s+5s/],
      [Date.now() - 65_000, /uptime:\s+1m 5s/],
      [Date.now() - (3_600_000 + 120_000), /uptime:\s+1h 2m/],
      [Date.now() - 3 * 24 * 3_600_000 - 4 * 3_600_000, /uptime:\s+3d 4h/],
    ];
    for (const [startedAt, re] of cases) {
      const r = await handleSlashCommand("/status", ctx({ startedAt }));
      expect(r!.reply).toMatch(re);
    }
  });
});

// ---------------------------------------------------------------------------
// /harness
// ---------------------------------------------------------------------------

describe("/harness", () => {
  test("with no arg lists current chain and marks the primary", async () => {
    const r = await handleSlashCommand("/harness", ctx());
    expect(r!.reply).toContain("→ claude");
    expect(r!.reply).toMatch(/\s+pi/);
    expect(r!.reply).toContain("/harness <id>");
  });

  test("annotates unavailable harnesses without removing them from the list", async () => {
    const r = await handleSlashCommand(
      "/harness",
      ctx({
        harnesses: [
          new StubHarness("claude", true),
          new StubHarness("pi", false),
        ],
      }),
    );
    expect(r!.reply).toContain("pi (unavailable)");
  });

  test("switches primary by reordering the chain in place", async () => {
    const harnesses = [new StubHarness("claude"), new StubHarness("pi")];
    const r = await handleSlashCommand("/harness pi", ctx({ harnesses }));
    expect(r!.reply).toContain("switched to pi");
    expect(harnesses.map((h) => h.id)).toEqual(["pi", "claude"]);
  });

  test("rejects unknown harness ids with the available list", async () => {
    const r = await handleSlashCommand("/harness doesnotexist", ctx());
    expect(r!.reply).toContain("unknown harness");
    expect(r!.reply).toContain("claude, pi");
  });

  test("refuses to switch to an unavailable harness so we don't burn a turn discovering it", async () => {
    const harnesses = [
      new StubHarness("claude", true),
      new StubHarness("pi", false),
    ];
    const r = await handleSlashCommand("/harness pi", ctx({ harnesses }));
    expect(r!.reply).toContain("isn't available");
    // Chain unchanged.
    expect(harnesses.map((h) => h.id)).toEqual(["claude", "pi"]);
  });

  test("noop when the requested harness is already primary", async () => {
    const harnesses = [new StubHarness("claude"), new StubHarness("pi")];
    const r = await handleSlashCommand(
      "/harness claude",
      ctx({ harnesses }),
    );
    expect(r!.reply).toContain("already primary");
    expect(harnesses.map((h) => h.id)).toEqual(["claude", "pi"]);
  });

  test("empty chain reports a clean error rather than dividing by zero", async () => {
    const r = await handleSlashCommand("/harness", ctx({ harnesses: [] }));
    expect(r!.reply).toContain("no harnesses");
  });
});

// ---------------------------------------------------------------------------
// /help
// ---------------------------------------------------------------------------

describe("/help", () => {
  test("lists every command we own", async () => {
    const r = await handleSlashCommand("/help", ctx());
    expect(r!.reply).toContain("/stop");
    expect(r!.reply).toContain("/reset");
    expect(r!.reply).toContain("/status");
    expect(r!.reply).toContain("/harness");
    expect(r!.reply).toContain("/update");
    expect(r!.reply).toContain("/restart");
    expect(r!.reply).toContain("/help");
  });
});

// ---------------------------------------------------------------------------
// /update
// ---------------------------------------------------------------------------
//
// The happy path (update flow, marker write, restart callback) is tested
// exhaustively in tests/lib-updateNotify.test.ts where the fetch + runUpdate
// seams are mocked. Here we just verify the dispatcher wires through and
// fails loud when config wasn't plumbed.
describe("/update", () => {
  test("recognized as a slash command (not null)", async () => {
    // Plumb a config so the handler reaches runUpdateFlow and a non-null
    // result comes back. With procPlatform=win32 the flow short-circuits
    // to "can't self-update", so we don't have to mock fetch here — and
    // we get to verify the dispatcher routed the call correctly.
    // Construct a minimal config inline rather than importing baseConfig.
    const minimalConfig = {
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
    // We can't mock procPlatform from outside runUpdateFlow because the
    // dispatcher doesn't accept seams. Instead, swap process.platform
    // briefly so the flow exits early at the platform check — far before
    // any network call. (Bun preserves the property descriptor; restore
    // in finally.)
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const r = await handleSlashCommand(
        "/update",
        ctx({ config: minimalConfig }),
      );
      expect(r).not.toBeNull();
      expect(r!.reply).toContain("can't self-update");
      expect(r!.reply).toContain("platform=win32");
      // No restart callback when the flow short-circuits at the platform
      // check (nothing was installed, nothing to restart).
      expect(r!.afterSend).toBeUndefined();
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform });
    }
  });

  test("missing config in context → loud refusal rather than silent no-op", async () => {
    // Production always plumbs config. This is the defensive branch for
    // a future caller that forgets — fail visibly, don't pretend we ran.
    const r = await handleSlashCommand("/update", ctx());
    expect(r).not.toBeNull();
    expect(r!.reply).toContain("update unavailable");
    expect(r!.afterSend).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// /restart
// ---------------------------------------------------------------------------

describe("/restart", () => {
  test("recognized as a slash command and returns restarting reply", async () => {
    const r = await handleSlashCommand("/restart", ctx());
    expect(r).not.toBeNull();
    expect(r!.reply).toContain("restarting");
  });

  test("provides an afterSend callback for the channel layer", async () => {
    const r = await handleSlashCommand("/restart", ctx());
    expect(r).not.toBeNull();
    expect(typeof r!.afterSend).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Internal helpers exposed for testability
// ---------------------------------------------------------------------------

describe("nominalContextWindow", () => {
  test("returns sensible defaults per harness id", () => {
    expect(nominalContextWindow("claude")).toBe(200_000);
    expect(nominalContextWindow("gemini")).toBe(1_000_000);
    expect(nominalContextWindow("pi")).toBe(64_000);
    expect(nominalContextWindow("unknown")).toBe(128_000);
  });
});
