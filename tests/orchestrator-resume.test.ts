/**
 * Resume-with-context (issue #459).
 *
 * The bug being fixed, concretely: a pi-only persona (chain = ["pi"]) streams
 * narration, starts a tool call, then the provider wedges; the idle watchdog
 * kills it and the turn is DROPPED — pi's coder ladder declines to retry an
 * attempt that produced output, and a single-entry chain has no next harness.
 *
 * These tests pin both halves of the contract: the recovery fires exactly when
 * it is safe to fire, and the preamble it carries tells the model the truth
 * about what may or may not have applied.
 */

import { describe, expect, test } from "bun:test";
import { runWithFallback } from "../src/orchestrator/fallback.ts";
import {
  buildResumePreamble,
  buildResumeRequest,
  MAX_RESUME_ATTEMPTS,
  PartialAttempt,
  shouldResume,
} from "../src/orchestrator/resume.ts";
import { CooldownStore } from "../src/lib/cooldown.ts";
import { HarnessAlerter } from "../src/lib/harnessAlert.ts";
import type {
  Harness,
  HarnessChunk,
  HarnessRequest,
} from "../src/harnesses/types.ts";

const idleKill = (id = "pi"): HarnessChunk => ({
  type: "error",
  error: `${id} timed out after 300000ms with no output (likely wedged on a tool call)`,
  recoverable: true,
  killCause: "idle",
});

const hardCapKill = (id = "pi"): HarnessChunk => ({
  type: "error",
  error: `${id} timed out after 3600000ms (hard cap)`,
  recoverable: true,
  killCause: "timeout",
});

/**
 * A harness that plays a different script per invocation, and records the
 * request it was handed each time — which is how we assert that the SECOND
 * invocation carried the recovery preamble.
 */
class ScriptedHarness implements Harness {
  readonly requests: HarnessRequest[] = [];
  constructor(
    public readonly id: string,
    private readonly scripts: HarnessChunk[][],
  ) {}
  get invocations(): number {
    return this.requests.length;
  }
  async available(): Promise<boolean> {
    return true;
  }
  async *invoke(req: HarnessRequest): AsyncGenerator<HarnessChunk> {
    this.requests.push(req);
    const script =
      this.scripts[this.requests.length - 1] ?? this.scripts.at(-1) ?? [];
    for (const c of script) yield c;
  }
}

function newRequest(overrides: Partial<HarnessRequest> = {}): HarnessRequest {
  return {
    systemPrompt: "system prompt",
    userMessage: "get the PR ready",
    history: [],
    idleTimeoutMs: 300_000,
    ...overrides,
  };
}

