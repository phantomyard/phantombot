/**
 * Tests for the always-on `# Surfacing things to the user` section.
 *
 * Companion to persona-builder-scheduling.test.ts. Notification was
 * previously tucked inside CREDENTIALS_SECTION (a category mistake —
 * credentials and notifications have nothing to do with each other).
 * Promoted to its own section so it's discoverable and so scheduled
 * tasks have an obvious neighbour-section that explains how to surface
 * findings.
 */

import { describe, expect, test } from "bun:test";
import {
  NOTIFICATION_SECTION,
  buildSystemPrompt,
} from "../src/persona/builder.ts";

const channelCtx = {
  channel: "cli",
  conversationId: "cli:default",
  timestamp: new Date("2026-05-07T12:00:00Z"),
};

describe("buildSystemPrompt — notification section", () => {
  test("always appends the notification section", () => {
    const prompt = buildSystemPrompt(
      { boot: "I am test", identitySource: "BOOT.md" },
      channelCtx,
    );
    expect(prompt).toContain("# Surfacing things to the user");
  });

  test("documents the phantombot notify CLI with both flags", () => {
    expect(NOTIFICATION_SECTION).toContain("phantombot notify");
    expect(NOTIFICATION_SECTION).toContain("--message");
    expect(NOTIFICATION_SECTION).toContain("--voice");
  });

  test("documents the silent-by-default contract", () => {
    expect(NOTIFICATION_SECTION).toContain("silently by default");
    // The "stay quiet unless something material happened" rule.
    expect(NOTIFICATION_SECTION).toMatch(/material/i);
    expect(NOTIFICATION_SECTION).toMatch(/stay\s+quiet/i);
  });

  test("declares Telegram-via-notify as the only sanctioned proactive channel", () => {
    // Closes the loophole of the agent trying to inject messages by
    // other means (TTY writes, Google Chat, self-scheduled messages).
    expect(NOTIFICATION_SECTION).toMatch(/only sanctioned proactive channel/i);
  });

  test("notification section sits between scheduling and credentials", () => {
    // Order matters for caching and for the agent's mental model:
    // memory → scheduling (when) → notification (how to surface) →
    // credentials (how to authenticate).
    const prompt = buildSystemPrompt(
      { boot: "I am test", identitySource: "BOOT.md" },
      channelCtx,
    );
    const schedIdx = prompt.indexOf("# Scheduling tasks");
    const notifyIdx = prompt.indexOf("# Surfacing things to the user");
    const credIdx = prompt.indexOf("# Credentials");
    expect(schedIdx).toBeGreaterThan(0);
    expect(notifyIdx).toBeGreaterThan(schedIdx);
    expect(credIdx).toBeGreaterThan(notifyIdx);
  });
});
