/**
 * Lifecycle broadcast (phantombot#519): warn every OTHER persona before the
 * shared process bounces, and tell those same personas when it is back.
 *
 * The planner is pure, so the invariants that matter — never borrow another
 * persona's bot, never double-send, never message the persona that typed the
 * command — are asserted directly rather than through a transport.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backOnlineMessage,
  clearPendingLifecycle,
  impendingRestartMessage,
  notifyLifecycleBackIfPending,
  planLifecycleBroadcast,
  readPendingLifecycle,
  sendLifecycleBroadcast,
  writePendingLifecycle,
  PENDING_LIFECYCLE_MAX_AGE_MS,
} from "../src/lib/lifecycleBroadcast.ts";

function account(token: string, allowedUserIds: number[]): any {
  return { token, pollTimeoutS: 30, allowedUserIds, personaNames: [] };
}

function config(overrides: any = {}): any {
  return {
    defaultPersona: "robbie",
    autostartPersonas: ["lena", "kai"],
    channels: {
      telegram: account("tok-robbie", [1]),
      telegramPersonas: {
        lena: account("tok-lena", [1]),
        kai: account("tok-kai", [1, 2]),
      },
    },
    ...overrides,
  };
}

/** Collects (token, chatId, text) instead of talking to Telegram. */
function fakeTransports() {
  const sent: { token: string; chatId: string; text: string }[] = [];
  const failFor = new Set<string>();
  const createTransport = (token: string): any => ({
    async sendMessage(chatId: string, text: string) {
      if (failFor.has(token)) throw new Error("telegram is down");
      sent.push({ token, chatId, text });
    },
  });
  return { sent, failFor, createTransport };
}

describe("planLifecycleBroadcast", () => {
  test("warns the other personas, never the one that typed the command", () => {
    const plan = planLifecycleBroadcast({
      config: config(),
      excludePersona: "lena",
    });
    expect(plan.map((r) => r.persona).sort()).toEqual(["kai", "robbie"]);
  });

  test("the default persona's bot is the host [channels.telegram] block", () => {
    const plan = planLifecycleBroadcast({
      config: config(),
      excludePersona: "kai",
    });
    expect(plan.find((r) => r.persona === "robbie")?.token).toBe("tok-robbie");
  });

  test("a NON-default persona never borrows the host telegram block", () => {
    // `jake` is on the roster but has no account of his own: he must be
    // skipped, not silently sent through the default persona's bot (that
    // message would land in robbie's chat wearing jake's name).
    //
    // robbie is kept OUT of the roster on purpose. With him in it he claims
    // tok-robbie first and the (token, chatId) dedupe would hide a jake who
    // wrongly borrowed the same bot — making the assertion vacuous.
    const plan = planLifecycleBroadcast({
      config: config(),
      runningPersonas: ["lena", "kai", "jake"],
      excludePersona: "lena",
    });
    expect(plan.map((r) => r.persona).sort()).toEqual(["kai"]);
  });

  test("two personas sharing one bot get ONE message, not two", () => {
    const shared = account("tok-shared", [7]);
    const plan = planLifecycleBroadcast({
      config: config({
        channels: {
          telegram: undefined,
          telegramPersonas: { lena: shared, kai: shared },
        },
      }),
      excludePersona: "robbie",
    });
    const pairs = plan.flatMap((r) => r.chatIds.map((c) => `${r.token}:${c}`));
    expect(pairs).toEqual(["tok-shared:7"]);
  });

  test("the running roster wins over the config-derived one", () => {
    // kai is configured but did NOT start: he cannot be bounced mid-
    // conversation, so he must not be told he is about to be.
    const plan = planLifecycleBroadcast({
      config: config(),
      runningPersonas: ["robbie", "lena"],
      excludePersona: "robbie",
    });
    expect(plan.map((r) => r.persona)).toEqual(["lena"]);
  });

  test("`only` restricts to the personas that were actually warned", () => {
    const plan = planLifecycleBroadcast({
      config: config(),
      excludePersona: "robbie",
      only: ["kai"],
    });
    expect(plan.map((r) => r.persona)).toEqual(["kai"]);
  });

  test("no telegram anywhere → nobody to warn, and no throw", () => {
    const plan = planLifecycleBroadcast({
      config: config({ channels: {} }),
      excludePersona: "robbie",
    });
    expect(plan).toEqual([]);
  });
});

describe("sendLifecycleBroadcast", () => {
  test("fans out to every chat id of every recipient", async () => {
    const t = fakeTransports();
    const r = await sendLifecycleBroadcast({
      recipients: planLifecycleBroadcast({
        config: config(),
        excludePersona: "robbie",
      }),
      message: impendingRestartMessage("/update", "robbie"),
      createTransport: t.createTransport,
    });
    expect(r).toEqual({ sent: 3, failed: 0 });
    expect(t.sent.map((s) => `${s.token}:${s.chatId}`).sort()).toEqual([
      "tok-kai:1",
      "tok-kai:2",
      "tok-lena:1",
    ]);
    expect(t.sent[0]!.text).toContain("robbie");
  });

  test("a failing transport is counted, never thrown — the restart must proceed", async () => {
    const t = fakeTransports();
    t.failFor.add("tok-lena");
    const r = await sendLifecycleBroadcast({
      recipients: planLifecycleBroadcast({
        config: config(),
        excludePersona: "robbie",
      }),
      message: "x",
      createTransport: t.createTransport,
    });
    expect(r).toEqual({ sent: 2, failed: 1 });
  });
});