async function collect(
  iter: AsyncIterable<HarnessChunk>,
): Promise<HarnessChunk[]> {
  const out: HarnessChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

const opts = () => ({
  cooldown: new CooldownStore(),
  alerter: new HarnessAlerter(),
});

describe("PartialAttempt — the chunk log a resume is built from", () => {
  test("heartbeats alone are not output — nothing to resume from", () => {
    const p = new PartialAttempt();
    p.record({ type: "heartbeat" });
    p.record({ type: "heartbeat" });
    expect(p.producedOutput).toBe(false);
  });

  test("streamed text counts as output and is carried", () => {
    const p = new PartialAttempt();
    p.record({ type: "text", text: "Checking the " });
    p.record({ type: "text", text: "release notes..." });
    expect(p.producedOutput).toBe(true);
    expect(p.text).toBe("Checking the release notes...");
  });

  test("a structured tool call counts as output even with no text at all", () => {
    const p = new PartialAttempt();
    p.record({
      type: "progress",
      note: "tool: Bash",
      tool: { title: "Bash: git status", kind: "execute", locations: [] },
    });
    expect(p.producedOutput).toBe(true);
    expect(p.toolCalls).toEqual(["Bash: git status"]);
  });

  test("the structured tool title is what the preamble quotes", () => {
    const p = new PartialAttempt();
    p.record({
      type: "progress",
      note: "tool: Bash",
      tool: { title: "Bash: gh pr create", kind: "execute", locations: [] },
    });
    expect(p.toolCalls).toEqual(["Bash: gh pr create"]);
  });

  test("progress WITHOUT a tool is not a tool call and is not output", () => {
    // The chunk contract allows bare `progress` for diagnostics and liveness
    // lines. Counting one as a started tool call would both steal the turn
    // from the cheaper no-output fall-through and tell the model a version
    // warning "may or may not have applied".
    const p = new PartialAttempt();
    p.record({ type: "progress", note: "warning: pi 0.9.1 is out of date" });
    p.record({ type: "progress", note: "still working" });
    expect(p.producedOutput).toBe(false);
    expect(p.toolCalls).toEqual([]);
    expect(p.nonToolProgress).toBe(2);
  });

  test("a bare diagnostic line does NOT trigger a resume", () => {
    const p = new PartialAttempt();
    p.record({ type: "progress", note: "warning: pi 0.9.1 is out of date" });
    expect(shouldResume(idleKill(), p, 0)).toBe(false);
  });

  test("empty tool titles are ignored, not listed as a blank call", () => {
    const p = new PartialAttempt();
    p.record({
      type: "progress",
      note: "tool: Bash",
      tool: { title: "   ", kind: "execute", locations: [] },
    });
    expect(p.producedOutput).toBe(false);
    expect(p.toolCalls).toEqual([]);
  });

  test("rawText keeps the full untruncated stream for done reconciliation", () => {
    const p = new PartialAttempt();
    p.record({ type: "text", text: "x".repeat(3_000) });
    expect(p.rawText.length).toBe(3_000);
    expect(p.text.length).toBeLessThan(2_100);
  });

  test("narration is tail-truncated — the newest context is what matters", () => {
    const p = new PartialAttempt();
    p.record({ type: "text", text: "x".repeat(3_000) + "TAIL" });
    expect(p.text.length).toBeLessThan(2_100);
    expect(p.text.endsWith("TAIL")).toBe(true);
    expect(p.text.startsWith("…")).toBe(true);
  });

  test("tool list is capped and the overflow is counted, not silently lost", () => {
    const p = new PartialAttempt();
    for (let i = 0; i < 25; i++) {
      p.record({ type: "progress", note: "tool: Bash", tool: { title: `Bash: step ${i}`, kind: "execute", locations: [] } });
    }
    expect(p.toolCalls.length).toBe(20);
    expect(p.droppedToolCalls).toBe(5);
    expect(buildResumePreamble(p)).toContain("and 5 more");
  });

  test("done chunks are not narration — a completed turn never resumes", () => {
    const p = new PartialAttempt();
    p.record({ type: "done", finalText: "all done" });
    expect(p.producedOutput).toBe(false);
  });
});

describe("shouldResume — when recovery is allowed to fire", () => {
  const withOutput = () => {
    const p = new PartialAttempt();
    p.record({ type: "text", text: "working on it" });
    return p;
  };

  test("idle kill after output, budget unused → resume", () => {
    expect(shouldResume(idleKill(), withOutput(), 0)).toBe(true);
  });

  test("idle kill with no output → no resume (the plain chain owns that)", () => {
    expect(shouldResume(idleKill(), new PartialAttempt(), 0)).toBe(false);
  });

  test("hard-cap timeout → no resume, the final timer stays final", () => {
    expect(shouldResume(hardCapKill(), withOutput(), 0)).toBe(false);
  });

  test("startup kill → no resume", () => {
    expect(
      shouldResume(
        { type: "error", error: "no output", recoverable: true, killCause: "startup" },
        withOutput(),
        0,
      ),
    ).toBe(false);
  });

  test("user abort → no resume, /stop means stop", () => {
    expect(
      shouldResume(
        { type: "error", error: "stopped", recoverable: false, killCause: "aborted" },
        withOutput(),
        0,
      ),
    ).toBe(false);
  });

  test("policy tripwire → no resume", () => {
    expect(
      shouldResume(
        {
          type: "error",
          error: "pi killed by policy tripwire",
          recoverable: true,
          terminal: true,
          killCause: "policy",
        },
        withOutput(),
        0,
      ),
    ).toBe(false);
  });

  test("an error with no killCause (exit code, 4XX) → no resume", () => {
    expect(
      shouldResume(
        { type: "error", error: "pi exited with code 1", recoverable: true },
        withOutput(),
        0,
      ),
    ).toBe(false);
  });

  test("budget spent → no second resume", () => {
    expect(shouldResume(idleKill(), withOutput(), MAX_RESUME_ATTEMPTS)).toBe(
      false,
    );
  });

  test("non-error chunks never trigger it", () => {
    expect(shouldResume({ type: "text", text: "hi" }, withOutput(), 0)).toBe(
      false,
    );
  });
});

describe("the recovery preamble", () => {
  const partial = () => {
    const p = new PartialAttempt();
    p.record({ type: "text", text: "Pushing the branch now." });
    p.record({ type: "progress", note: "tool: Bash", tool: { title: "Bash: git commit -m 'fix'", kind: "execute", locations: [] } });
    p.record({ type: "progress", note: "tool: Bash", tool: { title: "Bash: git push origin HEAD", kind: "execute", locations: [] } });
    return p;
  };

  test("names the in-flight calls in order", () => {
    const text = buildResumePreamble(partial());
    expect(text).toContain("Bash: git commit -m 'fix'");
    expect(text).toContain("Bash: git push origin HEAD");
    expect(text.indexOf("git commit")).toBeLessThan(text.indexOf("git push"));
  });

  test("says the calls MAY OR MAY NOT have applied — never that they failed", () => {
    const text = buildResumePreamble(partial());
    expect(text).toContain("MAY OR MAY NOT have applied");
    expect(text).toContain("VERIFY the current state");
    expect(text.toLowerCase()).not.toContain("the tool failed");
  });

  test("tells the model its streamed text is already on screen", () => {
    const text = buildResumePreamble(partial());
    expect(text).toContain("Pushing the branch now.");
    expect(text).toContain("do not repeat it");
  });

  test("degrades cleanly when only tool calls were seen, no narration", () => {
    const p = new PartialAttempt();
    p.record({ type: "progress", note: "tool: Bash", tool: { title: "Bash: rm -rf build", kind: "execute", locations: [] } });
    const text = buildResumePreamble(p);
    expect(text).toContain("Bash: rm -rf build");
    expect(text).not.toContain("already streamed this to the user");
  });

  test("degrades cleanly when only narration was seen, no tools", () => {
    const p = new PartialAttempt();
    p.record({ type: "text", text: "Let me look at that." });
    const text = buildResumePreamble(p);
    expect(text).toContain("Let me look at that.");
    expect(text).not.toContain("You had started these tool calls");
  });

  test("the resumed request keeps the original user message, preamble last", () => {
    const req = newRequest({ userMessage: "deploy it" });
    const resumed = buildResumeRequest(req, partial());
    expect(resumed.userMessage.startsWith("deploy it")).toBe(true);
    expect(resumed.userMessage).toContain("automatic recovery");
    // Everything else about the turn is untouched — same history, same caps.
    expect(resumed.systemPrompt).toBe(req.systemPrompt);
    expect(resumed.history).toBe(req.history);
    expect(resumed.idleTimeoutMs).toBe(req.idleTimeoutMs);
    expect(req.userMessage).toBe("deploy it"); // original not mutated
  });
});

describe("runWithFallback — resume-with-context end to end", () => {
  test("the Lena case: single-harness chain, wedged mid-flight, turn recovered", async () => {
    const pi = new ScriptedHarness("pi", [
      [
        { type: "text", text: "Checking the logs..." },
        {
          type: "progress",
          note: "tool: Bash",
          tool: { title: "Bash: journalctl -n 200", kind: "execute", locations: [] },
        },
        idleKill(),
      ],
      [
        { type: "text", text: "Here is what failed." },
        { type: "done", finalText: "Here is what failed." },
      ],
    ]);
    const chunks = await collect(
      runWithFallback([pi], newRequest(), opts()),
    );

    expect(pi.invocations).toBe(2);
    expect(chunks.at(-1)).toMatchObject({ type: "done" });
    // The dropped-turn symptom: an error chunk reaching the channel. Gone.
    expect(chunks.some((c) => c.type === "error")).toBe(false);
  });

  test("the resumed attempt is handed the preamble; the first is not", async () => {
    const pi = new ScriptedHarness("pi", [
      [
        { type: "text", text: "Opening the PR." },
        {
          type: "progress",
          note: "tool: Bash",
          tool: { title: "Bash: gh pr create", kind: "execute", locations: [] },
        },
        idleKill(),
      ],
      [{ type: "done", finalText: "PR is up." }],
    ]);
    await collect(runWithFallback([pi], newRequest(), opts()));

    expect(pi.requests[0]!.userMessage).toBe("get the PR ready");
    const resumed = pi.requests[1]!.userMessage;
    expect(resumed).toContain("get the PR ready");
    expect(resumed).toContain("Bash: gh pr create");
    expect(resumed).toContain("MAY OR MAY NOT have applied");
  });

  test("the terminal done covers BOTH attempts' text, not just the recovery's", async () => {
    // Regression: the stream is `A`, idle kill, `B`, done(B). `finalText` is
    // contracted to be the sum of the slot's text chunks, so a consumer that
    // reads only the terminal chunk (runTurn's persisted message, voice) must
    // still get A+B — and the transports' suffix diff must see a finalText
    // that its own streamed prefix actually matches.
    const pi = new ScriptedHarness("pi", [
      [{ type: "text", text: "Checking the logs... " }, idleKill()],
      [
        { type: "text", text: "Here is what failed." },
        { type: "done", finalText: "Here is what failed." },
      ],
    ]);
    const chunks = await collect(runWithFallback([pi], newRequest(), opts()));

    const streamed = chunks
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("");
    const done = chunks.at(-1) as { type: string; finalText: string };
    expect(done.type).toBe("done");
    expect(done.finalText).toBe("Checking the logs... Here is what failed.");
    expect(done.finalText).toBe(streamed);
  });

  test("stitching keeps the FULL pre-kill text, not the truncated preamble copy", async () => {
    const long = "x".repeat(3_000);
    const pi = new ScriptedHarness("pi", [
      [{ type: "text", text: long }, idleKill()],
      [{ type: "done", finalText: "!" }],
    ]);
    const chunks = await collect(runWithFallback([pi], newRequest(), opts()));
    const done = chunks.at(-1) as { finalText: string };
    expect(done.finalText).toBe(long + "!");
  });

  test("an unresumed slot's done is forwarded untouched", async () => {
    const pi = new ScriptedHarness("pi", [
      [
        { type: "text", text: "all in one go" },
        { type: "done", finalText: "all in one go" },
      ],
    ]);
    const chunks = await collect(runWithFallback([pi], newRequest(), opts()));
    expect(chunks.at(-1)).toMatchObject({
      type: "done",
      finalText: "all in one go",
    });
  });

  test("a resumed slot that ends empty still delivers the pre-kill text", async () => {
    // The recovery came back with nothing of its own. The user has already
    // seen `A`, so the slot has NOT produced an empty reply — treating it as
    // one would hand the turn to the next harness and double the answer.
    const pi = new ScriptedHarness("pi", [
      [{ type: "text", text: "the whole answer" }, idleKill()],
      [{ type: "done", finalText: "" }],
    ]);
    const claude = new ScriptedHarness("claude", [
      [{ type: "done", finalText: "second opinion" }],
    ]);
    const chunks = await collect(
      runWithFallback([pi, claude], newRequest(), opts()),
    );
    expect(claude.invocations).toBe(0);
    expect(chunks.at(-1)).toMatchObject({
      type: "done",
      finalText: "the whole answer",
    });
  });

  test("recovery does not cool the harness off — it answered in the end", async () => {
    const cooldown = new CooldownStore();
    const pi = new ScriptedHarness("pi", [
      [{ type: "text", text: "..." }, idleKill()],
      [{ type: "done", finalText: "done" }],
    ]);
    await collect(
      runWithFallback([pi], newRequest(), { cooldown, alerter: new HarnessAlerter() }),
    );
    expect(cooldown.isCooledDown("pi").cooled).toBe(false);
    expect(cooldown.isCooledDown("pi").consecutiveFailures).toBe(0);
  });

  test("a wedge with no output does NOT resume — it falls through as before", async () => {
    const pi = new ScriptedHarness("pi", [[idleKill()]]);
    const claude = new ScriptedHarness("claude", [
      [{ type: "done", finalText: "covered" }],
    ]);
    const chunks = await collect(
      runWithFallback([pi, claude], newRequest(), opts()),
    );
    expect(pi.invocations).toBe(1);
    expect(claude.invocations).toBe(1);
    expect(chunks.at(-1)).toMatchObject({ type: "done", finalText: "covered" });
  });

  test("resume is preferred over a cold hand-off when a next harness exists", async () => {
    const pi = new ScriptedHarness("pi", [
      [{ type: "text", text: "half an answer" }, idleKill()],
      [{ type: "done", finalText: "finished it" }],
    ]);
    const claude = new ScriptedHarness("claude", [
      [{ type: "done", finalText: "should not be needed" }],
    ]);
    const chunks = await collect(
      runWithFallback([pi, claude], newRequest(), opts()),
    );
    expect(pi.invocations).toBe(2);
    expect(claude.invocations).toBe(0);
    // Stitched: the pre-kill text is part of this slot's reply too.
    expect(chunks.at(-1)).toMatchObject({
      finalText: "half an answerfinished it",
    });
  });

  test("one resume only: a second wedge falls through to the next harness", async () => {
    const pi = new ScriptedHarness("pi", [
      [{ type: "text", text: "try one" }, idleKill()],
      [{ type: "text", text: "try two" }, idleKill()],
    ]);
    const claude = new ScriptedHarness("claude", [
      [{ type: "done", finalText: "claude finished it" }],
    ]);
    const chunks = await collect(
      runWithFallback([pi, claude], newRequest(), opts()),
    );
    expect(pi.invocations).toBe(1 + MAX_RESUME_ATTEMPTS);
    expect(claude.invocations).toBe(1);
    expect(chunks.at(-1)).toMatchObject({ finalText: "claude finished it" });
  });

  test("a second wedge with nowhere left to go still surfaces the error", async () => {
    const pi = new ScriptedHarness("pi", [
      [{ type: "text", text: "try one" }, idleKill()],
      [{ type: "text", text: "try two" }, idleKill()],
    ]);
    const chunks = await collect(runWithFallback([pi], newRequest(), opts()));
    expect(pi.invocations).toBe(1 + MAX_RESUME_ATTEMPTS);
    expect(chunks.at(-1)).toMatchObject({ type: "error", recoverable: true });
  });

  test("a hard-cap kill after output is not resumed — it falls through", async () => {
    const pi = new ScriptedHarness("pi", [
      [{ type: "text", text: "runaway" }, hardCapKill()],
    ]);
    const claude = new ScriptedHarness("claude", [
      [{ type: "done", finalText: "covered" }],
    ]);
    await collect(runWithFallback([pi, claude], newRequest(), opts()));
    expect(pi.invocations).toBe(1);
    expect(claude.invocations).toBe(1);
  });

  test("/stop after output is never resumed", async () => {
    const pi = new ScriptedHarness("pi", [
      [
        { type: "text", text: "starting" },
        {
          type: "error",
          error: "stopped",
          recoverable: false,
          killCause: "aborted",
        },
      ],
    ]);
    const chunks = await collect(runWithFallback([pi], newRequest(), opts()));
    expect(pi.invocations).toBe(1);
    expect(chunks.at(-1)).toMatchObject({ type: "error", error: "stopped" });
  });

  test("tool-call audits from the killed attempt are not replayed by the resume", async () => {
    const seen: string[] = [];
    const pi = new ScriptedHarness("pi", [
      [
        {
          type: "progress",
          note: "Bash: git push",
          tool: { title: "Bash: git push", kind: "execute", locations: [] },
        },
        idleKill(),
      ],
      [{ type: "done", finalText: "ok" }],
    ]);
    await collect(
      runWithFallback([pi], newRequest(), {
        ...opts(),
        onToolCall: (t) => seen.push(t.title),
      }),
    );
    expect(seen).toEqual(["Bash: git push"]);
  });
});
