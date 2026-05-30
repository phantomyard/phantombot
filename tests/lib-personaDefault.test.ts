/**
 * Tests for personaDefault.ts — healDefaultPersonaIfBroken and
 * adoptAsDefaultIfMissing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adoptAsDefaultIfMissing,
  healDefaultPersonaIfBroken,
} from "../src/lib/personaDefault.ts";
import type { Config } from "../src/config.ts";
import { loadState } from "../src/state.ts";

class CaptureStream {
  chunks: string[] = [];
  write(s: string | Uint8Array): boolean {
    this.chunks.push(typeof s === "string" ? s : new TextDecoder().decode(s));
    return true;
  }
  get text(): string {
    return this.chunks.join("");
  }
}

function makeConfig(personasDir: string, defaultPersona = "phantom"): Config {
  return {
    defaultPersona,
    harnessIdleTimeoutMs: 600_000, harnessHardTimeoutMs: 600_000,
    personasDir,
    memoryDbPath: join(personasDir, "..", "memory.sqlite"),
    configPath: join(personasDir, "..", "config.toml"),
    harnesses: {
      chain: ["claude"],
      claude: { bin: "claude", model: "opus", fallbackModel: "sonnet" },
      pi: { bin: "pi", maxPayloadBytes: 1_000_000 },
      gemini: { bin: "gemini", model: "" },
    },
    channels: {},
    embeddings: { provider: "none" },
    voice: { provider: "none" },
  };
}

const SAVED_STATE = process.env.PHANTOMBOT_STATE;

let workdir: string;
let personasDir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-pd-"));
  personasDir = join(workdir, "personas");
  await mkdir(personasDir, { recursive: true });
  process.env.PHANTOMBOT_STATE = join(workdir, "state.json");
});

afterEach(async () => {
  if (SAVED_STATE === undefined) delete process.env.PHANTOMBOT_STATE;
  else process.env.PHANTOMBOT_STATE = SAVED_STATE;
  await rm(workdir, { recursive: true, force: true });
});

describe("healDefaultPersonaIfBroken", () => {
  test("returns the current default when it has an identity file", async () => {
    await mkdir(join(personasDir, "phantom"), { recursive: true });
    await writeFile(join(personasDir, "phantom", "BOOT.md"), "# Phantom");
    const config = makeConfig(personasDir, "phantom");
    const healed = await healDefaultPersonaIfBroken(config);
    expect(healed).toBe("phantom");
  });

  test("returns null when no personas exist at all", async () => {
    const config = makeConfig(personasDir, "phantom");
    const healed = await healDefaultPersonaIfBroken(config);
    expect(healed).toBeNull();
  });

  test("heals to the only persona on disk", async () => {
    await mkdir(join(personasDir, "kai"), { recursive: true });
    await writeFile(join(personasDir, "kai", "BOOT.md"), "# Kai");
    const config = makeConfig(personasDir, "ghostfixture");
    const out = new CaptureStream();
    const healed = await healDefaultPersonaIfBroken(config, out);
    expect(healed).toBe("kai");
    expect(out.text).toContain("ghostfixture' → 'kai'");

    // Verify state.json was written.
    const state = await loadState();
    expect(state.default_persona).toBe("kai");
  });

  test("picks first alphabetically when no name match exists", async () => {
    await mkdir(join(personasDir, "lena"), { recursive: true });
    await writeFile(join(personasDir, "lena", "BOOT.md"), "# Lena");
    await mkdir(join(personasDir, "kai"), { recursive: true });
    await writeFile(join(personasDir, "kai", "BOOT.md"), "# Kai");
    const config = makeConfig(personasDir, "ghostfixture");
    const healed = await healDefaultPersonaIfBroken(config);
    // Sorted: "kai", "lena" → picks "kai"
    expect(healed).toBe("kai");
  });

  test("prefers case-insensitive name match over first alphabetical", async () => {
    await mkdir(join(personasDir, "Ghostfixture"), { recursive: true });
    await writeFile(join(personasDir, "Ghostfixture", "BOOT.md"), "# Ghost");
    await mkdir(join(personasDir, "kai"), { recursive: true });
    await writeFile(join(personasDir, "kai", "BOOT.md"), "# Kai");
    const config = makeConfig(personasDir, "ghostfixture");
    const healed = await healDefaultPersonaIfBroken(config);
    expect(healed).toBe("Ghostfixture");
  });

  test("no-ops when personas dir doesn't exist (returns null)", async () => {
    await rm(personasDir, { recursive: true });
    const config = makeConfig(personasDir, "ghostfixture");
    const healed = await healDefaultPersonaIfBroken(config);
    expect(healed).toBeNull();
  });

  test("heals away from an empty default directory to a valid persona", async () => {
    await mkdir(join(personasDir, "robbie"), { recursive: true });
    await mkdir(join(personasDir, "kai"), { recursive: true });
    await writeFile(join(personasDir, "kai", "BOOT.md"), "# Kai");
    const config = makeConfig(personasDir, "robbie");
    const out = new CaptureStream();

    const healed = await healDefaultPersonaIfBroken(config, out);

    expect(healed).toBe("kai");
    expect(out.text).toContain("robbie' → 'kai'");
    expect((await loadState()).default_persona).toBe("kai");
  });
});

describe("adoptAsDefaultIfMissing", () => {
  test("no-ops when default already exists on disk", async () => {
    await mkdir(join(personasDir, "phantom"), { recursive: true });
    await writeFile(join(personasDir, "phantom", "BOOT.md"), "# Phantom");
    const config = makeConfig(personasDir, "phantom");
    const changed = await adoptAsDefaultIfMissing(config, "kai");
    expect(changed).toBe(false);
  });

  test("adopts the given name when default is missing", async () => {
    await mkdir(join(personasDir, "kai"), { recursive: true });
    await writeFile(join(personasDir, "kai", "BOOT.md"), "# Kai");
    const config = makeConfig(personasDir, "ghostfixture");
    const out = new CaptureStream();
    const changed = await adoptAsDefaultIfMissing(config, "kai", out);
    expect(changed).toBe(true);
    expect(out.text).toContain("adopted 'kai'");

    const state = await loadState();
    expect(state.default_persona).toBe("kai");
  });

  test("adopts the given name when default dir exists but has no identity", async () => {
    await mkdir(join(personasDir, "robbie"), { recursive: true });
    await mkdir(join(personasDir, "kai"), { recursive: true });
    await writeFile(join(personasDir, "kai", "BOOT.md"), "# Kai");
    const config = makeConfig(personasDir, "robbie");

    const changed = await adoptAsDefaultIfMissing(config, "kai");

    expect(changed).toBe(true);
    expect((await loadState()).default_persona).toBe("kai");
  });
});
