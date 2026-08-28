/**
 * `phantombot persona new` (issue #471).
 *
 * The behaviour worth pinning is the default-persona one: creating a phantom
 * must NOT take `/update` and `/restart` from the existing default unless the
 * caller explicitly asked.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../src/config.ts";
import { runPersonaNew, validPersonaName } from "../src/cli/persona-new.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshConfig(withExisting?: string): Config {
  const root = mkdtempSync(join(tmpdir(), "phantombot-persona-new-"));
  roots.push(root);
  const personasDir = join(root, "personas");
  mkdirSync(personasDir, { recursive: true });
  if (withExisting) mkdirSync(join(personasDir, withExisting), { recursive: true });
  return {
    defaultPersona: withExisting ?? "robbie",
    personasDir,
    configPath: join(root, "config.toml"),
    memoryDbPath: join(root, "memory.sqlite"),
    autostartPersonas: [],
    harnesses: { chain: ["claude"] },
  } as unknown as Config;
}

function sink() {
  const lines: string[] = [];
  return { lines, write: (chunk: string) => void lines.push(chunk) };
}

describe("validPersonaName", () => {
  test("accepts names that survive being a directory name", () => {
    for (const name of ["robbie", "kai2", "team-a", "a_b"]) {
      expect(validPersonaName(name)).toBe(true);
    }
  });

  test("rejects spaces, capitals, traversal and leading punctuation", () => {
    for (const name of ["Robbie", "two words", "../escape", "-lead", ""]) {
      expect(validPersonaName(name)).toBe(false);
    }
  });
});

describe("runPersonaNew", () => {
  test("creates the persona directory and reports where it landed", async () => {
    const config = freshConfig();
    const out = sink();
    const code = await runPersonaNew({ name: "lena", config, out, err: sink() });
    expect(code).toBe(0);
    expect(existsSync(join(config.personasDir, "lena"))).toBe(true);
    expect(out.lines.join("")).toContain("created lena");
  });

  test("does NOT become the default when one already exists", async () => {
    // create-persona offers "yes" by default here, so a second phantom silently
    // reassigns default_persona — and with it ownership of /update and
    // /restart. Control of a box must not move on a mis-tapped Enter.
    const config = freshConfig("robbie");
    const out = sink();
    await runPersonaNew({ name: "lena", config, out, err: sink() });
    expect(out.lines.join("")).not.toContain("is now the default persona");
  });

  test("--default is honoured when explicitly asked for", async () => {
    const config = freshConfig("robbie");
    const out = sink();
    await runPersonaNew({
      name: "lena",
      makeDefault: true,
      config,
      out,
      err: sink(),
    });
    expect(out.lines.join("")).toContain("owns /update and /restart");
  });

  test("--autostart writes the HOST-global list", async () => {
    const config = freshConfig("robbie");
    const out = sink();
    await runPersonaNew({
      name: "lena",
      autostart: true,
      config,
      out,
      err: sink(),
    });
    expect(config.autostartPersonas).toContain("lena");
    expect(out.lines.join("")).toContain("autostart: lena");
  });

  test("refuses a duplicate name rather than archiving the existing one", async () => {
    const config = freshConfig("robbie");
    const err = sink();
    const code = await runPersonaNew({
      name: "robbie",
      config,
      out: sink(),
      err,
    });
    expect(code).toBe(2);
    expect(err.lines.join("")).toContain("already exists");
  });

  test("refuses an invalid name before touching disk", async () => {
    const config = freshConfig();
    const err = sink();
    expect(
      await runPersonaNew({ name: "Two Words", config, out: sink(), err }),
    ).toBe(2);
    expect(err.lines.join("")).toContain("lowercase");
  });

  test("tells the caller a restart is needed — no silent half-configured phantom", async () => {
    const config = freshConfig();
    const out = sink();
    await runPersonaNew({ name: "lena", config, out, err: sink() });
    expect(out.lines.join("")).toContain("phantombot restart");
  });
});
