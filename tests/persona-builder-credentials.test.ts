/**
 * Tests for the always-on credential discovery + persistence section.
 *
 * Lives in every persona's system prompt — same rationale as the memory
 * tools section. The agent must consistently know where to look for
 * credentials and how to persist new ones, regardless of which persona
 * is loaded.
 *
 * Framing: the section presents `~/.env` (write via `phantombot env set`)
 * as a *convenience layer*, not a cage. The agent must be free to scan
 * creatively for credentials wherever they live, and to file what's
 * worth keeping. These tests pin both halves: starter spots are
 * documented (fast path), AND the section explicitly licenses
 * follow-your-nose discovery with concrete examples.
 */

import { describe, expect, test } from "bun:test";
import {
  CREDENTIALS_SECTION,
  buildSystemPrompt,
} from "../src/persona/builder.ts";

const channelCtx = {
  channel: "cli",
  conversationId: "cli:default",
  timestamp: new Date("2026-05-07T12:00:00Z"),
};

describe("buildSystemPrompt — credentials section", () => {
  test("always appends the credentials section", () => {
    const prompt = buildSystemPrompt(
      { boot: "I am test", identitySource: "BOOT.md" },
      channelCtx,
    );
    expect(prompt).toContain("# Credentials");
    // The three structural subsections of the new layout.
    expect(prompt).toContain("Where to look first");
    expect(prompt).toContain("Follow your nose");
    expect(prompt).toContain("Persistence");
    expect(prompt).toContain("Last resort");
  });

  test("frames the store as a convenience layer, not a cage", () => {
    // The literal phrase is load-bearing. It's how the agent learns
    // that `phantombot env` is a place to *file* credentials, not a
    // wall around them. If you change the wording, update both here
    // and the persona docs at the same time.
    expect(CREDENTIALS_SECTION).toMatch(/convenience layer/i);
    // Tolerate the possible \n between "not a" and "cage" from prose wrapping.
    expect(CREDENTIALS_SECTION).toMatch(/not a\s+cage/i);
  });

  test("documents the starter-spots fast path with ~/.env, ssh, shell, memory, KB", () => {
    expect(CREDENTIALS_SECTION).toContain("process.env");
    expect(CREDENTIALS_SECTION).toContain("~/.env");
    expect(CREDENTIALS_SECTION).toContain("~/.ssh/");
    expect(CREDENTIALS_SECTION).toContain("~/.bashrc");
    expect(CREDENTIALS_SECTION).toContain("phantombot memory search");
    // Marked as the *fast path*, not an exhaustive prescription.
    expect(CREDENTIALS_SECTION).toMatch(/starter spots/i);
    expect(CREDENTIALS_SECTION).toMatch(/not exhaustive/i);
  });

  test("explicitly licenses follow-your-nose discovery with concrete sources", () => {
    // The whole point of this PR — the agent must understand it's free
    // (and encouraged) to scan beyond the starter list. We pin a few
    // canonical second-tier sources so the message stays concrete.
    expect(CREDENTIALS_SECTION).toMatch(/Follow your nose/i);
    expect(CREDENTIALS_SECTION).toMatch(/git history/i);
    expect(CREDENTIALS_SECTION).toMatch(/keychain|password manager/i);
    expect(CREDENTIALS_SECTION).toMatch(/shell history/i);
    // Resourceful before asking is the explicit instruction.
    expect(CREDENTIALS_SECTION).toMatch(/be resourceful/i);
  });

  test("invites the agent to file credentials it discovers in the wild", () => {
    // Proactive harvest: if the agent finds something useful in the
    // course of other work, save it for next time.
    // Tolerate prose-wrap newlines between the words.
    expect(CREDENTIALS_SECTION).toMatch(/discover[^.]*in\s+the\s+wild/is);
    expect(CREDENTIALS_SECTION).toMatch(/save it/i);
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

  test("frames asking the user as the *last resort*, not the first move", () => {
    // The old wording said "If nothing turns up across all six, then
    // ask the user." which read like a prescription. The new wording
    // makes it explicit that asking-without-scanning is the lazy path.
    expect(CREDENTIALS_SECTION).toMatch(/last resort/i);
    expect(CREDENTIALS_SECTION).toMatch(/lazy path/i);
  });

  test("does not document phantombot notify (lives in NOTIFICATION_SECTION)", () => {
    // `phantombot notify` was previously misfiled under credentials. It
    // belongs to its own section now — credentials stays focused on
    // secret discovery and persistence.
    expect(CREDENTIALS_SECTION).not.toContain("phantombot notify");
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
