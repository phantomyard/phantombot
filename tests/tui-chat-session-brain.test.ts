/**
 * The chat session's two halves of "the brain was configured but chat kept
 * failing silently":
 *
 *   - a chain-exhausted error must REACH the screen. The orchestrator marks it
 *     `recoverable` (it describes what the orchestrator may do, not whether
 *     the user was spared), and the session used to drop exactly those.
 *   - the chain must be rebuildable in place, because the session is opened
 *     once and deliberately outlives the trip to settings where the brain gets
 *     configured.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import type { Harness, HarnessChunk } from "../src/harnesses/types.ts";
import { type MemoryStore, openMemoryStore } from "../src/memory/store.ts";
import { openChat, type ChatEvent } from "../src/tui/chatSession.ts";

let store: MemoryStore;
let dir: string;

beforeEach(async () => {
  store = await openMemoryStore(":memory:");
  dir = await mkdtemp(join(tmpdir(), "tui-brain-"));
  await mkdir(join(dir, "lab"), { recursive: true });
  await writeFile(join(dir, "lab", "SOUL.md"), "You are lab.\n");
});

afterEach(async () => {
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

/**
 * `chain` is what buildHarnessChain reads; `claude`/`pi` are the per-harness
 * settings it constructs from. Only the fields the chain builder touches.
 */
function config(chain: string[] = []): Config {
  return {
    personasDir: dir,
    harnesses: {
      chain,
      claude: { bin: "claude", model: "" },
      pi: { bin: "pi", model: "" },
    },
  } as unknown as Config;
}

/**
 * The shape a missing harness binary actually takes: the orchestrator has
 * nowhere left to go, so it yields the error — flagged `recoverable` because
 * the failure itself was retryable, not because anyone recovered from it.
 */
function deadHarness(): Harness {
  return {
    id: "claude",
    available: async () => true,
    async *invoke(): AsyncGenerator<HarnessChunk> {
      yield {
        type: "error",
        error: 'harness claude threw: Executable not found in $PATH: "claude"',
        recoverable: true,
      } as HarnessChunk;
    },
  };
}

async function drain(gen: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

describe("a chain that cannot answer", () => {
  test("surfaces the failure rather than ending the turn in silence", async () => {
    const chat = await openChat({
      config: config(),
      persona: "lab",
      memory: store,
      harnesses: [deadHarness()],
    });
    const events = await drain(chat.send("hello"));
    await chat.close();

    const errors = events.filter((e) => e.type === "error");
    expect(errors.length).toBe(1);
    expect((errors[0] as { message: string }).message).toContain(
      "Executable not found",
    );
  });

  test("an empty chain names the way out of it", async () => {
    const chat = await openChat({
      config: config(),
      persona: "lab",
      memory: store,
      harnesses: [],
    });
    const events = await drain(chat.send("hello"));
    await chat.close();
    const message = (events[0] as { message: string }).message;
    expect(message).toContain("ctrl+s");
  });
});

describe("reloadHarnesses", () => {
  test("keeps an injected chain, so a test seam is not silently replaced", async () => {
    const chat = await openChat({
      config: config(),
      persona: "lab",
      memory: store,
      harnesses: [deadHarness()],
    });
    expect(await chat.reloadHarnesses(config())).toEqual(["claude"]);
    await chat.close();
  });

  test("rebuilds the chain from a config written after the session opened", async () => {
    // Opened with no persona chain at all — the pre-configuration state.
    const chat = await openChat({
      config: config(),
      persona: "lab",
      memory: store,
    });
    const before = await chat.reloadHarnesses(config());
    expect(before).toEqual([]);

    // What the brain flow writes: this persona now runs pi.
    const configured = config();
    (configured.harnesses as unknown as Record<string, unknown>).personas = {
      lab: { chain: ["pi"] },
    };
    const after = await chat.reloadHarnesses(configured);
    await chat.close();

    expect(after).toEqual(["pi"]);
    expect(after).not.toEqual(before);
  });
});
