/**
 * Tests for the SQLite-backed memory store. Uses an in-memory database
 * (":memory:") per test so there's no filesystem cleanup needed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type MemoryStore, openMemoryStore } from "../src/memory/store.ts";

let store: MemoryStore;

beforeEach(async () => {
  store = await openMemoryStore(":memory:");
});

afterEach(async () => {
  await store.close();
});

async function append(
  persona: string,
  conversation: string,
  role: "user" | "assistant",
  text: string,
): Promise<void> {
  await store.appendTurn({ persona, conversation, role, text });
}

describe("MemoryStore.appendTurn / recentTurns", () => {
  test("returns empty array when nothing has been written", async () => {
    const turns = await store.recentTurns("phantom", "cli:default", 10);
    expect(turns).toEqual([]);
  });

  test("appends one turn and reads it back", async () => {
    await append("phantom", "cli:default", "user", "hello");
    const turns = await store.recentTurns("phantom", "cli:default", 10);
    expect(turns).toEqual([{ role: "user", text: "hello" }]);
  });

  test("returns turns in chronological order, oldest first", async () => {
    await append("phantom", "cli:default", "user", "first");
    await append("phantom", "cli:default", "assistant", "second");
    await append("phantom", "cli:default", "user", "third");
    const turns = await store.recentTurns("phantom", "cli:default", 10);
    expect(turns).toEqual([
      { role: "user", text: "first" },
      { role: "assistant", text: "second" },
      { role: "user", text: "third" },
    ]);
  });

  test("respects the LIMIT N (returns the N most recent, still chronological)", async () => {
    for (let i = 1; i <= 5; i++) {
      await append("phantom", "cli:default", "user", `msg ${i}`);
    }
    const turns = await store.recentTurns("phantom", "cli:default", 3);
    expect(turns).toEqual([
      { role: "user", text: "msg 3" },
      { role: "user", text: "msg 4" },
      { role: "user", text: "msg 5" },
    ]);
  });

  test("scopes by (persona, conversation) — different persona is isolated", async () => {
    await append("phantom", "cli:default", "user", "phantom turn");
    await append("robbie", "cli:default", "user", "robbie turn");
    const phantom = await store.recentTurns("phantom", "cli:default", 10);
    const robbie = await store.recentTurns("robbie", "cli:default", 10);
    expect(phantom).toEqual([{ role: "user", text: "phantom turn" }]);
    expect(robbie).toEqual([{ role: "user", text: "robbie turn" }]);
  });

  test("scopes by (persona, conversation) — different conversation is isolated", async () => {
    await append("phantom", "cli:default", "user", "default conv");
    await append("phantom", "telegram:42", "user", "tg conv");
    const def = await store.recentTurns("phantom", "cli:default", 10);
    const tg = await store.recentTurns("phantom", "telegram:42", 10);
    expect(def).toEqual([{ role: "user", text: "default conv" }]);
    expect(tg).toEqual([{ role: "user", text: "tg conv" }]);
  });
});

describe("MemoryStore.recentTurnsForDisplay", () => {
  test("returns full Turn objects with id, conversation, createdAt", async () => {
    await append("phantom", "cli:default", "user", "hi");
    await append("phantom", "cli:default", "assistant", "hello");
    const turns = await store.recentTurnsForDisplay("phantom", 10);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.role).toBe("user");
    expect(turns[0]?.text).toBe("hi");
    expect(turns[0]?.conversation).toBe("cli:default");
    expect(turns[0]?.persona).toBe("phantom");
    expect(turns[0]?.createdAt).toBeInstanceOf(Date);
    expect(typeof turns[0]?.id).toBe("number");
  });

  test("returns turns across all conversations for one persona, chronological", async () => {
    await append("phantom", "cli:default", "user", "cli msg");
    await append("phantom", "telegram:42", "user", "tg msg");
    const turns = await store.recentTurnsForDisplay("phantom", 10);
    expect(turns.map((t) => t.text)).toEqual(["cli msg", "tg msg"]);
  });

  test("scopes to the requested persona", async () => {
    await append("phantom", "cli:default", "user", "phantom");
    await append("robbie", "cli:default", "user", "robbie");
    const phantom = await store.recentTurnsForDisplay("phantom", 10);
    expect(phantom).toHaveLength(1);
    expect(phantom[0]?.text).toBe("phantom");
  });
});

describe("MemoryStore.close", () => {
  test("close is idempotent — calling twice does not throw", async () => {
    await store.close();
    await expect(store.close()).resolves.toBeUndefined();
  });
});

describe("MemoryStore — persistence to a real file", () => {
  test("data survives close + reopen of the same db file", async () => {
    const tmp = `/tmp/phantombot-memory-test-${Date.now()}.sqlite`;
    const a = await openMemoryStore(tmp);
    await a.appendTurn({
      persona: "phantom",
      conversation: "cli:default",
      role: "user",
      text: "remember me",
    });
    await a.close();
    const b = await openMemoryStore(tmp);
    const turns = await b.recentTurns("phantom", "cli:default", 10);
    expect(turns).toEqual([{ role: "user", text: "remember me" }]);
    await b.close();
    await Bun.file(tmp).delete?.();
  });
});
