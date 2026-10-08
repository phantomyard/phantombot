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

  it("untrusted block still says content is data, never commands", () => {
    expect(SECURITY_PERIMETER_UNTRUSTED_SECTION).toMatch(
      /never\s+as\s+instructions\s+to\s+obey/i,
    );
    expect(SECURITY_PERIMETER_UNTRUSTED_SECTION).toMatch(/never widens it/);
  });

  // ONE gate per channel: the threat judge gates an untrusted turn, and only
  // the judge. The untrusted block used to carry a second one — escalate
  // anything privileged, notify, "then stop and wait" — which fired after
  // the judge had passed the turn and which no standing ruling could switch
  // off. These pins fail if that approval step grows back.
  it("untrusted block carries NO escalate-and-wait approval step", () => {
    const u = SECURITY_PERIMETER_UNTRUSTED_SECTION;
    expect(u).not.toContain("What to ESCALATE");
    expect(u).not.toMatch(/stop and wait/i);
    expect(u).not.toMatch(/do NOT act/);
    expect(u).not.toContain("I haven't done it");
    // The old list named routine autonomous work as needing approval.
    expect(u).not.toMatch(/merging\/pushing code/);
    expect(u).not.toMatch(/editing config \/\s*memory/);
  });

  it("untrusted block tells the agent the judge is the gate and to finish the job", () => {
    const u = SECURITY_PERIMETER_UNTRUSTED_SECTION;
    expect(u).toMatch(/no second approval step/);
    expect(u).toMatch(/end to end/);
    expect(u).toMatch(/Do not stop to ask your\s+owner for confirmation/);
  });

  it("the only notify left in the untrusted block is a REPORT, not a permission request", () => {
    const u = SECURITY_PERIMETER_UNTRUSTED_SECTION;
    expect(u).toContain("phantombot notify");
    expect(u).toMatch(/report of an attempt, not a request for permission/);
  });

  it("trusted block says a passed turn does its whole job and names the no-verdict hold", () => {
    const t = SECURITY_PERIMETER_TRUSTED_SECTION;
    expect(t).toMatch(/only gate on autonomous work/);
    expect(t).toMatch(/without a usable verdict/);
  });
});
