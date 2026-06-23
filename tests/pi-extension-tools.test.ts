/**
 * Tests for the capability-routing Pi extension's pure registration logic.
 * We test `planRouting` (which decides which tools register) directly, without
 * the @earendil-works Pi SDK on the import path — the extension's index.ts
 * (the SDK glue + routing.json read) is verified manually against a live pi via
 * /reload. `planRouting` now takes the parsed routing.json config object.
 */
import { describe, expect, test } from "bun:test";
import {
  coderDelegationPrompt,
  imageDelegationPrompt,
  planRouting,
} from "../pi-extension/capability-routing/tools.ts";
import {
  buildProgress,
  formatProgressLines,
  formatToolCall,
  isTerminalStop,
  notifyArgs,
  ProgressBatcher,
  toolCallsOf,
  type DelegateProgress,
  type IdleScheduler,
  type Message,
} from "../pi-extension/capability-routing/spawnPi.ts";

describe("notifyArgs — persona-scoped progress delivery", () => {
  test("forwards --persona when PHANTOMBOT_PERSONA is set", () => {
    expect(notifyArgs("lena", "doing the thing")).toEqual([
      "notify",
      "--persona",
      "lena",
      "--message",
      "doing the thing",
    ]);
  });

  test("omits --persona when persona is unset (single-persona host)", () => {
    expect(notifyArgs(undefined, "doing the thing")).toEqual([
      "notify",
      "--message",
      "doing the thing",
    ]);
  });
});

describe("planRouting — tool registration decisions", () => {
  test("registers both tools when image and coding models are set", () => {
    const plan = planRouting({
      primaryModel: "deepseek-v4-pro",
      imageModel: "gpt-4o",
      codingModel: "gpt-5.2-codex",
    });
    expect(plan.registerLookAtImage).toBe(true);
    expect(plan.registerCoder).toBe(true);
    expect(plan.imageModel).toBe("gpt-4o");
    expect(plan.codingModel).toBe("gpt-5.2-codex");
  });

  test("does NOT register look_at_image when image model is unset (multimodal primary)", () => {
    const plan = planRouting({
      primaryModel: "gpt-5.2",
      codingModel: "gpt-5.2-codex",
      // no imageModel — primary is multimodal
    });
    expect(plan.registerLookAtImage).toBe(false);
    expect(plan.registerCoder).toBe(true);
  });

  test("treats empty string as unset", () => {
    const plan = planRouting({
      imageModel: "",
      codingModel: "   ",
    });
    expect(plan.registerLookAtImage).toBe(false);
    expect(plan.registerCoder).toBe(false);
  });

  test("registers nothing when no models are set", () => {
    const plan = planRouting({});
    expect(plan.registerLookAtImage).toBe(false);
    expect(plan.registerCoder).toBe(false);
    expect(plan.primaryModel).toBeUndefined();
    expect(plan.streamCoderProgress).toBe(false);
  });
});

describe("planRouting — coder progress streaming", () => {
  test("streams when codingProgress is true AND a coding model is set", () => {
    const plan = planRouting({
      codingModel: "gpt-5.2-codex",
      codingProgress: true,
    });
    expect(plan.registerCoder).toBe(true);
    expect(plan.streamCoderProgress).toBe(true);
  });

  test("does NOT stream when codingProgress is true but no coding model", () => {
    // progress without a coder tool is meaningless — force-decoupled
    const plan = planRouting({ codingProgress: true });
    expect(plan.registerCoder).toBe(false);
    expect(plan.streamCoderProgress).toBe(false);
  });

  test("streams by DEFAULT when codingProgress is unset but a coding model is set", () => {
    // On by default: a coding model with no explicit flag now streams.
    expect(planRouting({ codingModel: "x" }).streamCoderProgress).toBe(true);
  });

  test("an explicit false wins over the default-on", () => {
    expect(
      planRouting({ codingModel: "x", codingProgress: false }).streamCoderProgress,
    ).toBe(false);
  });
});

