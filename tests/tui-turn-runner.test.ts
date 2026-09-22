/**
 * The turn lifecycle is owned by the SESSION, not the screen
 * (phantombot#604, review of 2d345c4).
 *
 * The first cut of #607 moved only the transcript onto the session; the
 * controller, in-flight promise and generation counter stayed screen-local,
 * so a mid-stream navigation unmounted them and a re-submit started a SECOND
 * concurrent `session.send()` (both writing the same conversation) while
 * displacing `activeTurn`, leaving `/stop` unable to abort the older turn.
 * These pins are at the level the lifecycle actually lives now: the session
 * — `createTurnRunner` over `openChat` with a real fake harness chain.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../src/config.ts";
import type {
  Harness,
  HarnessChunk,
  HarnessRequest,
} from "../src/harnesses/types.ts";
import { type MemoryStore, openMemoryStore } from "../src/memory/store.ts";
import { openChat, type ChatSession } from "../src/tui/chatSession.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let store: MemoryStore;
let dir: string;

beforeEach(async () => {
  store = await openMemoryStore(":memory:");
  dir = await mkdtemp(join(tmpdir(), "tui-turn-runner-"));
  await mkdir(join(dir, "lab"), { recursive: true });
  await writeFile(join(dir, "lab", "SOUL.md"), "You are lab.\n");
});

afterEach(async () => {
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

function config(): Config {
  return {
    personasDir: dir,
    harnessIdleTimeoutMs: 5000,
    harnessHardTimeoutMs: 5000,
    embeddings: { provider: "none" },
    harnesses: {
      chain: [],
      claude: { bin: "claude", model: "" },
      pi: { bin: "pi", model: "" },
    },
  } as unknown as Config;
}

/**
 * A harness that streams a little text and then blocks until its signal is
 * aborted — recording every abort reason it saw, so the test can assert
 * WHICH turn got interrupted and by what reason.
 */
function blockingHarness(reasons: unknown[], started: string[]): Harness {
  return {
    id: "block",
    available: async () => true,
    async *invoke(req: HarnessRequest): AsyncGenerator<HarnessChunk> {
      started.push(req.userMessage);
      yield { type: "text", text: "working on it" };
      await new Promise<void>((resolve) => {
        if (req.signal?.aborted) return resolve();
        req.signal?.addEventListener(
          "abort",
          () => {
            reasons.push(req.signal?.reason);
            resolve();
          },
          { once: true },
        );
      });
      yield { type: "error", error: "aborted", recoverable: false };
    },
  };
}

function answeringHarness(): Harness {
  return {
    id: "ok",
    available: async () => true,
    async *invoke(): AsyncGenerator<HarnessChunk> {
      yield { type: "text", text: "done it" };
      yield { type: "done", finalText: "done it" };
    },
  };
}

async function openLab(harnesses: Harness[]): Promise<ChatSession> {
  return openChat({
    config: config(),
    persona: "lab",
    memory: store,
    harnesses,
  });
}

describe("session-owned turn lifecycle (createTurnRunner over openChat)", () => {
  test("a submit during a turn interrupts it — never two concurrent sends", async () => {
    const reasons: unknown[] = [];
    const started: string[] = [];
    const chat = await openLab([blockingHarness(reasons, started)]);
    try {
      const first = chat.submit("first question");
      await sleep(150); // first turn is now mid-stream, blocked on the harness
      const second = chat.submit("second question");
      await first.catch(() => {});
      await sleep(100); // the queued second prompt now starts its own turn
      // ONE abort, reason "interrupt", and the second prompt was sent exactly
      // once — the first turn was interrupted, not run alongside.
      expect(reasons).toEqual(["interrupt"]);
      expect(started).toEqual(["first question", "second question"]);
      // The second turn now blocks on the same harness; end it so the test
      // can assert the persisted history.
      chat.abortTurn("stop");
      await second.catch(() => {});
      // History lands in the order it was typed, first turn marked interrupted.
      const turns = await store.recentTurns("lab", chat.conversation, 10);
      expect(turns.map((t) => [t.role, t.text])).toEqual([
        ["user", "first question"],
        ["assistant", "working on it\n\n[interrupted before reply]"],
        ["user", "second question"],
        ["assistant", "working on it\n\n[interrupted before reply]"],
      ]);
    } finally {
      await chat.close();
    }
  });

  test("/stop reaches the SAME turn after a new session owner takes over", async () => {
    // The displaced-activeTurn defect: /stop must abort the turn in flight
    // even when the screen that started it is long gone.
    const reasons: unknown[] = [];
    const started: string[] = [];
    const chat = await openLab([blockingHarness(reasons, started)]);
    try {
      void chat.submit("long running").catch(() => {});
      await sleep(150);
      const result = await chat.command("/stop");
      expect(result?.reply ?? "").toMatch(/stop|abort|interrupt/i);
      await sleep(100);
      expect(reasons).toEqual(["stop"]);
      const turns = await store.recentTurns("lab", chat.conversation, 10);
      expect(turns.map((t) => [t.role, t.text])).toEqual([
        ["user", "[system] The user issued /stop. The turn that was running was aborted. Do not resume, retry, or continue that work, and do not report on it unless asked. Await further instructions."],
        ["user", "long running"],
        ["assistant", "working on it\n\n[interrupted before reply]"],
      ]);
    } finally {
      await chat.close();
    }
  });

  test("the busy state survives the session outliving its first consumer", async () => {
    // A "remounted" consumer reads the same TurnStore: busy with the SAME
    // start time — the clock a returning screen shows is the turn's real age.
    const chat = await openLab([answeringHarness()]);
    try {
      const first = chat.submit("hello");
      // Busy the moment submit is called, before the harness answers.
      expect(chat.turn.getSnapshot().busy).toBe(true);
      const since = chat.turn.getSnapshot().busySince;
      expect(since).toBeDefined();
      await first;
      expect(chat.turn.getSnapshot().busy).toBe(false);
      expect(chat.turn.getSnapshot().busySince).toBeUndefined();
      // The transcript holds the whole exchange; a later screen just renders it.
      const snapshot = chat.transcript.getSnapshot();
      expect(snapshot.map((m) => [m.role, m.text])).toEqual([
        ["user", "hello"],
        ["assistant", "done it"],
      ]);
    } finally {
      await chat.close();
    }
  });
});
