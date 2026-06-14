/**
 * Tests for the phantomchat proactive onboarding greeting: the bot reaches OUT
 * to its allowlist (sends a persona-voiced "Hello" to npubs it hasn't greeted),
 * with a plain-"Hello" fallback when generation is unavailable.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Harness, HarnessChunk, HarnessRequest } from "../src/harnesses/types.ts";
import {
  FALLBACK_GREETING,
  greetPendingNpubs,
  resolvePersonaGreeting,
} from "../src/channels/phantomchat/greet.ts";
import { decodeNpubToHex, generateIdentity } from "../src/lib/nostrIdentity.ts";

class ScriptedHarness implements Harness {
  invocations = 0;
  lastRequest?: HarnessRequest;
  constructor(
    public readonly id: string,
    private readonly script: HarnessChunk[],
  ) {}
  async available(): Promise<boolean> {
    return true;
  }
  async *invoke(req: HarnessRequest): AsyncGenerator<HarnessChunk> {
    this.invocations++;
    this.lastRequest = req;
    for (const c of this.script) yield c;
  }
}

let workdir: string;
let agentDir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-pc-greet-"));
  agentDir = join(workdir, "lena");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "BOOT.md"), "# Lena", "utf8");
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("greetPendingNpubs", () => {
  test("greets only un-greeted npubs and records each by hex", async () => {
    const a = generateIdentity().npub;
    const b = generateIdentity().npub;
    const c = generateIdentity().npub;
    const sent: Array<{ hex: string; text: string }> = [];
    const recorded: string[] = [];

    const res = await greetPendingNpubs({
      persona: "lena",
      allowedNpubs: [a, b, c],
      greetedNpubs: [b], // already onboarded → must be skipped
      greeting: "Hi there!",
      sendMessage: async (hex, text) => {
        sent.push({ hex, text });
      },
      recordGreeted: async (npub) => {
        recorded.push(npub);
      },
    });

    expect(res.greeted).toEqual([a, c]);
    expect(res.failed).toEqual([]);
    expect(sent.map((s) => s.hex)).toEqual([decodeNpubToHex(a), decodeNpubToHex(c)]);
    expect(sent.every((s) => s.text === "Hi there!")).toBe(true);
    expect(recorded).toEqual([a, c]);
  });

  test("a send failure leaves that npub UN-recorded (retried next start) and doesn't abort the rest", async () => {
    const a = generateIdentity().npub;
    const b = generateIdentity().npub;
    const recorded: string[] = [];

    const res = await greetPendingNpubs({
      persona: "lena",
      allowedNpubs: [a, b],
      greetedNpubs: [],
      greeting: "Hi!",
      sendMessage: async (hex) => {
        if (hex === decodeNpubToHex(a)) throw new Error("relay down");
      },
      recordGreeted: async (npub) => {
        recorded.push(npub);
      },
    });

    expect(res.failed).toEqual([a]);
    expect(res.greeted).toEqual([b]); // the rest still got greeted
    expect(recorded).toEqual([b]); // failed npub NOT recorded → retried later
  });

  test("an un-decodable npub is skipped (failed) without throwing", async () => {
    const good = generateIdentity().npub;
    const recorded: string[] = [];

    const res = await greetPendingNpubs({
      persona: "lena",
      allowedNpubs: ["not-a-real-npub", good],
      greetedNpubs: [],
      greeting: "Hi!",
      sendMessage: async () => {},
      recordGreeted: async (npub) => {
        recorded.push(npub);
      },
    });

    expect(res.failed).toEqual(["not-a-real-npub"]);
    expect(res.greeted).toEqual([good]);
    expect(recorded).toEqual([good]);
  });

  test("nothing pending → no sends, no records", async () => {
    const a = generateIdentity().npub;
    let sends = 0;
    const res = await greetPendingNpubs({
      persona: "lena",
      allowedNpubs: [a],
      greetedNpubs: [a],
      greeting: "Hi!",
      sendMessage: async () => {
        sends++;
      },
      recordGreeted: async () => {},
    });
    expect(res.greeted).toEqual([]);
    expect(sends).toBe(0);
  });
});

describe("resolvePersonaGreeting", () => {
  test("returns the persona-generated greeting (trimmed) on success", async () => {
    const harness = new ScriptedHarness("fake", [
      { type: "text", text: "  Hey! Lena here 🐾  " },
      { type: "done", finalText: "Hey! Lena here 🐾" },
    ]);
    const greeting = await resolvePersonaGreeting({
      agentDir,
      persona: "lena",
      harnesses: [harness],
      idleTimeoutMs: 1000,
    });
    expect(greeting).toBe("Hey! Lena here 🐾");
    expect(harness.invocations).toBe(1);
    // The persona key is threaded so the subprocess self-identifies.
    expect(harness.lastRequest?.persona).toBe("lena");
  });

  test("falls back to plain Hello when the harness returns empty", async () => {
    const harness = new ScriptedHarness("fake", [
      { type: "done", finalText: "   " },
    ]);
    const greeting = await resolvePersonaGreeting({
      agentDir,
      persona: "lena",
      harnesses: [harness],
      idleTimeoutMs: 1000,
    });
    expect(greeting).toBe(FALLBACK_GREETING);
  });

  test("falls back to plain Hello when no harness can run", async () => {
    const greeting = await resolvePersonaGreeting({
      agentDir,
      persona: "lena",
      harnesses: [],
      idleTimeoutMs: 1000,
    });
    expect(greeting).toBe(FALLBACK_GREETING);
  });
});
