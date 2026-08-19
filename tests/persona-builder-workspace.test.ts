/**
 * Tests for the always-on `# Shared working copies` section (issue #405).
 *
 * This section is the ONLY thing that makes the advisory workspace lock work:
 * phantombot is not in the path of the `git` a harness runs through its own
 * Bash tool, so nothing enforces the claim — an agent that has never been told
 * the command exists will never take it.
 */

import { describe, expect, test } from "bun:test";
import {
  WORKSPACE_LOCK_SECTION,
  buildSystemPrompt,
} from "../src/persona/builder.ts";

const channelCtx = {
  channel: "cli",
  conversationId: "cli:default",
  timestamp: new Date("2026-08-19T12:00:00Z"),
};

describe("buildSystemPrompt — workspace section", () => {
  test("always appends the shared-working-copy section", () => {
    const prompt = buildSystemPrompt(
      { boot: "I am test", identitySource: "BOOT.md" },
      channelCtx,
    );
    expect(prompt).toContain("# Shared working copies");
  });

  test("documents all three subcommands", () => {
    expect(WORKSPACE_LOCK_SECTION).toContain("phantombot workspace lock");
    expect(WORKSPACE_LOCK_SECTION).toContain("phantombot workspace status");
    expect(WORKSPACE_LOCK_SECTION).toContain("phantombot workspace unlock");
  });

  test("says a held path means go elsewhere, not wait or force", () => {
    expect(WORKSPACE_LOCK_SECTION).toContain("Do not");
    expect(WORKSPACE_LOCK_SECTION).toContain("clone a fresh copy");
  });

  test("is honest that the claim is advisory and unenforced", () => {
    expect(WORKSPACE_LOCK_SECTION).toContain("ADVISORY");
    expect(WORKSPACE_LOCK_SECTION).toContain("Nothing stops you writing");
  });

  test("says reading a claimed workspace is fine", () => {
    expect(WORKSPACE_LOCK_SECTION).toContain("Reading a claimed workspace");
  });
});
