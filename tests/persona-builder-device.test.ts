/**
 * The `# Your principal's PC` section (#747): only a persona with a
 * PhantomChat principal is told about `phantombot device`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSystemPrompt } from "../src/persona/builder.ts";
import { loadPersona } from "../src/persona/loader.ts";

const ctx = { channel: "cli", conversationId: "cli:default", timestamp: new Date("2026-11-04T00:00:00Z") };
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pb-device-prompt-"));
  writeFileSync(join(dir, "IDENTITY.md"), "I am test");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("device tools prompt section", () => {
  test("absent without phantomchat.json, or with an empty allowlist", async () => {
    expect(buildSystemPrompt(await loadPersona(dir), ctx)).not.toContain("# Your principal's PC");
    writeFileSync(join(dir, "phantomchat.json"), JSON.stringify({ allowed_npubs: [] }));
    expect(buildSystemPrompt(await loadPersona(dir), ctx)).not.toContain("# Your principal's PC");
    writeFileSync(join(dir, "phantomchat.json"), "{not json");
    expect(buildSystemPrompt(await loadPersona(dir), ctx)).not.toContain("# Your principal's PC");
  });

  test("present with a principal npub", async () => {
    writeFileSync(join(dir, "phantomchat.json"), JSON.stringify({ allowed_npubs: ["npub1x"] }));
    const prompt = buildSystemPrompt(await loadPersona(dir), ctx);
    expect(prompt).toContain("# Your principal's PC");
    expect(prompt).toContain("phantombot device list");
  });
});
