/**
 * Tests for the always-on Scheduling tools section in buildSystemPrompt.
 *
 * Companion to persona-builder-memory-tools.test.ts. The scheduling
 * section is the positive half of the CronCreate fix — it teaches every
 * persona to use `phantombot task` and explicitly forbids the
 * harness-native scheduler tools. The negative half (a deny-list passed
 * to claude --settings) is exercised in harnesses-claude.test.ts.
 */

import { describe, expect, test } from "bun:test";
import {
  SCHEDULING_TOOLS_SECTION,
  buildSystemPrompt,
} from "../src/persona/builder.ts";

const channelCtx = {
  channel: "cli",
  conversationId: "cli:default",
  timestamp: new Date("2026-05-06T12:00:00Z"),
};

describe("buildSystemPrompt — scheduling tools section", () => {
  test("always appends the scheduling tools section", () => {
    const prompt = buildSystemPrompt(
      { boot: "I am test", identitySource: "BOOT.md" },
      channelCtx,
    );
    expect(prompt).toContain("# Scheduling tasks");
    expect(prompt).toContain("phantombot task add");
    expect(prompt).toContain("phantombot task list");
    expect(prompt).toContain("phantombot task selftest");
  });

  test("explicitly forbids harness-native scheduler tools by name", () => {
    expect(SCHEDULING_TOOLS_SECTION).toContain("CronCreate");
    expect(SCHEDULING_TOOLS_SECTION).toContain("CronDelete");
    expect(SCHEDULING_TOOLS_SECTION).toContain("CronList");
    // The instruction itself, not just the names.
    expect(SCHEDULING_TOOLS_SECTION).toMatch(/DO NOT use/);
  });

  test("documents optional expiry flags for recurring tasks", () => {
    expect(SCHEDULING_TOOLS_SECTION).toContain("--until");
    expect(SCHEDULING_TOOLS_SECTION).toContain("--count");
    expect(SCHEDULING_TOOLS_SECTION).toContain("--for");
    // The new contract: expiry is OPTIONAL, not REQUIRED. The agent
    // self-polices via the hygiene footer instead of being blocked
    // at scheduling time.
    expect(SCHEDULING_TOOLS_SECTION).toMatch(/optional|without an expiry|self-polic/i);
  });

  test("documents the agent self-policing hygiene contract", () => {
    // Forever-recurring tasks (no --until/--count/--for) get a footer
    // appended to every fire that asks the agent whether the task is
    // still useful and provides the exact cancel command.
    expect(SCHEDULING_TOOLS_SECTION).toMatch(/Task hygiene/);
    expect(SCHEDULING_TOOLS_SECTION).toContain("phantombot task cancel");
  });

  test("documents the two-positional signature (prompt + description)", () => {
    // Old docs only showed `phantombot task add "<prompt>" --in 10m` which
    // failed at the CLI because <description> is also required. The new
    // examples must show both positionals.
    expect(SCHEDULING_TOOLS_SECTION).toContain('"<prompt>" "<description>"');
  });

  test("documents the proof-of-creation echo contract", () => {
    // The CLI echoes "task <id> scheduled" — the persona must repeat
    // that verbatim. This is the audit trail that defeats hallucinated
    // schedules.
    expect(SCHEDULING_TOOLS_SECTION).toMatch(/task <id> scheduled/);
    expect(SCHEDULING_TOOLS_SECTION).toMatch(/proof[- ]of[- ]creation/);
  });

  test("scheduling section comes after persona-supplied tools.md", () => {
    const prompt = buildSystemPrompt(
      {
        boot: "I am test",
        identitySource: "BOOT.md",
        tools: "Use the kettle in the kitchen.",
        toolsSource: "tools.md",
      },
      channelCtx,
    );
    const ti = prompt.indexOf("# Tools available to you");
    const si = prompt.indexOf("# Scheduling tasks");
    expect(ti).toBeGreaterThan(0);
    expect(si).toBeGreaterThan(ti);
  });

  test("scheduling section sits between memory and credentials sections", () => {
    // Order matters for caching: stable persona/memory/tools first, then
    // the system-level injections in a deterministic order.
    const prompt = buildSystemPrompt(
      { boot: "I am test", identitySource: "BOOT.md" },
      channelCtx,
    );
    const memoryIdx = prompt.indexOf("# Memory tools");
    const schedIdx = prompt.indexOf("# Scheduling tasks");
    const credIdx = prompt.indexOf("# Credentials");
    expect(memoryIdx).toBeGreaterThan(0);
    expect(schedIdx).toBeGreaterThan(memoryIdx);
    expect(credIdx).toBeGreaterThan(schedIdx);
  });
});