describe("delegation prompts", () => {
  test("image prompt is question-driven and embeds path + question", () => {
    const prompt = imageDelegationPrompt("/tmp/x.png", "How many people are in this photo?");
    expect(prompt).toContain("/tmp/x.png");
    expect(prompt).toContain("How many people are in this photo?");
    expect(prompt).toContain("answer the question");
  });

  test("coder prompt signals coarse-grained / fresh-process semantics", () => {
    const prompt = coderDelegationPrompt("Add input validation to the API.");
    expect(prompt).toContain("Add input validation to the API.");
    expect(prompt.toLowerCase()).toContain("coarse-grained");
    expect(prompt).toContain("edit, bash, and write");
  });
});

describe("coder progress — terminal vs tool-use continuation", () => {
  // Pi sets a stopReason on EVERY assistant turn. Tool-use continuation turns
  // (edit/bash/write) carry "toolUse"; the run only truly ends with "stop",
  // "length", or an error/abort. The progress sink drops terminal turns, so
  // mis-flagging a toolUse turn as terminal silently swallows the progress.
  // Minimal assistant-message shape cast to buildProgress's param type — keeps
  // this test free of the host Pi SDK (not on the import path; see file header).
  const assistant = (stopReason: string | undefined, parts: unknown[]) =>
    ({ role: "assistant", content: parts, stopReason }) as unknown as Parameters<
      typeof buildProgress
    >[0];

  test("a toolUse turn is NOT terminal — it gets reported", () => {
    const ev = buildProgress(
      assistant("toolUse", [
        { type: "text", text: "Patching the validation path" },
        { type: "tool_use", name: "edit" },
        { type: "tool_use", name: "bash" },
      ]),
      3,
    );
    expect(ev.terminal).toBe(false); // sink forwards it ⇒ notifies
    expect(ev.turn).toBe(3);
    expect(ev.text).toBe("Patching the validation path");
    expect(ev.toolCalls.map((c) => c.name)).toEqual(["edit", "bash"]);
  });

  test("the final answer (stop) IS terminal — sink skips it", () => {
    const ev = buildProgress(assistant("stop", [{ type: "text", text: "Done." }]), 5);
    expect(ev.terminal).toBe(true);
  });

  test("length / error / aborted are terminal; bare classifier agrees", () => {
    expect(buildProgress(assistant("length", []), 1).terminal).toBe(true);
    expect(buildProgress(assistant("error", []), 1).terminal).toBe(true);
    expect(buildProgress(assistant("aborted", []), 1).terminal).toBe(true);

    expect(isTerminalStop("toolUse")).toBe(false);
    expect(isTerminalStop("stop")).toBe(true);
    expect(isTerminalStop(undefined)).toBe(false); // in-flight turn, no reason yet
  });
});

// ---------------------------------------------------------------------------
// Readable formatting (Option 3): tool calls carry their input
// ---------------------------------------------------------------------------

describe("toolCallsOf — captures name + input", () => {
  const msg = (parts: unknown[]) =>
    ({ role: "assistant", content: parts }) as unknown as Message;

  test("captures input objects, ignoring text parts", () => {
    const calls = toolCallsOf(
      msg([
        { type: "text", text: "narration" },
        { type: "tool_use", name: "edit", input: { file_path: "/a/auth.ts" } },
        { type: "tool_use", name: "bash", input: { command: "npm test" } },
      ]),
    );
    expect(calls).toEqual([
      { name: "edit", input: { file_path: "/a/auth.ts" } },
      { name: "bash", input: { command: "npm test" } },
    ]);
  });

  test("tolerates alternate field names (toolName / arguments) and missing input", () => {
    const calls = toolCallsOf(
      msg([
        { type: "tool_use", toolName: "write", arguments: { path: "x.ts" } },
        { type: "tool_use", name: "read" }, // no input at all
      ]),
    );
    expect(calls[0]).toEqual({ name: "write", input: { path: "x.ts" } });
    expect(calls[1]).toEqual({ name: "read", input: undefined });
  });

  test("non-object input is dropped rather than crashing", () => {
    const calls = toolCallsOf(
      msg([{ type: "tool_use", name: "bash", input: "not an object" }]),
    );
    expect(calls).toEqual([{ name: "bash", input: undefined }]);
  });
});

