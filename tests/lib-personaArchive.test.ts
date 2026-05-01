/**
 * Tests for the persona archive helper.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archivePersona,
  archivesDir,
  listArchives,
  restoreArchive,
} from "../src/lib/personaArchive.ts";

let workdir: string;
let personasDir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-archive-"));
  personasDir = join(workdir, "personas");
  await mkdir(personasDir, { recursive: true });
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

async function makePersona(name: string, content = `# ${name}`) {
  const dir = join(personasDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "BOOT.md"), content);
}

describe("archivePersona", () => {
  test("moves the persona dir into personas-archive/<name>-<ts>", async () => {
    await makePersona("kai");
    const r = await archivePersona(personasDir, "kai");
    expect(existsSync(join(personasDir, "kai"))).toBe(false);
    expect(existsSync(r.dir)).toBe(true);
    expect(r.dir).toBe(join(archivesDir(personasDir), r.archiveName));
    expect(r.archiveName.startsWith("kai-")).toBe(true);
    const boot = await readFile(join(r.dir, "BOOT.md"), "utf8");
    expect(boot).toBe("# kai");
  });

  test("throws when persona does not exist", async () => {
    expect(archivePersona(personasDir, "nope")).rejects.toThrow(
      /does not exist/,
    );
  });
});

describe("listArchives", () => {
  test("returns [] when archive dir does not exist", async () => {
    expect(await listArchives(personasDir)).toEqual([]);
  });

  test("lists archives newest-first", async () => {
    await makePersona("kai");
    const a = await archivePersona(personasDir, "kai");
    // Brief delay so the second archive has a strictly later timestamp.
    await new Promise((r) => setTimeout(r, 5));
    await makePersona("kai", "v2");
    const b = await archivePersona(personasDir, "kai");
    const list = await listArchives(personasDir);
    expect(list.map((x) => x.archiveName)).toEqual([
      b.archiveName,
      a.archiveName,
    ]);
  });
});

describe("restoreArchive", () => {
  test("restores into personasDir/<asName>/", async () => {
    await makePersona("kai");
    const a = await archivePersona(personasDir, "kai");
    await restoreArchive(personasDir, a, "kai");
    expect(existsSync(join(personasDir, "kai", "BOOT.md"))).toBe(true);
  });

  test("auto-archives an existing persona at the target name before restoring", async () => {
    await makePersona("kai", "old");
    const a = await archivePersona(personasDir, "kai");
    await makePersona("kai", "newer");
    await restoreArchive(personasDir, a, "kai");
    const restored = await readFile(
      join(personasDir, "kai", "BOOT.md"),
      "utf8",
    );
    expect(restored).toBe("old");
    // Two archives now exist: the original "old" and the auto-archived "newer".
    const list = await listArchives(personasDir);
    expect(list).toHaveLength(2);
  });

  test("can restore to a different name", async () => {
    await makePersona("kai");
    const a = await archivePersona(personasDir, "kai");
    await restoreArchive(personasDir, a, "kai-clone");
    expect(existsSync(join(personasDir, "kai-clone", "BOOT.md"))).toBe(true);
  });
});
