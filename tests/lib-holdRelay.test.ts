/**
 * #768 — hold notices reach the owner's open threads.
 *
 * The record: what the screen publishes after a delivered DM. The relay: each
 * reader's view of which threads are open and what each has been handed. And
 * the two local readers that cannot be pushed into from outside: the TUI
 * (system line straight away) and ACP (into the reply being streamed, or at
 * the top of the next one).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { runAcpServer } from "../src/connectors/acp/server.ts";
import type { Config } from "../src/config.ts";
import type { Harness, HarnessChunk } from "../src/harnesses/types.ts";
import {
  HOLD_NOTICES_FILE,
  HoldThreadRelay,
  groupHoldLine,
  holdCount,
  privateHoldLine,
  publishHoldNotice,
  readHoldNotices,
  startHoldRelay,
} from "../src/lib/holdRelay.ts";
import { openMemoryStore, type MemoryStore } from "../src/memory/store.ts";
import { openChat } from "../src/tui/chatSession.ts";
import { transcriptLines } from "../src/tui/transcript.ts";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "phantombot-holdrelay-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the hold-notice record", () => {
  test("publish then read, oldest first, text capped and one line", () => {
    publishHoldNotice(dir, { source: "judge", count: 1, text: "🔒 first\nsecond line" }, 1000);
    publishHoldNotice(dir, { source: "judge", count: 2, text: "x".repeat(1000) }, 2000);
    const n = readHoldNotices(dir);
    expect(n.map((x) => x.at)).toEqual([1000, 2000]);
    expect(n[0]!.text).toBe("🔒 first second line");
    expect(n[1]!.text.length).toBe(400);
    expect(readHoldNotices(dir, 1000).map((x) => x.at)).toEqual([2000]);
  });

  test("malformed lines are skipped, a missing record reads empty", async () => {
    expect(readHoldNotices(dir)).toEqual([]);
    await writeFile(
      join(dir, HOLD_NOTICES_FILE),
      'nope\n{"at":5,"source":"other","count":1,"text":"x"}\n{"at":6,"source":"judge","count":0,"text":"x"}\n{"at":7,"source":"judge","count":1,"text":"ok"}\n',
    );
    expect(readHoldNotices(dir).map((x) => x.text)).toEqual(["ok"]);
  });

  test("groups only ever get a count", () => {
    expect(groupHoldLine(1)).toBe("🔒 I held 1 action. Details in my DM.");
    expect(groupHoldLine(3)).toBe("🔒 I held 3 actions. Details in my DM.");
  });

  test("the private line is the latest notice, plus how many more", () => {
    const a = { at: 1, source: "judge" as const, count: 1, text: "A" };
    const b = { at: 2, source: "judge" as const, count: 2, text: "B" };
    expect(privateHoldLine([a])).toBe("A");
    expect(privateHoldLine([a, b])).toBe("B (+1 more, see DM)");
    expect(holdCount([a, b])).toBe(3);
  });
});

describe("HoldThreadRelay", () => {
  test("hands new notices to every thread active in the window, once", () => {
    const relay = new HoldThreadRelay(dir, { startedAt: 0, windowMs: 60_000 });
    relay.touch("group:a", 1000);
    relay.touch("group:b", 1000);
    publishHoldNotice(dir, { source: "judge", count: 1, text: "held" }, 2000);
    const due = relay.due(3000);
    expect(due.map((d) => d.thread).sort()).toEqual(["group:a", "group:b"]);
    expect(due[0]!.notices.map((n) => n.text)).toEqual(["held"]);
    expect(relay.due(4000)).toEqual([]);
  });

  test("a thread idle past the window is not told", () => {
    const relay = new HoldThreadRelay(dir, { startedAt: 0, windowMs: 60_000 });
    relay.touch("group:old", 1000);
    relay.touch("group:new", 70_000);
    publishHoldNotice(dir, { source: "judge", count: 1, text: "held" }, 80_000);
    expect(relay.due(80_500).map((d) => d.thread)).toEqual(["group:new"]);
  });

  test("notices from before the relay started are never replayed", () => {
    publishHoldNotice(dir, { source: "judge", count: 1, text: "old" }, 1000);
    const relay = new HoldThreadRelay(dir, { startedAt: 5000 });
    relay.touch("group:a", 6000);
    expect(relay.due(7000)).toEqual([]);
  });

  test("a thread that opens after a notice does not get it later", () => {
    const relay = new HoldThreadRelay(dir, { startedAt: 0 });
    publishHoldNotice(dir, { source: "judge", count: 1, text: "held" }, 2000);
    expect(relay.due(3000)).toEqual([]);
    relay.touch("group:late", 4000);
    expect(relay.due(5000)).toEqual([]);
  });

  test("a burst inside one poll is handed over together", () => {
    const relay = new HoldThreadRelay(dir, { startedAt: 0 });
    relay.touch("group:a", 1000);
    publishHoldNotice(dir, { source: "judge", count: 1, text: "one" }, 2000);
    publishHoldNotice(dir, { source: "judge", count: 2, text: "two" }, 2001);
    const [d] = relay.due(3000);
    expect(holdCount(d!.notices)).toBe(3);
  });

  test("a delivery that throws is swallowed and the poller keeps going", async () => {
    const relay = new HoldThreadRelay(dir);
    relay.touch("gone");
    relay.touch("fine");
    const got: string[] = [];
    const stop = startHoldRelay(
      relay,
      (thread) => {
        if (thread === "gone") throw new Error("chat not found");
        got.push(thread);
      },
      10,
    );
    try {
      await sleep(5);
      publishHoldNotice(dir, { source: "judge", count: 1, text: "held" });
      await sleep(60);
      expect(got).toEqual(["fine"]);
    } finally {
      stop();
    }
  });
});

describe("TUI: a hold shows as a system line straight away", () => {
  test("appended to the open session's transcript, rendered without a speaker", async () => {
    const store = await openMemoryStore(join(dir, "memory.sqlite"));
    await mkdir(join(dir, "robbie"), { recursive: true });
    const session = await openChat({
      config: { personasDir: dir } as unknown as Config,
      persona: "robbie",
      memory: store,
      harnesses: [],
      holdRelayPollMs: 10,
    });
    try {
      await sleep(5);
      publishHoldNotice(join(dir, "robbie"), { source: "judge", count: 1, text: "🔒 Held in scheduled task 12: push code." });
      await sleep(80);
      const msgs = session.transcript.getSnapshot();
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({ notice: true, text: "🔒 Held in scheduled task 12: push code." });
      const lines = transcriptLines(msgs, 80, { personaName: "robbie", formatDuration: () => "" });
      expect(lines.some((l) => l.kind === "header")).toBe(false);
      // Never written to memory.
      expect(await store.recentTurns("robbie", "cli:tui:robbie", 10)).toEqual([]);
    } finally {
      await session.close();
      await store.close();
    }
  });
});

describe("ACP: a hold joins the reply being streamed, or opens the next one", () => {
  class Slow implements Harness {
    readonly id = "h";
    during?: () => void;
    async available() {
      return true;
    }
    async *invoke(): AsyncGenerator<HarnessChunk> {
      yield { type: "text", text: "working" };
      this.during?.();
      this.during = undefined;
      await sleep(80);
      yield { type: "done", finalText: "working" };
    }
  }

  type Send = (msg: unknown) => void;
  async function drive(harness: Harness, script: (send: Send, lines: any[]) => Promise<void>) {
    const memory: MemoryStore = await openMemoryStore(join(dir, "memory.sqlite"));
    const personaPath = join(dir, "personas", "phantom");
    await mkdir(personaPath, { recursive: true });
    await writeFile(join(personaPath, "BOOT.md"), "# Phantom\n");
    const config = {
      defaultPersona: "phantom",
      harnessIdleTimeoutMs: 5000,
      harnessHardTimeoutMs: 5000,
      harnessStartupTimeoutMs: 5000,
      personasDir: join(dir, "personas"),
      memoryDbPath: join(dir, "memory.sqlite"),
      configPath: join(dir, "config.toml"),
      harnesses: { chain: ["claude"], claude: { bin: "claude", model: "opus", fallbackModel: "sonnet" }, pi: { bin: "pi", maxPayloadBytes: 1 } },
      channels: {},
      embeddings: { provider: "none" },
      voice: { provider: "none" },
    } as unknown as Config;
    const input = new PassThrough();
    const lines: any[] = [];
    let partial = "";
    const output = {
      write(s: string) {
        partial += s;
        let i: number;
        while ((i = partial.indexOf("\n")) >= 0) {
          const l = partial.slice(0, i);
          partial = partial.slice(i + 1);
          if (l.trim()) lines.push(JSON.parse(l));
        }
        return true;
      },
    };
    const done = runAcpServer({
      config,
      memory,
      harnesses: [harness],
      input,
      output: output as any,
      logErr: { write: () => true } as any,
      holdRelayPollMs: 10,
    });
    await script((m) => input.write(JSON.stringify(m) + "\n"), lines);
    input.end();
    await done;
    await memory.close();
    return lines;
  }

  const until = async (pred: () => boolean, ms = 2000) => {
    const t = Date.now();
    while (!pred()) {
      if (Date.now() - t > ms) throw new Error("timed out");
      await sleep(5);
    }
  };
  const chunks = (lines: any[]) =>
    lines
      .filter((o) => o.method === "session/update" && o.params?.update?.sessionUpdate === "agent_message_chunk")
      .map((o) => o.params.update.content.text as string);
  const pdir = () => join(dir, "personas", "phantom");
  const prompt = (id: number, sessionId: string) => ({
    jsonrpc: "2.0",
    id,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text: "hi" }] },
  });

  test("mid-turn: the notice is streamed into the current reply", async () => {
    const harness = new Slow();
    harness.during = () => publishHoldNotice(pdir(), { source: "judge", count: 1, text: "🔒 I held an untrusted request." });
    const lines = await drive(harness, async (send, lines) => {
      send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: dir } });
      await until(() => lines.some((o) => o.id === 1));
      send(prompt(2, lines.find((o) => o.id === 1).result.sessionId));
      await until(() => lines.some((o) => o.id === 2));
    });
    expect(chunks(lines)).toEqual(["working", "\n\n🔒 I held an untrusted request.\n\n"]);
  });

  test("idle: the notice waits and opens the next reply", async () => {
    const harness = new Slow();
    const lines = await drive(harness, async (send, lines) => {
      send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: dir } });
      await until(() => lines.some((o) => o.id === 1));
      const sid = lines.find((o) => o.id === 1).result.sessionId;
      send(prompt(2, sid));
      await until(() => lines.some((o) => o.id === 2));
      publishHoldNotice(pdir(), { source: "judge", count: 1, text: "🔒 Held in scheduled task 12: push code." });
      await sleep(60);
      // Nothing unprompted while idle.
      expect(chunks(lines)).toEqual(["working"]);
      send(prompt(3, sid));
      await until(() => lines.some((o) => o.id === 3));
    });
    expect(chunks(lines)).toEqual(["working", "\n\n🔒 Held in scheduled task 12: push code.\n\n", "working"]);
  });

  test("a session that never prompted is not an open thread", async () => {
    const harness = new Slow();
    const lines = await drive(harness, async (send, lines) => {
      send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: dir } });
      await until(() => lines.some((o) => o.id === 1));
      publishHoldNotice(pdir(), { source: "judge", count: 1, text: "🔒 held" });
      await sleep(60);
      send(prompt(2, lines.find((o) => o.id === 1).result.sessionId));
      await until(() => lines.some((o) => o.id === 2));
    });
    expect(chunks(lines)).toEqual(["working"]);
  });
});