describe("formatToolCall — friendly verb + meaningful arg", () => {
  test("edit / write / read render the file basename", () => {
    expect(formatToolCall({ name: "edit", input: { file_path: "/repo/src/auth.ts" } })).toBe(
      "✏️ edit auth.ts",
    );
    expect(formatToolCall({ name: "write", input: { file_path: "routing.json" } })).toBe(
      "📝 write routing.json",
    );
    expect(formatToolCall({ name: "read", input: { path: "/etc/config.toml" } })).toBe(
      "📖 read config.toml",
    );
  });

  test("bash renders the command snippet", () => {
    expect(formatToolCall({ name: "bash", input: { command: "npm test" } })).toBe(
      "⚡ bash: npm test",
    );
  });

  test("long args are truncated with an ellipsis", () => {
    const out = formatToolCall({
      name: "bash",
      input: { command: "x".repeat(200) },
    });
    expect(out.length).toBeLessThan(80);
    expect(out).toContain("…");
  });

  test("unknown tools fall back to a wrench + first renderable arg", () => {
    expect(formatToolCall({ name: "frobnicate", input: { url: "https://x" } })).toBe(
      "🔧 frobnicate: https://x",
    );
    expect(formatToolCall({ name: "mystery" })).toBe("🔧 mystery");
  });

  test("missing input never crashes", () => {
    expect(formatToolCall({ name: "edit" })).toBe("✏️ edit");
    expect(formatToolCall({ name: "bash" })).toBe("⚡ bash");
  });
});

