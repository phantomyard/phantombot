/**
 * Tests for the always-on Memory tools section in buildSystemPrompt.
 */

import { describe, expect, test } from "bun:test";
import {
  MEMORY_TOOLS_SECTION,
  buildSystemPrompt,
} from "../src/persona/builder.ts";

const channelCtx = {
  channel: "cli",
  conversationId: "cli:default",
  timestamp: new Date("2026-05-02T12:00:00Z"),
};

describe("buildSystemPrompt — memory tools section", () => {
  test("always appends the memory tools section", () => {
    const prompt = buildSystemPrompt(
      { boot: "I am test", identitySource: "BOOT.md" },
      channelCtx,
    );
    expect(prompt).toContain("# Memory tools");
    expect(prompt).toContain("phantombot memory search");
    expect(prompt).toContain("SEARCH BEFORE DEBUGGING");
    expect(prompt).toContain("CAPTURE AS YOU GO");
  });

  test("memory tools section comes after persona-supplied tools.md", () => {
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
    const mi = prompt.indexOf("# Memory tools");
    expect(ti).toBeGreaterThan(0);
    expect(mi).toBeGreaterThan(ti);
  });

  test("MEMORY_TOOLS_SECTION mentions the heartbeat + nightly cadence", () => {
    expect(MEMORY_TOOLS_SECTION).toContain("heartbeat");
    expect(MEMORY_TOOLS_SECTION).toContain("nightly");
  });
});