describe("the pending-lifecycle record", () => {
  test("round-trips, and holds persona NAMES only (never a bot token)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phantombot-lifecycle-"));
    try {
      const path = join(dir, ".pending-lifecycle.json");
      await writePendingLifecycle(
        {
          command: "/update",
          originPersona: "robbie",
          personas: ["lena", "kai"],
          writtenAt: new Date().toISOString(),
        },
        path,
      );
      const raw = await readFile(path, "utf8");
      expect(raw).not.toContain("tok-");
      expect((await readPendingLifecycle(path))?.personas).toEqual([
        "lena",
        "kai",
      ]);
      await clearPendingLifecycle(path);
      expect(await readPendingLifecycle(path)).toBeUndefined();
      // Clearing again is not an error.
      await clearPendingLifecycle(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("garbage on disk reads as absent rather than throwing at startup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phantombot-lifecycle-"));
    try {
      const path = join(dir, ".pending-lifecycle.json");
      await writeFile(path, "{not json", "utf8");
      expect(await readPendingLifecycle(path)).toBeUndefined();
      await writeFile(path, JSON.stringify({ command: "/update" }), "utf8");
      expect(await readPendingLifecycle(path)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("notifyLifecycleBackIfPending", () => {
  async function withMarker(
    marker: any,
    run: (path: string) => Promise<void>,
  ): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "phantombot-lifecycle-"));
    const path = join(dir, ".pending-lifecycle.json");
    try {
      if (marker) await writePendingLifecycle(marker, path);
      await run(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("no marker → silent no-op", async () => {
    await withMarker(undefined, async (path) => {
      const t = fakeTransports();
      const r = await notifyLifecycleBackIfPending({
        config: config(),
        currentVersion: "1.2.3",
        path,
        createTransport: t.createTransport,
      });
      expect(r.status).toBe("no_marker");
      expect(t.sent).toEqual([]);
    });
  });

  test("tells exactly the personas that were warned, then clears the marker", async () => {
    await withMarker(
      {
        command: "/update",
        originPersona: "robbie",
        personas: ["lena"],
        writtenAt: new Date().toISOString(),
      },
      async (path) => {
        const t = fakeTransports();
        const r = await notifyLifecycleBackIfPending({
          config: config(),
          currentVersion: "1.2.3",
          path,
          createTransport: t.createTransport,
        });
        expect(r).toEqual({ status: "notified", sent: 1 });
        expect(t.sent).toHaveLength(1);
        expect(t.sent[0]!.token).toBe("tok-lena");
        expect(t.sent[0]!.text).toBe(backOnlineMessage("/update", "1.2.3"));
        expect(await readPendingLifecycle(path)).toBeUndefined();
      },
    );
  });

  test("a stale marker is dropped, not announced hours after the fact", async () => {
    await withMarker(
      {
        command: "/restart",
        originPersona: "robbie",
        personas: ["lena", "kai"],
        writtenAt: new Date(0).toISOString(),
      },
      async (path) => {
        const t = fakeTransports();
        const r = await notifyLifecycleBackIfPending({
          config: config(),
          currentVersion: "1.2.3",
          path,
          now: new Date(PENDING_LIFECYCLE_MAX_AGE_MS + 1),
          createTransport: t.createTransport,
        });
        expect(r.status).toBe("stale");
        expect(t.sent).toEqual([]);
        expect(await readPendingLifecycle(path)).toBeUndefined();
      },
    );
  });

  test("a persona that did not come back up is not messaged", async () => {
    await withMarker(
      {
        command: "/update",
        originPersona: "robbie",
        personas: ["lena", "kai"],
        writtenAt: new Date().toISOString(),
      },
      async (path) => {
        const t = fakeTransports();
        const r = await notifyLifecycleBackIfPending({
          config: config(),
          currentVersion: "1.2.3",
          runningPersonas: ["robbie", "lena"],
          path,
          createTransport: t.createTransport,
        });
        expect(r.status).toBe("notified");
        expect(t.sent.map((s) => s.token)).toEqual(["tok-lena"]);
      },
    );
  });

  test("the marker is cleared even when every send fails", async () => {
    await withMarker(
      {
        command: "/update",
        originPersona: "robbie",
        personas: ["lena"],
        writtenAt: new Date().toISOString(),
      },
      async (path) => {
        const t = fakeTransports();
        t.failFor.add("tok-lena");
        const r = await notifyLifecycleBackIfPending({
          config: config(),
          currentVersion: "1.2.3",
          path,
          createTransport: t.createTransport,
        });
        expect(r.status).toBe("notified");
        expect(await readPendingLifecycle(path)).toBeUndefined();
      },
    );
  });
});
