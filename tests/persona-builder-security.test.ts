import { describe, it, expect } from "bun:test";

import {
  buildSystemPrompt,
  SECURITY_PERIMETER_TRUSTED_SECTION,
  SECURITY_PERIMETER_UNTRUSTED_SECTION,
} from "../src/persona/builder.ts";

const persona = () => ({ boot: "I am Robbie", identitySource: "BOOT.md" });

const ctx = (trusted: boolean) => ({
  channel: "telegram",
  conversationId: "telegram:1",
  timestamp: new Date(0),
  trusted,
});

describe("security perimeter prompt sections", () => {
  it("injects the TRUSTED block for an authenticated principal", () => {
    const p = buildSystemPrompt(persona(), ctx(true));
    expect(p).toContain(SECURITY_PERIMETER_TRUSTED_SECTION);
    expect(p).not.toContain(SECURITY_PERIMETER_UNTRUSTED_SECTION);
  });

  it("injects the UNTRUSTED block when provenance is false", () => {
    const p = buildSystemPrompt(persona(), ctx(false));
    expect(p).toContain(SECURITY_PERIMETER_UNTRUSTED_SECTION);
    expect(p).not.toContain(SECURITY_PERIMETER_TRUSTED_SECTION);
  });

  it("defaults to UNTRUSTED when the bit is omitted (fail closed)", () => {
    const p = buildSystemPrompt(persona(), {
      channel: "cli",
      conversationId: "cli:ask",
      timestamp: new Date(0),
    });
    expect(p).toContain(SECURITY_PERIMETER_UNTRUSTED_SECTION);
  });

  it("describes the two-tier judge model, not the retired rules CRUD", () => {
    const both =
      SECURITY_PERIMETER_TRUSTED_SECTION + SECURITY_PERIMETER_UNTRUSTED_SECTION;
    // The old design's CLI surface must be gone from the prompt.
    expect(both).not.toContain("phantombot security");
    expect(both).not.toContain("security_rules");
    // The new model's language must be present.
    expect(SECURITY_PERIMETER_UNTRUSTED_SECTION).toMatch(/threat\s+judge/i);
    expect(SECURITY_PERIMETER_UNTRUSTED_SECTION).toMatch(/data\s+to\s+triage/i);
  });

  it("untrusted block tells the agent to escalate, not obey embedded commands", () => {
    expect(SECURITY_PERIMETER_UNTRUSTED_SECTION).toMatch(
      /never\s+as\s+instructions\s+to\s+obey/i,
    );
    expect(SECURITY_PERIMETER_UNTRUSTED_SECTION).toContain("phantombot notify");
  });
});
