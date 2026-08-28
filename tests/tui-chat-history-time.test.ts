/**
 * Replayed history keeps the time it happened.
 *
 * The chat transcript stamps every header row from `ChatMessage.at`. History
 * loaded from the store used to arrive with `at: 0`, so restarting the TUI
 * silently stripped the clock off every turn already on disk — the rows were
 * right, they just had no time on them. This pins the whole path: the store
 * hands back a real `createdAt`, `openChat` carries it, and the transcript
 * renders it.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
import { type MemoryStore, openMemoryStore } from "../src/memory/store.ts";
import { openChat, tuiConversationKey } from "../src/tui/chatSession.ts";
import { transcriptLines } from "../src/tui/transcript.ts";

let store: MemoryStore;
let dir: string;

beforeEach(async () => {
  store = await openMemoryStore(":memory:");
  dir = await mkdtemp(join(tmpdir(), "tui-hist-"));
});

afterEach(async () => {
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

function config(): Config {
  return { personasDir: dir } as unknown as Config;
}

describe("chat history timestamps", () => {
  test("turns replayed from the store carry the time they happened", async () => {
    const persona = "lab";
    const conversation = tuiConversationKey(persona);
    const before = Date.now();
    await store.appendTurnPair(
      { persona, conversation, role: "user", text: "q" },
      { persona, conversation, role: "assistant", text: "a" },
    );
    const after = Date.now();

    const session = await openChat({
      config: config(),
      persona,
      memory: store,
      harnesses: [],
    });
    await session.close();

    expect(session.history).toHaveLength(2);
    for (const message of session.history) {
      // A second of slack each way: SQLite stores whole-second ISO stamps.
      expect(message.at).toBeGreaterThanOrEqual(before - 1000);
      expect(message.at).toBeLessThanOrEqual(after + 1000);
    }

    const headers = transcriptLines(session.history, 80, {
      personaName: persona,
      formatDuration: () => "",
    }).filter((line) => line.kind === "header");
    expect(headers).toHaveLength(2);
    for (const header of headers) {
      expect(header.kind === "header" && header.time).toMatch(/^\d{2}:\d{2}$/);
    }
  });

  test("a row with an unreadable stamp renders no time, not 1970", async () => {
    const persona = "lab";
    const conversation = tuiConversationKey(persona);
    await store.appendTurn({ persona, conversation, role: "user", text: "q" });
    const broken = {
      ...store,
      recentTurnsForConversationDisplay: async () => [
        {
          id: 1,
          persona,
          conversation,
          role: "user" as const,
          text: "q",
          createdAt: new Date(Number.NaN),
          embeddable: true,
          source: "unverified" as const,
          origin: "cli",
        },
      ],
    } as unknown as MemoryStore;

    const session = await openChat({
      config: config(),
      persona,
      memory: broken,
      harnesses: [],
    });
    await session.close();

    expect(session.history[0]?.at).toBe(0);
    const [header] = transcriptLines(session.history, 80, {
      personaName: persona,
      formatDuration: () => "",
    });
    expect(header?.kind === "header" && header.time).toBe("");
  });
});
