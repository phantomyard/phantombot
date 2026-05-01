import { describe, expect, test } from "bun:test";
import {
  generateBootMd,
  generateMemoryMdPlaceholder,
} from "../src/lib/personaTemplate.ts";

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
