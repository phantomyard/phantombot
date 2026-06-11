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

describe("MemoryStore.appendTurnPair (atomic)", () => {
  test("persists both rows, user before assistant", async () => {
    await store.appendTurnPair(
      { persona: "phantom", conversation: "c", role: "user", text: "q" },
      { persona: "phantom", conversation: "c", role: "assistant", text: "a" },
    );
    const turns = await store.recentTurns("phantom", "c", 10);
    expect(turns).toEqual([
      { role: "user", text: "q" },
      { role: "assistant", text: "a" },
    ]);
  });

  test("rolls back fully if the second insert fails — no half-turn", async () => {
    // A bad bind on the assistant turn makes the second INSERT throw mid
    // transaction. The user turn must NOT survive: that half-turn (user
    // with no reply) is exactly what the atomic pair is meant to prevent.
    await expect(
      store.appendTurnPair(
        { persona: "phantom", conversation: "c", role: "user", text: "q" },
        {
          persona: "phantom",
          conversation: "c",
          role: "assistant",
          // biome-ignore lint: deliberately invalid to force a bind failure
          text: {} as unknown as string,
        },
      ),
    ).rejects.toThrow();
    const turns = await store.recentTurns("phantom", "c", 10);
    expect(turns).toEqual([]);
  });
});

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

describe("MemoryStore.turnsAfterId / countUserTurns", () => {
  test("returns full rows after a known id within one conversation", async () => {
    await append("phantom", "cli:default", "user", "first");
    const rows = await store.recentTurnsForDisplay("phantom", 10);
    const firstId = rows[0]!.id;
    await append("phantom", "cli:default", "assistant", "second");
    await append("phantom", "telegram:42", "user", "other conversation");

    const after = await store.turnsAfterId("phantom", "cli:default", firstId);
    expect(after.map((t) => t.text)).toEqual(["second"]);
  });

  test("countUserTurns counts only user rows in the requested conversation", async () => {
    await append("phantom", "cli:default", "user", "u1");
    await append("phantom", "cli:default", "assistant", "a1");
    await append("phantom", "cli:default", "user", "u2");
    await append("phantom", "telegram:42", "user", "other");

    expect(await store.countUserTurns("phantom", "cli:default")).toBe(2);
  });
});

describe("MemoryStore — embeddable / quarantine (F)", () => {
  test("appendTurn defaults embeddable to true", async () => {
    await append("phantom", "c", "user", "ordinary turn");
    const rows = await store.recentTurnsForDisplay("phantom", 10);
    expect(rows[0]?.embeddable).toBe(true);
  });

  test("appendTurnPair persists per-turn embeddable (user false, assistant true)", async () => {
    await store.appendTurnPair(
      {
        persona: "phantom",
        conversation: "telegram:1",
        role: "user",
        text: "raw untrusted payload",
        embeddable: false,
      },
      {
        persona: "phantom",
        conversation: "telegram:1",
        role: "assistant",
        text: "judge reasoning",
        embeddable: true,
      },
    );
    const rows = await store.recentTurnsForDisplay("phantom", 10);
    expect(rows.map((r) => [r.role, r.embeddable])).toEqual([
      ["user", false],
      ["assistant", true],
    ]);
  });

  test("turnsAfterId returns the embeddable flag", async () => {
    await store.appendTurnPair(
      {
        persona: "phantom",
        conversation: "telegram:1",
        role: "user",
        text: "payload",
        embeddable: false,
      },
      {
        persona: "phantom",
        conversation: "telegram:1",
        role: "assistant",
        text: "judge",
        embeddable: true,
      },
    );
    const after = await store.turnsAfterId("phantom", "telegram:1", 0);
    expect(after.map((t) => t.embeddable)).toEqual([false, true]);
  });

  test("recentTurns still returns quarantined turns (history replay must include them)", async () => {
    // The grounding replay depends on the quarantined payload appearing in the
    // 30-turn history; only EMBEDDING excludes it, not the history read.
    await store.appendTurnPair(
      {
        persona: "phantom",
        conversation: "telegram:1",
        role: "user",
        text: "quarantined payload",
        embeddable: false,
      },
      {
        persona: "phantom",
        conversation: "telegram:1",
        role: "assistant",
        text: "held you",
        embeddable: true,
      },
    );
    const turns = await store.recentTurns("phantom", "telegram:1", 10);
    expect(turns).toEqual([
      { role: "user", text: "quarantined payload" },
      { role: "assistant", text: "held you" },
    ]);
  });

  test("purgeQuarantined deletes only embeddable=0 rows and returns the count", async () => {
    await store.appendTurnPair(
      {
        persona: "phantom",
        conversation: "telegram:1",
        role: "user",
        text: "quarantined payload",
        embeddable: false,
      },
      {
        persona: "phantom",
        conversation: "telegram:1",
        role: "assistant",
        text: "judge reasoning (kept)",
        embeddable: true,
      },
    );
    await append("phantom", "telegram:1", "user", "later trusted turn");

    const deleted = await store.purgeQuarantined("phantom", "telegram:1");
    expect(deleted).toBe(1);
    const turns = await store.recentTurns("phantom", "telegram:1", 10);
    expect(turns).toEqual([
      { role: "assistant", text: "judge reasoning (kept)" },
      { role: "user", text: "later trusted turn" },
    ]);
  });

  test("purgeQuarantined is a no-op (returns 0) when nothing is quarantined", async () => {
    await append("phantom", "telegram:1", "user", "normal turn");
    expect(await store.purgeQuarantined("phantom", "telegram:1")).toBe(0);
  });
});

describe("MemoryStore — embeddable migration on existing DBs", () => {
  test("a freshly opened db has the embeddable column", async () => {
    // openMemoryStore runs SCHEMA + the idempotent migration; the column must
    // exist so the row mapping can read it back as a bool.
    const tmp = `/tmp/phantombot-embeddable-migration-${Date.now()}.sqlite`;
    const a = await openMemoryStore(tmp);
    await a.appendTurn({
      persona: "phantom",
      conversation: "c",
      role: "user",
      text: "x",
    });
    const rows = await a.recentTurnsForDisplay("phantom", 10);
    expect(rows[0]?.embeddable).toBe(true);
    await a.close();
    await Bun.file(tmp).delete?.();
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
