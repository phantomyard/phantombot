/**
 * Tests for the SOUL.md / IDENTITY.md backfill.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../src/config.ts";
import {
  backfillAllPersonas,
  backfillPersonaDir,
} from "../src/lib/personaBackfill.ts";
import { loadPersona } from "../src/persona/loader.ts";

let workdir: string;
let config: Config;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-backfill-"));
  await mkdir(join(workdir, "personas"), { recursive: true });
  config = {
    defaultPersona: "phantom",
    harnessIdleTimeoutMs: 600_000,
    harnessHardTimeoutMs: 600_000,
    personasDir: join(workdir, "personas"),
    memoryDbPath: join(workdir, "memory.sqlite"),
    configPath: join(workdir, "config.toml"),
    harnesses: {
      chain: ["claude"],
      claude: { bin: "claude", model: "opus", fallbackModel: "sonnet" },
      pi: { bin: "pi", maxPayloadBytes: 1_500_000 },
      gemini: { bin: "gemini", model: "" },
    },
    channels: {},
    embeddings: { provider: "none" },
    voice: { provider: "none" },
  };
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

async function makePersona(
  name: string,
  files: Record<string, string>,
): Promise<string> {
  const dir = join(config.personasDir, name);
  await mkdir(dir, { recursive: true });
  for (const [f, content] of Object.entries(files)) {
    await writeFile(join(dir, f), content, "utf8");
  }
  return dir;
}

describe("backfillPersonaDir", () => {
  test("legacy BOOT.md persona: gains SOUL.md, keeps BOOT.md, no IDENTITY stub", async () => {
    const dir = await makePersona("willem", { "BOOT.md": "# Willem\nOriginal identity" });
    const r = await backfillPersonaDir("willem", dir);

    expect(r.wroteSoul).toBe(true);
    expect(r.wroteIdentityStub).toBe(false);
    // BOOT.md untouched.
    expect(await readFile(join(dir, "BOOT.md"), "utf8")).toContain(
      "Original identity",
    );
    // SOUL.md added.
    expect(existsSync(join(dir, "SOUL.md"))).toBe(true);
    // No IDENTITY.md stub — BOOT.md already is the facts file.
    expect(existsSync(join(dir, "IDENTITY.md"))).toBe(false);

    // Loader now serves BOOT (facts) + SOUL (behaviour), combined.
    const p = await loadPersona(dir);
    expect(p.boot).toContain("Original identity");
    expect(p.boot).toContain("be compact");
    expect(p.identitySource).toBe("BOOT.md+SOUL.md");
  });

  test("bare persona (no identity file): gains both SOUL.md and IDENTITY.md stub", async () => {
    const dir = await makePersona("naked", { "MEMORY.md": "just memory" });
    const r = await backfillPersonaDir("naked", dir);

    expect(r.wroteSoul).toBe(true);
    expect(r.wroteIdentityStub).toBe(true);
    const identity = await readFile(join(dir, "IDENTITY.md"), "utf8");
    expect(identity).toContain("# naked");
    expect(identity).toContain("Who you work for");

    const p = await loadPersona(dir);
    expect(p.identitySource).toBe("IDENTITY.md+SOUL.md");
  });

  test("already-complete persona: no-op, nothing rewritten", async () => {
    const dir = await makePersona("done", {
      "SOUL.md": "custom soul — do not touch",
      "IDENTITY.md": "custom identity — do not touch",
    });
    const r = await backfillPersonaDir("done", dir);

    expect(r.wroteSoul).toBe(false);
    expect(r.wroteIdentityStub).toBe(false);
    expect(await readFile(join(dir, "SOUL.md"), "utf8")).toBe(
      "custom soul — do not touch",
    );
    expect(await readFile(join(dir, "IDENTITY.md"), "utf8")).toBe(
      "custom identity — do not touch",
    );
  });

  test("is idempotent — a second run changes nothing", async () => {
    const dir = await makePersona("willem", { "BOOT.md": "# Willem" });
    await backfillPersonaDir("willem", dir);
    const soulAfterFirst = await readFile(join(dir, "SOUL.md"), "utf8");

    const r2 = await backfillPersonaDir("willem", dir);
    expect(r2.wroteSoul).toBe(false);
    expect(r2.wroteIdentityStub).toBe(false);
    expect(await readFile(join(dir, "SOUL.md"), "utf8")).toBe(soulAfterFirst);
  });
});

describe("backfillAllPersonas", () => {
  test("walks every persona and reports per-persona results", async () => {
    await makePersona("a", { "BOOT.md": "# A" });
    await makePersona("b", { "MEMORY.md": "m" });
    await makePersona("c", { "SOUL.md": "s", "IDENTITY.md": "i" });

    const results = await backfillAllPersonas(config);
    expect(results.map((r) => r.name).sort()).toEqual(["a", "b", "c"]);

    const byName = Object.fromEntries(results.map((r) => [r.name, r]));
    expect(byName.a?.wroteSoul).toBe(true);
    expect(byName.a?.wroteIdentityStub).toBe(false);
    expect(byName.b?.wroteSoul).toBe(true);
    expect(byName.b?.wroteIdentityStub).toBe(true);
    expect(byName.c?.wroteSoul).toBe(false);
    expect(byName.c?.wroteIdentityStub).toBe(false);
  });
});
