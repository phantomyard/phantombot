/**
 * Tests for ensurePersonaScaffold.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TAG_TO_DRAWER } from "../src/lib/heartbeat.ts";
import { isCanonicalOkfType, parseOkf } from "../src/lib/okf.ts";
import { ensurePersonaScaffold } from "../src/lib/personaScaffold.ts";
import { BRIEFING_DRAWERS } from "../src/orchestrator/screen.ts";

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
      "memory/norms.md",
    ]) {
      expect(existsSync(join(workdir, f))).toBe(true);
      expect(r.created).toContain(f);
    }
    // KB seeds
    for (const f of [
      "kb/Home.md",
      "kb/templates/concept.md",
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
    // `home` was folded into the shared `index` type when the OKF vocabulary
    // was declared; `normaliseOkfType` still maps the legacy value.
    expect(home).toContain("type: index");
    expect(home).toContain("[[concepts/]]");
    const today = new Date().toISOString().slice(0, 10);
    expect(home).toContain(`created: ${today}`);
  });
});

describe("scaffolded templates carry full OKF frontmatter", () => {
  test("every template declares a canonical type and the weighted fields", async () => {
    await ensurePersonaScaffold(workdir);
    for (const f of [
      "kb/templates/concept.md",
      "kb/templates/runbook.md",
      "kb/templates/decision.md",
      "kb/templates/postmortem.md",
      "kb/Home.md",
    ]) {
      const raw = await readFile(join(workdir, f), "utf8");
      // The type a template declares must be one an agent is allowed to
      // author — a template scaffolding an off-vocabulary type teaches drift
      // on every note created from it.
      expect(isCanonicalOkfType(parseOkf(raw).type)).toBe(true);
      for (const field of ["title:", "description:", "tags:", "aliases:"]) {
        expect(raw).toContain(field);
      }
    }
  });

  test("the concept template's filename matches the type it declares", async () => {
    // Regression: the old `atomic-note.md` declared `type: concept`, so the
    // scaffold contradicted itself about what the vocabulary actually was.
    await ensurePersonaScaffold(workdir);
    const raw = await readFile(join(workdir, "kb/templates/concept.md"), "utf8");
    expect(parseOkf(raw).type).toBe("concept");
    expect(existsSync(join(workdir, "kb/templates/atomic-note.md"))).toBe(false);
  });
});

describe("the scaffold seeds every drawer the rest of the system writes to", () => {
  test("every heartbeat promotion target exists after scaffolding", async () => {
    // Regression: `norms.md` was reachable via `--tag norm` but never seeded,
    // so the heartbeat's appendFile created it on first capture — a drawer
    // with no title and no intro, unlike every other one.
    await ensurePersonaScaffold(workdir);
    for (const rel of new Set(Object.values(TAG_TO_DRAWER))) {
      expect(existsSync(join(workdir, rel))).toBe(true);
      const body = await readFile(join(workdir, rel), "utf8");
      expect(body.startsWith("# ")).toBe(true);
    }
  });

  test("every threat-judge briefing drawer exists after scaffolding", async () => {
    // A briefing drawer the scaffold skips is silently absent on a fresh
    // persona: readBriefingDrawers swallows the ENOENT, so the judge briefs
    // on a partial worldview with nothing logged anywhere.
    await ensurePersonaScaffold(workdir);
    for (const rel of BRIEFING_DRAWERS) {
      expect(existsSync(join(workdir, rel))).toBe(true);
    }
  });

  test("the norms drawer explains that the threat judge reads it", async () => {
    // The drawer's own text is the only place an agent learns this drawer is
    // security-load-bearing rather than another notes file.
    await ensurePersonaScaffold(workdir);
    const norms = await readFile(join(workdir, "memory", "norms.md"), "utf8");
    expect(norms).toContain("# Norms");
    expect(norms).toContain("threat judge");
    expect(norms).toContain("--tag norm");
    // Accuracy, not decoration: the briefing shares a byte cap with the other
    // two drawers, and promotion is the heartbeat's deterministic job. A
    // drawer that claims otherwise teaches every fresh persona the wrong
    // model of the one file its threat scoring depends on.
    expect(norms).toContain("cap");
    expect(norms).toContain("heartbeat");
    expect(norms).not.toContain("IN FULL");
    // The cap is shared and this drawer is concatenated last, so it is the
    // first content dropped — the drawer has to say so, or "be exhaustive"
    // looks free.
    expect(norms).toContain("LAST");
  });

  test("no seeded drawer claims the briefing preserves entry boundaries", async () => {
    // readBriefingDrawers truncates with a RAW BYTE SLICE
    // (`Buffer.from(text).subarray(0, DRAWERS_CAP_BYTES)`) over the
    // CONCATENATED drawers — there is no entry-boundary logic anywhere in it,
    // so the cut can land mid-entry, mid-line, even mid-codepoint. "IN FULL"
    // was the first way this got overstated and "whole entries, not snippets"
    // was the second, weaker way; both promise a guarantee the runtime does
    // not give. Assert against the class of claim, not the one wording.
    await ensurePersonaScaffold(workdir);
    for (const rel of BRIEFING_DRAWERS) {
      const body = await readFile(join(workdir, rel), "utf8");
      expect(body).not.toMatch(/in full/i);
      expect(body).not.toMatch(/whole (entries|rulings)/i);
      expect(body).not.toMatch(/full fidelity/i);
      expect(body).not.toMatch(/not snippets/i);
    }
    // And the norms drawer must say what actually happens instead.
    const norms = await readFile(join(workdir, "memory", "norms.md"), "utf8");
    expect(norms).toContain("mid-entry");
  });

  test("no seeded drawer credits the nightly cycle with promotion", async () => {
    // Promotion is the heartbeat's deterministic every-30-min pass
    // (TAG_TO_DRAWER lives in heartbeat.ts); the nightly cycle is the
    // cognitive catch-up for what the heartbeat could not file. Four drawer
    // intros shipped the reverse for long enough that it was copied into a
    // fifth, so assert the attribution rather than trusting review to catch
    // the next copy.
    await ensurePersonaScaffold(workdir);
    for (const rel of new Set(Object.values(TAG_TO_DRAWER))) {
      const body = await readFile(join(workdir, rel), "utf8");
      expect(body).toContain("heartbeat promotes");
      expect(body).not.toMatch(/nightly cycle promotes/i);
      expect(body).not.toMatch(/promoted from daily files by the nightly/i);
    }
  });
});