describe("formatProgressLines — narration + tool digest", () => {
  const ev = (over: Partial<DelegateProgress>): DelegateProgress => ({
    turn: 1,
    text: undefined,
    toolCalls: [],
    terminal: false,
    ...over,
  });

  test("leads with narration appended to the first tool line", () => {
    const lines = formatProgressLines(
      ev({
        text: "adding the retry guard",
        toolCalls: [
          { name: "edit", input: { file_path: "auth.ts" } },
          { name: "bash", input: { command: "npm test" } },
        ],
      }),
    );
    expect(lines).toEqual([
      '✏️ edit auth.ts — "adding the retry guard"',
      "⚡ bash: npm test",
    ]);
  });

  test("pure-tool turn (no narration) is just verb+arg lines", () => {
    const lines = formatProgressLines(
      ev({ toolCalls: [{ name: "write", input: { file_path: "routing.json" } }] }),
    );
    expect(lines).toEqual(["📝 write routing.json"]);
  });

  test("narration-only turn renders a speech line", () => {
    expect(formatProgressLines(ev({ text: "Let me think about this" }))).toEqual([
      "💬 Let me think about this",
    ]);
  });

  test("empty turn yields no lines (caller skips it)", () => {
    expect(formatProgressLines(ev({}))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Hybrid batching (Option C): flush on idle OR line-cap, drain at end
// ---------------------------------------------------------------------------

/** Manual scheduler: holds the pending idle callback so tests can fire it. */
class ManualScheduler implements IdleScheduler {
  pending: (() => void) | undefined;
  lastMs: number | undefined;
  schedule(ms: number, fn: () => void): { cancel(): void } {
    this.lastMs = ms;
    this.pending = fn;
    return {
      cancel: () => {
        this.pending = undefined;
      },
    };
  }
  fire(): void {
    const fn = this.pending;
    this.pending = undefined;
    fn?.();
  }
}

describe("ProgressBatcher — hybrid flush", () => {
  test("flushes ONE digest when the idle timer fires", () => {
    const sched = new ManualScheduler();
    const emitted: string[] = [];
    const b = new ProgressBatcher({
      maxLines: 10,
      idleMs: 5000,
      emit: (body) => emitted.push(body),
      scheduler: sched,
      flushFirst: false,
    });
    b.add(["✏️ edit auth.ts", "⚡ bash: npm test"]);
    expect(emitted).toEqual([]); // nothing yet — waiting for idle
    expect(sched.lastMs).toBe(5000);
    sched.fire(); // coder went idle
    expect(emitted).toEqual(["✏️ edit auth.ts\n⚡ bash: npm test"]);
    expect(b.size).toBe(0);
  });

  test("flushes early when the buffer hits the line cap (whichever first)", () => {
    const sched = new ManualScheduler();
    const emitted: string[] = [];
    const b = new ProgressBatcher({
      maxLines: 3,
      idleMs: 5000,
      emit: (body) => emitted.push(body),
      scheduler: sched,
      flushFirst: false,
    });
    b.add(["a", "b"]);
    expect(emitted).toEqual([]); // 2 < 3, still buffering
    b.add(["c"]); // hits the cap → immediate flush
    expect(emitted).toEqual(["a\nb\nc"]);
    // The idle timer was cancelled by the cap flush — firing it is a no-op.
    sched.fire();
    expect(emitted).toEqual(["a\nb\nc"]);
  });

  test("drain() flushes the remaining tail so nothing is lost at the end", () => {
    const sched = new ManualScheduler();
    const emitted: string[] = [];
    const b = new ProgressBatcher({
      maxLines: 10,
      idleMs: 5000,
      emit: (body) => emitted.push(body),
      scheduler: sched,
      flushFirst: false,
    });
    b.add(["📝 write routing.json"]);
    b.drain();
    expect(emitted).toEqual(["📝 write routing.json"]);
  });

  test("drain() on an empty buffer emits nothing", () => {
    const emitted: string[] = [];
    const b = new ProgressBatcher({
      maxLines: 10,
      idleMs: 5000,
      emit: (body) => emitted.push(body),
      scheduler: new ManualScheduler(),
    });
    b.drain();
    expect(emitted).toEqual([]);
  });

  test("adding nothing is a no-op (empty turns don't arm a timer)", () => {
    const sched = new ManualScheduler();
    const emitted: string[] = [];
    const b = new ProgressBatcher({
      maxLines: 10,
      idleMs: 5000,
      emit: (body) => emitted.push(body),
      scheduler: sched,
    });
    b.add([]);
    expect(sched.pending).toBeUndefined();
    expect(emitted).toEqual([]);
  });

  test("flushFirst (default): first add flushes immediately as the start signal", () => {
    const sched = new ManualScheduler();
    const emitted: string[] = [];
    const b = new ProgressBatcher({
      maxLines: 10,
      idleMs: 5000,
      emit: (body) => emitted.push(body),
      scheduler: sched,
      // flushFirst defaults to true
    });
    b.add(["⚡ bash: npm test"]);
    // Immediate — no waiting for idle/cap on the very first batch.
    expect(emitted).toEqual(["⚡ bash: npm test"]);
    expect(b.size).toBe(0);
    expect(sched.pending).toBeUndefined();
  });

  test("flushFirst: subsequent adds fall back to digest batching", () => {
    const sched = new ManualScheduler();
    const emitted: string[] = [];
    const b = new ProgressBatcher({
      maxLines: 10,
      idleMs: 5000,
      emit: (body) => emitted.push(body),
      scheduler: sched,
    });
    b.add(["⚡ bash: step 1"]); // first → immediate
    expect(emitted).toEqual(["⚡ bash: step 1"]);
    b.add(["✏️ edit a.ts", "⚡ bash: step 2"]); // now batches
    expect(emitted).toEqual(["⚡ bash: step 1"]); // still buffering
    sched.fire(); // idle
    expect(emitted).toEqual([
      "⚡ bash: step 1",
      "✏️ edit a.ts\n⚡ bash: step 2",
    ]);
  });
});
