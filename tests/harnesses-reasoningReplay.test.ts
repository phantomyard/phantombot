/**
 * Narration-decay replay (issue #551): unit tests for the ReasoningReplay
 * state machine (fake clock — exact interval semantics) and engine-level
 * integration tests through runHarnessProcess with a real subprocess and
 * real timers (the quiet-window racing is precisely what must be verified
 * against the scheduler, not a stub).
 */

import { describe, expect, test } from "bun:test";
import {
  isReasoningCapture,
  ReasoningReplay,
  replayChunk,
} from "../src/harnesses/reasoningReplay.ts";
import { runHarnessProcess } from "../src/lib/harnessRunner.ts";
import { spawnInNewSession } from "../src/lib/processGroup.ts";
import type {
  HarnessChunk,
  HarnessRequest,
} from "../src/harnesses/types.ts";

describe("ReasoningReplay — reasoning path", () => {
  test("no emission before the quiet window elapses", () => {
    const { r, set } = replayWithClock();
    r.note("thinking about the calendar");
    set(5_000); // < 10s quiet
    expect(r.due()).toBeUndefined();
    set(10_000);
    expect(r.due()).toBe("thinking about the calendar");
  });

  test("emits the newest un-emitted reasoning and stays silent without new content", () => {
    const { r, set } = replayWithClock();
    r.note("first thought");
    set(10_000);
    expect(r.due()).toBe("first thought");
    expect(r.due()).toBeUndefined(); // nothing new — silence, not repetition
    expect(r.due()).toBeUndefined();
    set(20_000); // quiet + min interval long past, but buffer still empty
    expect(r.due()).toBeUndefined();
  });

  test("new reasoning re-arms: emits again after min interval", () => {
    const { r, set } = replayWithClock();
    r.note("first thought");
    set(10_000);
    expect(r.due()).toBe("first thought");
    set(12_000);
    r.note("second thought");
    set(20_000);
    expect(r.due()).toBe("second thought");
  });

  test("min interval bounds emission even when reasoning flows constantly", () => {
    const { r, set } = replayWithClock();
    r.note("a");
    set(10_000);
    expect(r.due()).toBe("a");
    set(10_500); // < 10s since last emit, even though quiet since t=10_000
    r.note("b");
    expect(r.due()).toBeUndefined();
    set(20_000);
    expect(r.due()).toBe("b");
  });

  test("a long tail is capped to maxEmitChars keeping the newest text", () => {
    const { r, set } = replayWithClock();
    r.note("x".repeat(600) + "TAIL");
    set(10_000);
    const out = r.due()!;
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out.endsWith("TAIL")).toBe(true);
  });

  test("accumulates delta fragments into one string", () => {
    const { r, set } = replayWithClock();
    r.note("check");
    r.note("the");
    r.note("calendar");
    set(10_000);
    expect(r.due()).toBe("check the calendar");
  });
});

describe("ReasoningReplay — fallback chain", () => {
  test("no reasoning: fresh narration replays once, then stays silent", () => {
    const { r, set } = replayWithClock();
    r.visible("text", "checking your calendar");
    set(10_000);
    expect(r.due()).toBe("checking your calendar");
    set(25_000);
    expect(r.due()).toBeUndefined(); // identical string never repeats
  });

  test("stale narration (past fallbackFreshMs) is never replayed", () => {
    const { r, set } = replayWithClock();
    r.visible("text", "checking your calendar");
    set(70_000); // past fallbackFreshMs (60s)
    expect(r.due()).toBeUndefined();
  });

  test("tool note is the second fallback slot", () => {
    const { r, set } = replayWithClock();
    r.visible("progress", "bash: ls -la");
    set(10_000);
    expect(r.due()).toBe("bash: ls -la");
  });

  test("narration wins over tool note when both are available", () => {
    const { r, set } = replayWithClock();
    r.visible("progress", "bash: ls -la");
    r.visible("text", "narration line");
    set(10_000);
    expect(r.due()).toBe("narration line");
  });

  test("new narration after an emitted one can replay once more", () => {
    const { r, set } = replayWithClock();
    r.visible("text", "first narration");
    set(10_000);
    expect(r.due()).toBe("first narration");
    set(15_000);
    r.visible("text", "second narration");
    set(30_000);
    expect(r.due()).toBe("second narration");
    set(45_000);
    expect(r.due()).toBeUndefined();
  });

  test("visible text and progress notes reset the quiet window", () => {
    const { r, set } = replayWithClock();
    r.note("some reasoning");
    r.visible("text", "narration");
    set(9_000);
    r.visible("progress", "tool: bash");
    set(18_000); // only 9s since the last VISIBLE output
    expect(r.due()).toBeUndefined();
    set(28_500); // 10.5s since the tool note; min interval long elapsed
    expect(r.due()).toBe("some reasoning");
  });
});

