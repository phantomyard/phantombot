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

/**
 * kaieriksen on #520: the config a listener hands the planner is that
 * listener's PERSONA-RESOLVED config, not the host layer. Inferring sibling
 * ownership from it sends a sibling's heads-up through the caller's own bot.
 */
describe("recipient resolution is not inferred from the caller's config", () => {
  /** Kai's exact repro: lena's listener, robbie still named as host default. */
  function lenaResolvedConfig(): any {
    return {
      personaLayer: "lena",
      defaultPersona: "robbie",
      autostartPersonas: ["robbie", "lena"],
      channels: {
        // On lena's listener THIS is lena's bot, not robbie's.
        telegram: account("LENA_BOT", [1]),
        telegramPersonas: {},
      },
    };
  }

  test("the caller's own [channels.telegram] is never attributed to the default persona", () => {
    const plan = planLifecycleBroadcast({
      config: lenaResolvedConfig(),
      excludePersona: "lena",
    });
    // Before the fix this returned { persona: "robbie", token: "LENA_BOT" } —
    // robbie's name on lena's token. Skipping is the only safe answer without
    // a real account map.
    expect(plan.find((r) => r.token === "LENA_BOT")).toBeUndefined();
    expect(plan).toEqual([]);
  });

  test("the host block is still attributed correctly on an UNRESOLVED config", () => {
    const plan = planLifecycleBroadcast({
      config: config(),
      excludePersona: "kai",
    });
    expect(plan.find((r) => r.persona === "robbie")?.token).toBe("tok-robbie");
  });

  test("a supplied account map wins over any inference the config would make", () => {
    const plan = planLifecycleBroadcast({
      config: lenaResolvedConfig(),
      runningPersonas: ["robbie", "lena"],
      accounts: [
        { persona: "robbie", token: "ROBBIE_BOT", chatIds: [7] },
        { persona: "lena", token: "LENA_BOT", chatIds: [1] },
      ],
      excludePersona: "lena",
    });
    expect(plan).toEqual([
      { persona: "robbie", token: "ROBBIE_BOT", chatIds: [7] },
    ]);
  });

  test("a supplied map is exhaustive: an absent persona does NOT fall back to config", () => {
    // `kai` is deliberately chosen: config DOES carry an account for him, so a
    // fallback-to-inference bug would happily include him. The daemon left him
    // out of the map, which means he has no live Telegram listener (a
    // PhantomChat-only persona, or one whose listener never started), and the
    // map is the only thing that knows that. Picking a persona config could
    // not resolve either would make this assertion vacuous.
    const plan = planLifecycleBroadcast({
      config: config(),
      runningPersonas: ["robbie", "lena", "kai"],
      accounts: [
        { persona: "robbie", token: "ROBBIE_BOT", chatIds: [7] },
        { persona: "lena", token: "tok-lena", chatIds: [1] },
      ],
      excludePersona: "robbie",
    });
    expect(plan.map((r) => r.persona)).toEqual(["lena"]);
  });

  test("the back-online half honours the account map too", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phantombot-lifecycle-"));
    const path = join(dir, ".pending-lifecycle.json");
    try {
      await writePendingLifecycle(
        {
          command: "/update",
          originPersona: "lena",
          personas: ["robbie"],
          writtenAt: new Date().toISOString(),
        },
        path,
      );
      const t = fakeTransports();
      const res = await notifyLifecycleBackIfPending({
        config: lenaResolvedConfig(),
        currentVersion: "1.2.3",
        runningPersonas: ["robbie", "lena"],
        accounts: [{ persona: "robbie", token: "ROBBIE_BOT", chatIds: [7] }],
        path,
        createTransport: t.createTransport,
      });
      expect(res.status).toBe("notified");
      expect(t.sent).toEqual([
        {
          token: "ROBBIE_BOT",
          chatId: "7",
          text: backOnlineMessage("/update", "1.2.3"),
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
