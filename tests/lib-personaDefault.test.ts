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
  canonicalPersonaName,
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
    harnessIdleTimeoutMs: 600_000, harnessHardTimeoutMs: 600_000, harnessStartupTimeoutMs: 600_000,
    personasDir,
    memoryDbPath: join(personasDir, "..", "memory.sqlite"),
    configPath: join(personasDir, "..", "config.toml"),
    harnesses: {
      chain: ["claude"],
      claude: { bin: "claude", model: "opus", fallbackModel: "sonnet" },
      pi: { bin: "pi", maxPayloadBytes: 1_000_000 },
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
    await mkdir(join(personasDir, "kai"), { recursive: true });
    const config = makeConfig(personasDir, "ghostfixture");
    const healed = await healDefaultPersonaIfBroken(config);
    // Sorted: "kai", "lena" → picks "kai"
    expect(healed).toBe("kai");
  });

  test("prefers case-insensitive name match over first alphabetical", async () => {
    await mkdir(join(personasDir, "Ghostfixture"), { recursive: true });
    await mkdir(join(personasDir, "kai"), { recursive: true });
    const config = makeConfig(personasDir, "ghostfixture");
    const healed = await healDefaultPersonaIfBroken(config);
    expect(healed).toBe("Ghostfixture");
  });

  // Regression: `existsSync(personaDir(...))` answers case-INSENSITIVELY on
  // macOS/Windows, so a wrong-cased default looked healthy and was handed on
  // verbatim as the persona key for drawer_entries/journal_entries — same
  // files, a different memory namespace, memory silently empty.
  test("normalizes a wrong-cased default even when it is the only persona", async () => {
    await mkdir(join(personasDir, "Ghostfixture"), { recursive: true });
    const config = makeConfig(personasDir, "ghostfixture");
    const out = new CaptureStream();
    const healed = await healDefaultPersonaIfBroken(config, out);
    expect(healed).toBe("Ghostfixture");
    expect(out.text).toContain("case mismatch");

    // The healed spelling has to be persisted, not just returned: every other
    // consumer reads it back off state.json.
    const state = await loadState();
    expect(state.default_persona).toBe("Ghostfixture");
  });

  test("does not rewrite state when the default is already canonical", async () => {
    await mkdir(join(personasDir, "Ghostfixture"), { recursive: true });
    const config = makeConfig(personasDir, "Ghostfixture");
    const out = new CaptureStream();
    const healed = await healDefaultPersonaIfBroken(config, out);
    expect(healed).toBe("Ghostfixture");
    expect(out.text).toBe("");
  });

  test("no-ops when personas dir doesn't exist (returns null)", async () => {
    await rm(personasDir, { recursive: true });
    const config = makeConfig(personasDir, "ghostfixture");
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

  test("repairs the casing instead of adopting when the default is only mis-cased", async () => {
    await mkdir(join(personasDir, "Ghostfixture"), { recursive: true });
    await mkdir(join(personasDir, "kai"), { recursive: true });
    const config = makeConfig(personasDir, "ghostfixture");
    const out = new CaptureStream();
    const changed = await adoptAsDefaultIfMissing(config, "kai", out);
    // 'kai' was NOT adopted — the existing default persona keeps the default.
    expect(changed).toBe(false);
    expect(out.text).toContain("normalized default_persona");

    const state = await loadState();
    expect(state.default_persona).toBe("Ghostfixture");
  });

  test("adopts the given name when default is missing", async () => {
    await mkdir(join(personasDir, "kai"), { recursive: true });
    const config = makeConfig(personasDir, "ghostfixture");
    const out = new CaptureStream();
    const changed = await adoptAsDefaultIfMissing(config, "kai", out);
    expect(changed).toBe(true);
    expect(out.text).toContain("adopted 'kai'");

    const state = await loadState();
    expect(state.default_persona).toBe("kai");
  });
});

describe("canonicalPersonaName", () => {
  test("returns the name unchanged on an exact match", async () => {
    await mkdir(join(personasDir, "kai"), { recursive: true });
    expect(canonicalPersonaName(makeConfig(personasDir), "kai")).toBe("kai");
  });

  test("returns the on-disk spelling for a case variant", async () => {
    await mkdir(join(personasDir, "Ghostfixture"), { recursive: true });
    expect(canonicalPersonaName(makeConfig(personasDir), "ghostfixture")).toBe(
      "Ghostfixture",
    );
  });

  test("returns null when nothing backs the name", async () => {
    await mkdir(join(personasDir, "kai"), { recursive: true });
    expect(canonicalPersonaName(makeConfig(personasDir), "lena")).toBeNull();
  });

  test("returns null when the personas dir is absent", async () => {
    await rm(personasDir, { recursive: true });
    expect(canonicalPersonaName(makeConfig(personasDir), "kai")).toBeNull();
  });

  test("ignores plain files sharing the name", async () => {
    await writeFile(join(personasDir, "kai"), "not a persona");
    expect(canonicalPersonaName(makeConfig(personasDir), "kai")).toBeNull();
  });
});
