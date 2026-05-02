/**
 * Tests for the always-on credential discovery + hygiene section.
 *
 * Lives in every persona's system prompt — same rationale as the memory
 * tools section. The agent must consistently know where to look for
 * credentials and how to persist new ones, regardless of which persona
 * is loaded.
 */

import { describe, expect, test } from "bun:test";
import {
  CREDENTIALS_SECTION,
  buildSystemPrompt,
} from "../src/persona/builder.ts";

const channelCtx = {
  channel: "cli",
  conversationId: "cli:default",
  timestamp: new Date("2026-05-02T12:00:00Z"),
};

describe("buildSystemPrompt — credentials section", () => {
  test("always appends the credentials section", () => {
    const prompt = buildSystemPrompt(
      { boot: "I am test", identitySource: "BOOT.md" },
      channelCtx,
    );
    expect(prompt).toContain("# Credentials");
    expect(prompt).toContain("Discovery");
    expect(prompt).toContain("Hygiene");
  });

  test("documents the discovery order with ~/.env first", () => {
    expect(CREDENTIALS_SECTION).toContain("process.env");
    expect(CREDENTIALS_SECTION).toContain("~/.env");
    expect(CREDENTIALS_SECTION).toContain("~/.ssh/");
    expect(CREDENTIALS_SECTION).toContain("~/.bashrc");
    expect(CREDENTIALS_SECTION).toContain("phantombot memory search");
  });

  test("documents the env-set/get/list/unset CLI as the safe-write path", () => {
    expect(CREDENTIALS_SECTION).toContain("phantombot env set");
    expect(CREDENTIALS_SECTION).toContain("phantombot env get");
    expect(CREDENTIALS_SECTION).toContain("phantombot env list");
    expect(CREDENTIALS_SECTION).toContain("phantombot env unset");
  });

  test("explicitly forbids `echo … >> ~/.env`", () => {
    expect(CREDENTIALS_SECTION).toMatch(/NEVER `echo.*>> ~\/\.env`/);
  });

  test("forbids echoing values back (acknowledge by name only)", () => {
    expect(CREDENTIALS_SECTION).toContain("ACKNOWLEDGE BY NAME ONLY");
    expect(CREDENTIALS_SECTION).toContain("Do not\necho the value back");
  });

  test("documents phantombot notify for scheduled-task notification", () => {
    expect(CREDENTIALS_SECTION).toContain("phantombot notify");
    expect(CREDENTIALS_SECTION).toContain("--message");
    expect(CREDENTIALS_SECTION).toContain("--voice");
    expect(CREDENTIALS_SECTION).toContain("silently by default");
  });

  test("credentials section comes after the memory tools section", () => {
    const prompt = buildSystemPrompt(
      { boot: "I am test", identitySource: "BOOT.md" },
      channelCtx,
    );
    const memIdx = prompt.indexOf("# Memory tools");
    const credIdx = prompt.indexOf("# Credentials");
    expect(memIdx).toBeGreaterThan(-1);
    expect(credIdx).toBeGreaterThan(-1);
    expect(credIdx).toBeGreaterThan(memIdx);
  });

  test("persona-supplied tools.md still comes BEFORE both built-in sections", () => {
    const prompt = buildSystemPrompt(
      {
        boot: "I am test",
        identitySource: "BOOT.md",
        tools: "Use the kettle.",
        toolsSource: "tools.md",
      },
      channelCtx,
    );
    const toolsIdx = prompt.indexOf("# Tools available to you");
    const memIdx = prompt.indexOf("# Memory tools");
    const credIdx = prompt.indexOf("# Credentials");
    expect(toolsIdx).toBeLessThan(memIdx);
    expect(toolsIdx).toBeLessThan(credIdx);
  });
});
