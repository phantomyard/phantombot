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
import { loadState, saveState, type State } from "../src/state.ts";

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

let workdir: string;
let personasDir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-pd-"));
  personasDir = join(workdir, "personas");
  await mkdir(personasDir, { recursive: true });
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("healDefaultPersonaIfBroken", () => {
  test("returns the current default when it exists on disk", async () => {
    await mkdir(join(personasDir, "phantom"), { recursive: true });
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
    const config = makeConfig(personasDir, "robbie");
    const out = new CaptureStream();
    const healed = await healDefaultPersonaIfBroken(config, out);
    expect(healed).toBe("kai");
    expect(out.text).toContain("robbie' → 'kai'");

    // Verify state.json was written.
    const state = await loadState();
    expect(state.default_persona).toBe("kai");
  });

  test("picks first alphabetically when no name match exists", async () => {
    await mkdir(join(personasDir, "lena"), { recursive: true });
    await mkdir(join(personasDir, "kai"), { recursive: true });
    const config = makeConfig(personasDir, "robbie");
    const healed = await healDefaultPersonaIfBroken(config);
    // Sorted: "kai", "lena" → picks "kai"
    expect(healed).toBe("kai");
  });

  test("no-ops when personas dir doesn't exist (returns null)", async () => {
    await rm(personasDir, { recursive: true });
    const config = makeConfig(personasDir, "robbie");
    const healed = await healDefaultPersonaIfBroken(config);
    expect(healed).toBeNull();
  });
});

describe("adoptAsDefaultIfMissing", () => {
  test("no-ops when default already exists on disk", async () => {
    await mkdir(join(personasDir, "phantom"), { recursive: true });
    const config = makeConfig(personasDir, "phantom");
    const changed = await adoptAsDefaultIfMissing(config, "kai");
    expect(changed).toBe(false);
  });

  test("adopts the given name when default is missing", async () => {
    await mkdir(join(personasDir, "kai"), { recursive: true });
    const config = makeConfig(personasDir, "robbie");
    const out = new CaptureStream();
    const changed = await adoptAsDefaultIfMissing(config, "kai", out);
    expect(changed).toBe(true);
    expect(out.text).toContain("adopted 'kai'");

    const state = await loadState();
    expect(state.default_persona).toBe("kai");
  });
});