describe("ReasoningReplay — dueIn (engine tick scheduling)", () => {
  test("undefined when nothing can ever emit", () => {
    const { r } = replayWithClock();
    expect(r.dueIn()).toBeUndefined();
  });

  test("positive until the deadline; undefined after a stale-only fallback", () => {
    const { r, set } = replayWithClock();
    r.note("thought");
    expect(r.dueIn()).toBeGreaterThan(0);
    set(10_000);
    r.due(); // emits
    set(12_000);
    expect(r.dueIn()).toBeUndefined(); // nothing pending, no fallback
  });

  test("fresh-but-already-emitted fallback does NOT re-arm (no busy tick loop)", () => {
    const { r, set } = replayWithClock();
    r.visible("text", "narration");
    set(10_000);
    expect(r.due()).toBe("narration");
    set(11_000);
    // Still fresh, but identical to lastEmitted — must not arm a deadline.
    expect(r.dueIn()).toBeUndefined();
  });
});

function replayWithClock(): {
  r: ReasoningReplay;
  set: (ms: number) => void;
} {
  let now = 0;
  const r = new ReasoningReplay(undefined, () => now);
  return { r, set: (ms: number) => (now = ms) };
}

describe("replayChunk + isReasoningCapture", () => {
  test("replayChunk is a payload-less progress row (no tool detail)", () => {
    expect(replayChunk("some reasoning")).toEqual({
      type: "progress",
      note: "some reasoning",
    });
  });
  test("isReasoningCapture discriminates the widened parser result", () => {
    expect(isReasoningCapture({ reasoning: "x" })).toBe(true);
    expect(isReasoningCapture({ type: "heartbeat" })).toBe(false);
    expect(isReasoningCapture(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Engine integration: real subprocess + real timers through runHarnessProcess.
// ---------------------------------------------------------------------------

function baseReq(overrides?: Partial<HarnessRequest>): HarnessRequest {
  return {
    systemPrompt: "test",
    userMessage: "hi",
    history: [],
    idleTimeoutMs: 5_000,
    hardTimeoutMs: 15_000,
    ...overrides,
  };
}

async function collect(
  gen: AsyncIterable<HarnessChunk>,
): Promise<HarnessChunk[]> {
  const out: HarnessChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

describe("runHarnessProcess — narration-decay replay (issue #551)", () => {
  const cfg = {
    quietWindowMs: 400,
    minIntervalMs: 400,
    fallbackFreshMs: 2_000,
    maxEmitChars: 500,
  };

  test("reasoning deltas replay as progress rows after the quiet window", async () => {
    // Six thinking deltas 200ms apart (quiet stream: heartbeats never reset
    // the quiet window), then a final reply.
    const proc = spawnInNewSession(
      [
        "sh",
        "-c",
        `for i in 1 2 3 4 5 6; do echo "{\\"thinking\\":\\"thought $i\\"}"; sleep 0.2; done; echo "{\\"text\\":\\"final reply\\"}"`,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    function makeParser(p: unknown) {
      const obj = p as Record<string, unknown>;
      if (typeof obj.thinking === "string") {
        return { reasoning: obj.thinking, chunk: { type: "heartbeat" } as const };
      }
      if (typeof obj.text === "string") {
        return { type: "text", text: obj.text } as const;
      }
      return undefined;
    }
    const chunks = await collect(
      runHarnessProcess({
        proc,
        req: baseReq(),
        harnessId: "test",
        parseEvent: (p) => makeParser(p),
        activity: (_p, c) =>
          c.type === "text" || c.type === "done" ? "productive" : "model",
        reasoningReplay: cfg,
        buildDoneMeta: () => ({}),
      }),
    );
    const replays = chunks.filter(
      (c) => c.type === "progress" && (c as { note?: string }).note?.startsWith("thought "),
    ) as { type: "progress"; note: string }[];
    // 1.2s of thinking with a 400ms window → several bounded emissions,
    // each carrying NEW reasoning (no duplicates).
    expect(replays.length).toBeGreaterThanOrEqual(2);
    const notes = replays.map((c) => c.note);
    expect(new Set(notes).size).toBe(notes.length);
    // Each emission is model text: either a single delta or a joined run of
    // consecutive deltas (the accumulates-fragments contract).
    expect(notes.every((n) => /^(thought \d)( thought \d)*$/.test(n))).toBe(true);
    // Reasoning NEVER lands in the reply text.
    const texts = chunks.filter((c) => c.type === "text");
    expect(texts).toEqual([{ type: "text", text: "final reply" }]);
    expect(chunks.at(-1)).toMatchObject({ type: "done", finalText: "final reply" });
  });

  test("no repeated emission without new reasoning (stale line stays silent)", async () => {
    // One thinking delta, then 1.5s of true silence (idle timeout 5s keeps
    // the process alive), then the reply. Exactly ONE replay must fire.
    const proc = spawnInNewSession(
      [
        "sh",
        "-c",
        `echo "{\\"thinking\\":\\"only thought\\"}"; sleep 1.2; echo "{\\"text\\":\\"done\\"}"`,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    const chunks = await collect(
      runHarnessProcess({
        proc,
        req: baseReq(),
        harnessId: "test",
        parseEvent: (p) => {
          const obj = p as Record<string, unknown>;
          if (typeof obj.thinking === "string") {
            return { reasoning: obj.thinking, chunk: { type: "heartbeat" } as const };
          }
          if (typeof obj.text === "string") {
            return { type: "text", text: obj.text } as const;
          }
          return undefined;
        },
        activity: (_p, c) =>
          c.type === "text" || c.type === "done" ? "productive" : "model",
        reasoningReplay: cfg,
        buildDoneMeta: () => ({}),
      }),
    );
    const replays = chunks.filter(
      (c) => c.type === "progress" && (c as { note?: string }).note === "only thought",
    );
    expect(replays).toHaveLength(1);
  });

  test("redacted_thinking turns fall back to fresh narration, exactly once", async () => {
    // Narration streams, then only unreadable "redacted" events (no reasoning
    // capture), then the reply. The narration replays once after the quiet
    // window and never again.
    const proc = spawnInNewSession(
      [
        "sh",
        "-c",
        `echo "{\\"text\\":\\"checking the thing\\"}"; sleep 0.3; echo "{\\"redacted\\":true}"; sleep 0.3; echo "{\\"redacted\\":true}"; sleep 0.8; echo "{\\"text\\":\\"done\\"}"`,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    const chunks = await collect(
      runHarnessProcess({
        proc,
        req: baseReq(),
        harnessId: "test",
        parseEvent: (p) => {
          const obj = p as Record<string, unknown>;
          if (obj.redacted === true) return { type: "heartbeat" } as const;
          if (typeof obj.text === "string") {
            return { type: "text", text: obj.text } as const;
          }
          return undefined;
        },
        activity: (_p, c) =>
          c.type === "text" || c.type === "done" ? "productive" : "model",
        reasoningReplay: cfg,
        buildDoneMeta: () => ({}),
      }),
    );
    const replays = chunks.filter(
      (c) =>
        c.type === "progress" &&
        (c as { note?: string }).note === "checking the thing",
    );
    expect(replays).toHaveLength(1);
  });

  test("without reasoningReplay the legacy path is unchanged", async () => {
    const proc = spawnInNewSession(
      ["sh", "-c", `echo "{\\"thinking\\":\\"secret thought\\"}"; echo "{\\"text\\":\\"hi\\"}"`],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    const chunks = await collect(
      runHarnessProcess({
        proc,
        req: baseReq(),
        harnessId: "test",
        // Same capture-capable parser, but no spec.reasoningReplay → capture
        // chunks must behave exactly like their inner chunk (heartbeat).
        parseEvent: (p) => {
          const obj = p as Record<string, unknown>;
          if (typeof obj.thinking === "string") {
            return { reasoning: obj.thinking, chunk: { type: "heartbeat" } as const };
          }
          if (typeof obj.text === "string") {
            return { type: "text", text: obj.text } as const;
          }
          return undefined;
        },
        activity: (_p, c) =>
          c.type === "text" || c.type === "done" ? "productive" : "model",
        buildDoneMeta: () => ({}),
      }),
    );
    expect(chunks.filter((c) => c.type === "progress")).toHaveLength(0);
    expect(chunks.at(-1)).toMatchObject({ type: "done", finalText: "hi" });
  });
});