/**
 * Tests for the always-on `# The runtime you are running in` section
 * (issue #616).
 *
 * The prompt described every TOOL and nothing about the process holding them,
 * so the model under-reached about its own plumbing. These tests pin the
 * WIRING (present for every persona, on both trust paths, in the CACHEABLE
 * stable prefix) and the two properties that make the section trustworthy: it
 * reports LIVE version/platform rather than hand-maintained prose, and it
 * claims only what is true of every install.
 */

import { describe, expect, test } from "bun:test";
import {
  buildRuntimeSection,
  buildStableSystemPrompt,
  buildSystemPrompt,
} from "../src/persona/builder.ts";
import { VERSION } from "../src/version.ts";

const channelCtx = {
  channel: "cli",
  conversationId: "cli:default",
  timestamp: new Date("2026-09-27T12:00:00Z"),
};

const persona = { boot: "I am test", identitySource: "BOOT.md" } as const;

describe("buildSystemPrompt — runtime capability section", () => {
  test("is present on a bare persona with no files of its own", () => {
    const prompt = buildSystemPrompt(persona, channelCtx);
    expect(prompt).toContain("# The runtime you are running in");
    expect(prompt).toContain(buildRuntimeSection());
  });

  test("is present on both the trusted and untrusted paths", () => {
    for (const trusted of [true, false]) {
      const prompt = buildSystemPrompt(persona, { ...channelCtx, trusted });
      expect(prompt).toContain("# The runtime you are running in");
    }
  });

  test("is in the STABLE prefix — the cacheable half, not the per-turn tail", () => {
    const stable = buildStableSystemPrompt(persona, channelCtx);
    expect(stable).toContain("# The runtime you are running in");
    // Ahead of the volatile blocks: the section must not sit after retrieved
    // context / daily journal / channel context, or it would break the cache
    // prefix it is cheap to be part of.
    const full = buildSystemPrompt(persona, channelCtx, "retrieved", "facts", "journal");
    expect(full.indexOf("# The runtime you are running in")).toBeLessThan(
      full.indexOf("# Channel context"),
    );
  });

  test("two builds in the same process are byte-identical (cache-safe)", () => {
    expect(buildRuntimeSection()).toBe(buildRuntimeSection());
  });

  test("reports the LIVE version, not a hand-written one", () => {
    expect(buildRuntimeSection()).toContain(VERSION);
    expect(buildRuntimeSection("1.1.402", "linux")).toContain("phantombot 1.1.402");
    // A stale self-description is worse than none: nothing in the section may
    // hardcode a release number.
    expect(buildRuntimeSection("1.1.402", "linux")).not.toContain(VERSION.split("-")[0] + "-dev");
  });

  test("names the platform in human terms, and passes an unknown one through", () => {
    expect(buildRuntimeSection("1.1.402", "win32")).toContain("running on Windows");
    expect(buildRuntimeSection("1.1.402", "darwin")).toContain("running on macOS");
    expect(buildRuntimeSection("1.1.402", "linux")).toContain("running on Linux");
    expect(buildRuntimeSection("1.1.402", "freebsd")).toContain("running on freebsd");
  });

  test("carries both pointers: the command surface and the source", () => {
    const section = buildRuntimeSection();
    expect(section).toContain("phantombot --help");
    expect(section).toContain("https://github.com/phantomyard/phantombot");
    expect(section).toContain("AGENTS.md");
  });

  test("claims no host-specific configuration — no channel, harness or persona names", () => {
    // Those come from sections built off live config. A confident guess here
    // would be a falsehood in every prompt on the host.
    const section = buildRuntimeSection();
    for (const invented of ["telegram", "signal", "claude", "codex", "openrouter"]) {
      expect(section.toLowerCase()).not.toContain(invented);
    }
  });

  test("does not duplicate the tool sections that follow it", () => {
    const section = buildRuntimeSection();
    expect(section).not.toContain("phantombot memory capture");
    expect(section).not.toContain("phantombot task add");
    expect(section).not.toContain("phantombot vault set");
  });
});
