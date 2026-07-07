import { describe, expect, test } from "bun:test";
import {
  generateBootMd,
  generateIdentityMd,
  generateIdentityStub,
  generateMemoryMdPlaceholder,
  generateSoulMd,
} from "../src/lib/personaTemplate.ts";

describe("generateSoulMd", () => {
  test("is character-free and bakes in the conciseness discipline", () => {
    const md = generateSoulMd();
    expect(md).toContain("# Soul");
    expect(md).toContain("be compact");
    expect(md).toContain("Token budget");
    expect(md).toContain("Trust & authority");
    // No persona-specific names leak into the shared template.
    expect(md.toLowerCase()).not.toContain("robbie");
    expect(md.toLowerCase()).not.toContain("golden retriever");
  });

  test("is stable (no per-call inputs)", () => {
    expect(generateSoulMd()).toBe(generateSoulMd());
  });
});

describe("generateIdentityMd", () => {
  test("carries the per-phantom facts from wizard answers", () => {
    const md = generateIdentityMd({
      name: "willem-bot",
      identity: "Willem's home assistant",
      tone: "warm",
      expertise: ["Household management"],
      hardRules: "always confirm before spending money",
      greeting: "be brief",
    });
    expect(md).toContain("# willem-bot");
    expect(md).toContain("Willem's home assistant");
    expect(md).toContain("Tone: **warm**");
    expect(md).toContain("- Household management");
    expect(md).toContain("always confirm before spending money");
    expect(md).toContain("be brief");
  });
});

describe("generateIdentityStub", () => {
  test("pre-fills the name and prompts for the rest", () => {
    const md = generateIdentityStub("willem-bot");
    expect(md).toContain("# willem-bot");
    expect(md).toContain("You are willem-bot");
    expect(md).toContain("Who you work for");
    expect(md).toContain("Responsibilities");
  });
});

describe("generateBootMd", () => {
  test("includes name + identity + tone guidance", () => {
    const md = generateBootMd({
      name: "robbie",
      identity: "a senior engineer who cares about correctness",
      tone: "blunt",
      expertise: [],
      hardRules: "",
      greeting: "",
    });
    expect(md).toContain("# robbie");
    expect(md).toContain("You are robbie, a senior engineer");
    expect(md).toContain("Tone: **blunt**");
    expect(md).toContain("Concise, direct");
  });

  test("includes expertise bullets when provided", () => {
    const md = generateBootMd({
      name: "x",
      identity: "y",
      tone: "casual",
      expertise: ["Coding", "Writing"],
      hardRules: "",
      greeting: "",
    });
    expect(md).toContain("## Areas of expertise");
    expect(md).toContain("- Coding");
    expect(md).toContain("- Writing");
  });

  test("includes hard rules as bullets, ignoring blank lines", () => {
    const md = generateBootMd({
      name: "x",
      identity: "y",
      tone: "casual",
      expertise: [],
      hardRules: "do this\n\ndo that\n",
      greeting: "",
    });
    expect(md).toContain("## Hard rules");
    expect(md).toContain("- do this");
    expect(md).toContain("- do that");
  });

  test("omits Hard rules section when input is empty", () => {
    const md = generateBootMd({
      name: "x",
      identity: "y",
      tone: "casual",
      expertise: [],
      hardRules: "",
      greeting: "",
    });
    expect(md).not.toContain("## Hard rules");
  });

  test("includes Greeting section only when provided", () => {
    const empty = generateBootMd({
      name: "x",
      identity: "y",
      tone: "casual",
      expertise: [],
      hardRules: "",
      greeting: "",
    });
    expect(empty).not.toContain("## Greeting");

    const withGreeting = generateBootMd({
      name: "x",
      identity: "y",
      tone: "casual",
      expertise: [],
      hardRules: "",
      greeting: "be direct",
    });
    expect(withGreeting).toContain("## Greeting");
    expect(withGreeting).toContain("be direct");
  });
});

describe("generateMemoryMdPlaceholder", () => {
  test("includes the persona name", () => {
    const md = generateMemoryMdPlaceholder("robbie");
    expect(md).toContain("robbie");
    expect(md).toContain("persistent memory");
  });
});
