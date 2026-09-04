/**
 * Tests for the always-on `# Local hygiene` section.
 *
 * The section exists because a persona's own AGENTS.md is optional and
 * owner-editable — `create-persona` never scaffolds one — so a hygiene rule
 * written there reaches only the personas that already knew it. These tests
 * therefore pin the WIRING (it is in the prompt every persona gets, on both
 * the trusted and untrusted paths, with and without persona files) rather
 * than the existence of a string constant.
 */

import { describe, expect, test } from "bun:test";
import {
  CREDENTIALS_SECTION,
  LOCAL_HYGIENE_SECTION,
  buildStableSystemPrompt,
  buildSystemPrompt,
} from "../src/persona/builder.ts";

const channelCtx = {
  channel: "cli",
  conversationId: "cli:default",
  timestamp: new Date("2026-09-04T12:00:00Z"),
};

const persona = { boot: "I am test", identitySource: "BOOT.md" };

describe("buildSystemPrompt — local hygiene section", () => {
  test("is present on a bare persona with no files of its own", () => {
    const prompt = buildSystemPrompt(persona, channelCtx);
    expect(prompt).toContain("# Local hygiene");
    expect(prompt).toContain(LOCAL_HYGIENE_SECTION.trim());
  });

  test("is present on both the trusted and untrusted paths", () => {
    for (const trusted of [true, false]) {
      const prompt = buildSystemPrompt(persona, { ...channelCtx, trusted });
      expect(prompt).toContain("# Local hygiene");
    }
  });

  test("is part of the cacheable stable prefix", () => {
    expect(buildStableSystemPrompt(persona, channelCtx)).toContain("# Local hygiene");
  });

  test("keeps each persona in its own lane, and /tmp disposable", () => {
    expect(LOCAL_HYGIENE_SECTION).toContain("your own persona directory");
    expect(LOCAL_HYGIENE_SECTION).toMatch(/not yours to touch or tidy/);
    expect(LOCAL_HYGIENE_SECTION).toMatch(/\/tmp as disposable, never as storage/);
  });

  test("keeps experiments off live data, config and schedules", () => {
    expect(LOCAL_HYGIENE_SECTION).toMatch(/scratch copy/);
    expect(LOCAL_HYGIENE_SECTION).toMatch(/live data, live config, or the schedule/);
  });

  test("says paths come from the system, not from memory", () => {
    expect(LOCAL_HYGIENE_SECTION).toMatch(/not ones you remember/);
    expect(LOCAL_HYGIENE_SECTION).toMatch(/swallows work silently/);
  });

  test("scopes the vault rule to credentials the persona persists", () => {
    expect(LOCAL_HYGIENE_SECTION).toMatch(/credential you store for later belongs in the vault/);
    expect(LOCAL_HYGIENE_SECTION).toMatch(/One canonical place per thing/);
  });

  /**
   * The prompt is ONE document. `CREDENTIALS_SECTION` is injected immediately
   * after this section and explicitly sends the agent to look in ~/.ssh, shell
   * exports, OS keychains and service unit `Environment=` lines, calling the
   * vault "a convenience layer, not a cage". An absolute "secrets live ONLY in
   * the vault" line here would outrank that later, more permissive text and
   * could get legitimate SSH keys or service credentials treated as hygiene
   * violations — moved, deleted, or refused. So the combined prompt must never
   * make a vault-exclusivity claim.
   */
  test("does not contradict the credential contract injected after it", () => {
    const prompt = buildSystemPrompt(persona, channelCtx);
    expect(prompt).toContain(LOCAL_HYGIENE_SECTION.trim());
    expect(prompt).toContain(CREDENTIALS_SECTION.trim());

    expect(LOCAL_HYGIENE_SECTION).not.toMatch(/secrets? (?:live|belong|are|go|exist)[^.]*only/i);
    expect(LOCAL_HYGIENE_SECTION).not.toMatch(/only (?:place|store|home)[^.]*vault/i);
    // The hygiene text must not forbid the stores the credential contract
    // sends the agent to read.
    expect(LOCAL_HYGIENE_SECTION).not.toMatch(/ssh|keychain|password manager|environment=/i);
  });

  test("stays operator-neutral: no git, repo or branch vocabulary", () => {
    expect(LOCAL_HYGIENE_SECTION).not.toMatch(/\b(git|repo|repository|branch|clone|commit)\b/i);
  });

  test("stays short — it is on every prompt of every persona forever", () => {
    expect(LOCAL_HYGIENE_SECTION.length).toBeLessThan(900);
  });
});
