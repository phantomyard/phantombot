/**
 * Tests for ensurePersonaScaffold.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePersonaScaffold } from "../src/lib/personaScaffold.ts";

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-scaffold-"));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("ensurePersonaScaffold", () => {
  test("creates the full memory/ + kb/ tree on a fresh persona", async () => {
    const r = await ensurePersonaScaffold(workdir);
    // Drawers
    for (const f of [
      "memory/people.md",
      "memory/decisions.md",
      "memory/lessons.md",
      "memory/commitments.md",
    ]) {
      expect(existsSync(join(workdir, f))).toBe(true);
      expect(r.created).toContain(f);
    }
    // KB seeds
    for (const f of [
      "kb/Home.md",
      "kb/templates/atomic-note.md",
      "kb/templates/runbook.md",
      "kb/templates/decision.md",
      "kb/templates/postmortem.md",
    ]) {
      expect(existsSync(join(workdir, f))).toBe(true);
      expect(r.created).toContain(f);
    }
    // Subdirs
    for (const d of [
      "memory/archive",
      "kb/inbox",
      "kb/concepts",
      "kb/runbooks",
      "kb/procedures",
      "kb/decisions",
      "kb/infra",
      "kb/people",
      "kb/projects",
      "kb/postmortems",
      "kb/templates",
    ]) {
      expect(existsSync(join(workdir, d))).toBe(true);
    }
    expect(r.skipped).toEqual([]);
  });

  test("is idempotent — second run skips everything", async () => {
    await ensurePersonaScaffold(workdir);
    const second = await ensurePersonaScaffold(workdir);
    expect(second.created).toEqual([]);
    expect(second.skipped.length).toBeGreaterThan(0);
  });

  test("does NOT overwrite existing files (preserves user content)", async () => {
    await mkdir(join(workdir, "memory"), { recursive: true });
    await writeFile(
      join(workdir, "memory", "people.md"),
      "# my people\n\n- Alice\n- Bob\n",
    );
    const r = await ensurePersonaScaffold(workdir);
    expect(r.skipped).toContain("memory/people.md");
    const content = await readFile(
      join(workdir, "memory", "people.md"),
      "utf8",
    );
    expect(content).toBe("# my people\n\n- Alice\n- Bob\n");
  });

  test("Home.md has correct frontmatter dating to today", async () => {
    await ensurePersonaScaffold(workdir);
    const home = await readFile(join(workdir, "kb", "Home.md"), "utf8");
    expect(home).toMatch(/^---/);
    expect(home).toContain("type: home");
    expect(home).toContain("[[concepts/]]");
    const today = new Date().toISOString().slice(0, 10);
    expect(home).toContain(`created: ${today}`);
  });
});
