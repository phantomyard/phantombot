/**
 * The terminal dispatches slash commands ahead of the harness (phantombot#480).
 *
 * The point of dispatching AHEAD is not tidiness: `/stop` exists to kill a turn
 * that is currently blocking everything, so a `/stop` routed through the model
 * would only run once the thing it was meant to interrupt had finished. That is
 * the behaviour pinned hardest here.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import type { Harness, HarnessChunk } from "../src/harnesses/types.ts";
import { type MemoryStore, openMemoryStore } from "../src/memory/store.ts";
import { openChat } from "../src/tui/chatSession.ts";

let store: MemoryStore;
let dir: string;

beforeEach(async () => {
  store = await openMemoryStore(":memory:");
  dir = await mkdtemp(join(tmpdir(), "tui-cmd-"));
  // A turn needs a persona with an identity file, or it ends in an error
  // before the harness is ever reached — and then there is no in-flight turn
  // for /stop to be tested against.
  await mkdir(join(dir, "lab"), { recursive: true });
  await writeFile(join(dir, "lab", "SOUL.md"), "You are lab.\n");
});

afterEach(async () => {
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

function config(): Config {
  return { personasDir: dir } as unknown as Config;
}

/** A harness that answers nothing until it is aborted. */
function hangingHarness(): Harness {
  return {
    id: "hang",
    available: async () => true,
    async *invoke(req): AsyncGenerator<HarnessChunk> {
      yield { type: "heartbeat" } as HarnessChunk;
      await new Promise<void>((resolve) => {
        if (req.signal?.aborted) return resolve();
        req.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "error", error: "stopped", recoverable: false } as HarnessChunk;
    },
  };
}

async function session(harnesses: Harness[] = []) {
  return await openChat({
    config: config(),
    persona: "lab",
    memory: store,
    harnesses,
  });
}

describe("chat session commands", () => {
  test("/help is answered by phantombot, with the real command list", async () => {
    const chat = await session();
    const result = await chat.command("/help");
    await chat.close();
    expect(result?.reply).toContain("/status");
    expect(result?.reply).toContain("/harness");
  });

  test("a path is not a command and goes to the harness instead", async () => {
    const chat = await session();
    expect(await chat.command("/usr/bin/env is on PATH?")).toBeNull();
    expect(await chat.command("what does /stop do?")).toBeNull();
    await chat.close();
  });

  test("a command-shaped typo is answered here, not improvised by the model", async () => {
    const chat = await session();
    const result = await chat.command("/statuss");
    await chat.close();
    expect(result?.reply).toContain("/statuss");
    expect(result?.reply).toContain("/help");
  });

  test("/stop aborts the turn that is running RIGHT NOW", async () => {
    const chat = await session([hangingHarness()]);
    const events: string[] = [];
    const running = (async () => {
      for await (const event of chat.send("do something slow")) {
        events.push(event.type);
      }
    })();

    // Let the turn get as far as the harness before interrupting it.
    await new Promise((r) => setTimeout(r, 50));
    const result = await chat.command("/stop");
    expect(result?.reply).not.toContain("no active turn");

    // The whole test: this resolves. Without out-of-band dispatch it would
    // hang forever behind the turn it was supposed to kill.
    await running;
    await chat.close();
    expect(events.length).toBeGreaterThan(0);
  }, 10_000);

  test("/stop with nothing running says so rather than pretending", async () => {
    const chat = await session();
    const result = await chat.command("/stop");
    await chat.close();
    expect(result?.reply).toContain("no active turn");
  });

  test("the in-flight handle is released when the turn ends", async () => {
    // Otherwise every later /stop would report stopping a turn that finished
    // minutes ago.
    const chat = await session();
    for await (const _ of chat.send("hi")) {
      // No harness: the session yields its "no harness" error and ends.
    }
    const result = await chat.command("/stop");
    await chat.close();
    expect(result?.reply).toContain("no active turn");
  });
});
