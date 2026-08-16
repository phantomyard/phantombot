/**
 * Tests for the OKF-aware note parser (src/lib/okf.ts).
 */

import { describe, expect, test } from "bun:test";
import {
  extractLinks,
  isCanonicalOkfType,
  normaliseOkfType,
  OKF_AGENT_TYPES,
  OKF_CORE_TYPES,
  OKF_TYPE_ALIASES,
  OKF_TYPES,
  parseFrontmatter,
  parseOkf,
  splitFrontmatter,
} from "../src/lib/okf.ts";

describe("splitFrontmatter", () => {
  test("splits leading YAML block from body", () => {
    const { frontmatter, body } = splitFrontmatter(
      "---\ntitle: X\n---\nhello body\n",
    );
    expect(frontmatter).toBe("title: X");
    expect(body).toBe("hello body\n");
  });

  test("no frontmatter → empty fm, full body", () => {
    const { frontmatter, body } = splitFrontmatter("# Heading\ntext");
    expect(frontmatter).toBe("");
    expect(body).toBe("# Heading\ntext");
  });

  test("strips a UTF-8 BOM when no frontmatter", () => {
    const { body } = splitFrontmatter("﻿# Heading");
    expect(body).toBe("# Heading");
  });
});

describe("parseFrontmatter", () => {
  test("scalars, flow lists, and block lists", () => {
    const fm = parseFrontmatter(
      [
        "title: DNS Runbook",
        "type: runbook",
        "tags: [infra, dns]",
        "aliases:",
        "  - name resolution",
        '  - "DNS"',
      ].join("\n"),
    );
    expect(fm.title).toBe("DNS Runbook");
    expect(fm.type).toBe("runbook");
    expect(fm.tags).toEqual(["infra", "dns"]);
    expect(fm.aliases).toEqual(["name resolution", "DNS"]);
  });

  test("ignores comments and blank lines, never throws on junk", () => {
    const fm = parseFrontmatter("# a comment\n\n: bad line\nkey: value\n");
    expect(fm.key).toBe("value");
  });
});

describe("extractLinks", () => {
  test("captures markdown and wiki links, skips external URLs", () => {
    const body = [
      "See [the runbook](infra/dns.md) and [[DNS Cutover]].",
      "External [docs](https://example.com) ignored.",
      "Anchor [top](#intro) ignored.",
    ].join("\n");
    const links = extractLinks(body);
    expect(links).toContainEqual({ target: "infra/dns.md", kind: "md" });
    expect(links).toContainEqual({ target: "DNS Cutover", kind: "wiki" });
    const targets = links.map((l) => l.target);
    expect(targets).not.toContain("https://example.com");
    expect(targets).not.toContain("#intro");
  });

  test("wikilink with display alias keeps the target", () => {
    expect(extractLinks("[[concepts/foo|Foo the thing]]")).toEqual([
      { target: "concepts/foo", kind: "wiki" },
    ]);
  });
});

describe("parseOkf", () => {
  test("full concept note", () => {
    const doc = parseOkf(
      [
        "---",
        "title: Secret Rotation",
        "type: runbook",
        "description: How we cycle credentials.",
        "tags: [#Creds, secrets]",
        "aliases: [credential rotation]",
        "---",
        "# Secret Rotation",
        "Body text linking to [vault](infra/vault.md).",
        "## Steps",
        "do the thing",
      ].join("\n"),
    );
    expect(doc.title).toBe("Secret Rotation");
    expect(doc.type).toBe("runbook");
    expect(doc.description).toBe("How we cycle credentials.");
    // tags normalised: lowercased, leading # stripped.
    expect(doc.tags).toEqual(["creds", "secrets"]);
    expect(doc.aliases).toEqual(["credential rotation"]);
    expect(doc.headings).toEqual(["Secret Rotation", "Steps"]);
    expect(doc.links).toEqual([{ target: "infra/vault.md", kind: "md" }]);
  });

  test("plain note with no frontmatter falls back to first H1 for title", () => {
    const doc = parseOkf("# Just A Note\nsome content");
    expect(doc.title).toBe("Just A Note");
    expect(doc.tags).toEqual([]);
    expect(doc.body).toContain("some content");
  });

  test("empty input never throws", () => {
    const doc = parseOkf("");
    expect(doc.title).toBe("");
    expect(doc.links).toEqual([]);
  });
});

describe("controlled type vocabulary", () => {
  test("core and agent types are disjoint and non-empty", () => {
    expect(OKF_CORE_TYPES.length).toBeGreaterThan(0);
    expect(OKF_AGENT_TYPES.length).toBeGreaterThan(0);
    const overlap = OKF_CORE_TYPES.filter((t) =>
      (OKF_AGENT_TYPES as readonly string[]).includes(t),
    );
    expect(overlap).toEqual([]);
  });

  test("OKF_TYPES has no duplicates", () => {
    expect(new Set(OKF_TYPES).size).toBe(OKF_TYPES.length);
  });

  test("every alias resolves to a canonical type", () => {
    // Guards the drift map against pointing at a type that was later renamed
    // or removed — an alias to a non-existent type silently normalises to "".
    for (const [alias, target] of Object.entries(OKF_TYPE_ALIASES)) {
      expect((OKF_TYPES as readonly string[]).includes(target)).toBe(true);
      // An alias must not shadow a canonical value.
      expect((OKF_TYPES as readonly string[]).includes(alias)).toBe(false);
    }
  });

  test("canonical types normalise to themselves", () => {
    for (const t of OKF_TYPES) {
      expect(normaliseOkfType(t)).toBe(t);
      expect(isCanonicalOkfType(t)).toBe(true);
    }
  });

  test("folds the drift observed in real KBs", () => {
    expect(normaliseOkfType("atomic-note")).toBe("concept");
    expect(normaliseOkfType("troubleshooting")).toBe("runbook");
    expect(normaliseOkfType("incident-handover")).toBe("postmortem");
    expect(normaliseOkfType("home")).toBe("index");
    expect(normaliseOkfType("model-research")).toBe("reference");
  });

  test("normalisation is case- and separator-insensitive", () => {
    expect(normaliseOkfType("  Atomic_Note ")).toBe("concept");
    expect(normaliseOkfType("PROJECT PLAN")).toBe("project");
    expect(normaliseOkfType("Runbook")).toBe("runbook");
  });

  test("unknown types report as unknown rather than guessing", () => {
    // Deliberate: silently bucketing an unrecognised type as `concept` would
    // hide vocabulary drift instead of surfacing it.
    expect(normaliseOkfType("wibble")).toBe("");
    expect(normaliseOkfType("")).toBe("");
    expect(isCanonicalOkfType("wibble")).toBe(false);
  });
});
