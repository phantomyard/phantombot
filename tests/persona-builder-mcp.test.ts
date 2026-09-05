/**
 * Tests for the `# External tools (MCP)` prompt section and registered server inventory.
 *
 * Issue #537: Agents default away from registered MCP servers because servers
 * were invisible until searched. Injecting a one-line inventory of registered
 * MCP server names makes them immediately visible without an upfront discovery
 * round-trip while keeping full tool schemas lazy.
 */

import { describe, expect, test } from "bun:test";
import {
  MCP_TOOLS_SECTION,
  buildMcpToolsSection,
  buildStableSystemPrompt,
  buildSystemPrompt,
} from "../src/persona/builder.ts";

const channelCtx = {
  channel: "cli",
  conversationId: "cli:default",
  timestamp: new Date("2026-09-05T12:00:00Z"),
};

describe("buildMcpToolsSection", () => {
  test("formats registered MCP server names as a comma-separated list", () => {
    const section = buildMcpToolsSection(["github", "google-drive", "home-assistant"]);
    expect(section).toContain("MCP servers: github, google-drive, home-assistant");
    expect(section).toContain("# External tools (MCP)");
    expect(section).toContain("phantombot mcp search");
  });

  test("states (none registered) when server list is undefined or empty", () => {
    expect(buildMcpToolsSection(undefined)).toContain("MCP servers: (none registered)");
    expect(buildMcpToolsSection([])).toContain("MCP servers: (none registered)");
    expect(MCP_TOOLS_SECTION).toContain("MCP servers: (none registered)");
  });
});

describe("buildSystemPrompt — MCP server injection", () => {
  test("injects registered MCP servers into the system prompt", () => {
    const prompt = buildSystemPrompt(
      {
        boot: "I am test",
        identitySource: "BOOT.md",
        mcpServers: ["github", "linear"],
      },
      channelCtx,
    );
    expect(prompt).toContain("# External tools (MCP)");
    expect(prompt).toContain("MCP servers: github, linear");
  });

  test("injects (none registered) when persona has no registered MCP servers", () => {
    const prompt = buildSystemPrompt(
      { boot: "I am test", identitySource: "BOOT.md" },
      channelCtx,
    );
    expect(prompt).toContain("# External tools (MCP)");
    expect(prompt).toContain("MCP servers: (none registered)");
  });

  test("is included in buildStableSystemPrompt prefix for caching", () => {
    const stable = buildStableSystemPrompt(
      {
        boot: "I am test",
        identitySource: "BOOT.md",
        mcpServers: ["github"],
      },
      channelCtx,
    );
    expect(stable).toContain("# External tools (MCP)");
    expect(stable).toContain("MCP servers: github");
  });

  test("is present across both trusted and untrusted channels", () => {
    const persona = {
      boot: "I am test",
      identitySource: "BOOT.md",
      mcpServers: ["github", "home-assistant"],
    };
    for (const trusted of [true, false]) {
      const prompt = buildSystemPrompt(persona, { ...channelCtx, trusted });
      expect(prompt).toContain("MCP servers: github, home-assistant");
    }
  });
});
