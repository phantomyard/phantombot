/**
 * Tests for the always-on Memory tools section in buildSystemPrompt.
 */

import { describe, expect, test } from "bun:test";
import { OKF_TYPES } from "../src/lib/okf.ts";
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
    expect(prompt).toContain("SEARCH BEFORE YOU ACT");
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

describe("MEMORY_TOOLS_SECTION — OKF vocabulary", () => {
  test("teaches the required OKF frontmatter fields", () => {
    for (const field of [
      "type:",
      "title:",
      "description:",
      "tags:",
      "aliases:",
      "created:",
      "updated:",
    ]) {
      expect(MEMORY_TOOLS_SECTION).toContain(field);
    }
  });

  test("lists every controlled type, so the prompt cannot drift from okf.ts", () => {
    // The prompt is generated from OKF_TYPES precisely so adding a type in one
    // place can't leave the other stale. This asserts the generation actually
    // happened rather than someone hardcoding a snapshot of the list.
    for (const t of OKF_TYPES) {
      expect(MEMORY_TOOLS_SECTION).toContain(t);
    }
  });

  test("forbids inventing new types", () => {
    expect(MEMORY_TOOLS_SECTION).toContain("do NOT invent a new type");
  });

  test("states that kb/ is private, and never calls it a vault", () => {
    // Regression guard: the prompt used to describe kb/ as an
    // "Obsidian-shaped second brain", which reads as a shareable, human-facing
    // vault. It is neither — it is this persona's private recall.
    expect(MEMORY_TOOLS_SECTION).toContain("your PRIVATE knowledge base");
    expect(MEMORY_TOOLS_SECTION).toContain("kb/ is private to this persona");
    expect(MEMORY_TOOLS_SECTION).toContain("not shared with other");
    expect(MEMORY_TOOLS_SECTION).not.toContain("Obsidian");
  });

  test("explains why aliases and wikilinks matter for recall", () => {
    expect(MEMORY_TOOLS_SECTION).toContain("aliases");
    expect(MEMORY_TOOLS_SECTION).toContain("[[wikilinks]]");
  });
});
