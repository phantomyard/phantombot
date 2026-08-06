/**
 * Chat-session STORE tests (pure core, no `vscode`).
 *
 * Covers the client-owned multi-chat list that lives in VS Code's workspaceState:
 * list/upsert/patch/remove round-trips, most-recently-used ordering, malformed-
 * data tolerance, and Zed-style auto-titling from the first prompt.
 */

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_SESSION_TITLE,
  STORE_KEY,
  deriveSessionTitle,
  findSession,
  listSessions,
  patchSession,
  removeSession,
  upsertSession,
  type ChatSessionRecord,
  type SessionKv,
} from "../src/sessionStore.ts";

/** In-memory Memento stand-in. */
function makeKv(seed: Record<string, unknown> = {}): SessionKv & {
  raw: Map<string, unknown>;
} {
  const raw = new Map<string, unknown>(Object.entries(seed));
  return {
    raw,
    get<T>(key: string): T | undefined {
      return raw.get(key) as T | undefined;
    },
    update(key: string, value: unknown): void {
      raw.set(key, value);
    },
  };
}

const rec = (over: Partial<ChatSessionRecord> = {}): ChatSessionRecord => ({
  sessionId: "acp_abc123def456_0011",
  title: "Fix history loss",
  createdAt: 1000,
  lastUsedAt: 1000,
  titleSettled: true,
  ...over,
});

describe("upsert / list / find round-trip", () => {
  test("adds a record, then reads it back for the same cwd", () => {
    const kv = makeKv();
    upsertSession(kv, "/proj", rec());
    expect(listSessions(kv, "/proj")).toHaveLength(1);
    expect(findSession(kv, "/proj", "acp_abc123def456_0011")?.title).toBe(
      "Fix history loss",
    );
  });

  test("records are scoped per cwd (multi-root safe)", () => {
    const kv = makeKv();
    upsertSession(kv, "/a", rec({ sessionId: "acp_a_1" }));
    upsertSession(kv, "/b", rec({ sessionId: "acp_b_1" }));
    expect(listSessions(kv, "/a").map((r) => r.sessionId)).toEqual(["acp_a_1"]);
    expect(listSessions(kv, "/b").map((r) => r.sessionId)).toEqual(["acp_b_1"]);
  });

  test("upsert replaces an existing record with the same sessionId", () => {
    const kv = makeKv();
    upsertSession(kv, "/proj", rec({ title: "first" }));
    upsertSession(kv, "/proj", rec({ title: "second" }));
    const list = listSessions(kv, "/proj");
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("second");
  });

  test("persists under the versioned store key", () => {
    const kv = makeKv();
    upsertSession(kv, "/proj", rec());
    expect(kv.raw.has(STORE_KEY)).toBe(true);
  });
});

describe("listSessions ordering", () => {
  test("most-recently-used first", () => {
    const kv = makeKv();
    upsertSession(kv, "/p", rec({ sessionId: "old", lastUsedAt: 100 }));
    upsertSession(kv, "/p", rec({ sessionId: "new", lastUsedAt: 900 }));
    upsertSession(kv, "/p", rec({ sessionId: "mid", lastUsedAt: 500 }));
    expect(listSessions(kv, "/p").map((r) => r.sessionId)).toEqual([
      "new",
      "mid",
      "old",
    ]);
  });
});

describe("patchSession", () => {
  test("merges fields and keeps the sessionId immutable", () => {
    const kv = makeKv();
    upsertSession(kv, "/p", rec());
    const out = patchSession(kv, "/p", "acp_abc123def456_0011", {
      title: "renamed",
      lastUsedAt: 5000,
    });
    expect(out?.title).toBe("renamed");
    expect(out?.lastUsedAt).toBe(5000);
    expect(out?.sessionId).toBe("acp_abc123def456_0011");
  });

  test("returns undefined for an unknown session (no write)", () => {
    const kv = makeKv();
    upsertSession(kv, "/p", rec());
    expect(patchSession(kv, "/p", "nope", { title: "x" })).toBeUndefined();
    expect(listSessions(kv, "/p")[0].title).toBe("Fix history loss");
  });
});

describe("removeSession", () => {
  test("drops one record, leaves the rest", () => {
    const kv = makeKv();
    upsertSession(kv, "/p", rec({ sessionId: "a" }));
    upsertSession(kv, "/p", rec({ sessionId: "b" }));
    removeSession(kv, "/p", "a");
    expect(listSessions(kv, "/p").map((r) => r.sessionId)).toEqual(["b"]);
  });

  test("silent when the record isn't there", () => {
    const kv = makeKv();
    upsertSession(kv, "/p", rec({ sessionId: "a" }));
    removeSession(kv, "/p", "ghost");
    expect(listSessions(kv, "/p")).toHaveLength(1);
  });
});

describe("malformed-data tolerance", () => {
  test("ignores non-array / garbage entries and drops record-less items", () => {
    const kv = makeKv({
      [STORE_KEY]: {
        "/p": [
          { sessionId: "ok", title: "keep", createdAt: 1, lastUsedAt: 2 },
          { title: "no id" },
          null,
          42,
        ],
        "/other": "not-an-array",
      },
    });
    expect(listSessions(kv, "/p").map((r) => r.sessionId)).toEqual(["ok"]);
    expect(listSessions(kv, "/other")).toEqual([]);
  });

  test("supplies safe defaults for a partial record", () => {
    const kv = makeKv({
      [STORE_KEY]: { "/p": [{ sessionId: "x" }] },
    });
    const r = listSessions(kv, "/p")[0];
    expect(r.title).toBe(DEFAULT_SESSION_TITLE);
    expect(r.titleSettled).toBe(false);
  });
});

describe("deriveSessionTitle — Zed-style auto-naming", () => {
  test("uses the first non-empty line, whitespace-collapsed", () => {
    expect(deriveSessionTitle("  Fix   the   bug  ")).toBe("Fix the bug");
    expect(deriveSessionTitle("\n\nSecond line is the title\nthird")).toBe(
      "Second line is the title",
    );
  });

  test("truncates long prompts with an ellipsis", () => {
    const long = "a".repeat(200);
    const title = deriveSessionTitle(long);
    expect(title.length).toBe(60);
    expect(title.endsWith("…")).toBe(true);
  });

  test("keeps a slash-command prompt's text (still descriptive)", () => {
    expect(deriveSessionTitle("/status")).toBe("/status");
  });

  test("falls back to the default when there's nothing usable", () => {
    expect(deriveSessionTitle("")).toBe(DEFAULT_SESSION_TITLE);
    expect(deriveSessionTitle("   \n  ")).toBe(DEFAULT_SESSION_TITLE);
  });
});
