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
  defaultPersonaDefect,
  defaultPersonaProvenance,
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

  test("no-ops when personas dir doesn't exist (returns null)", async () => {
    await rm(personasDir, { recursive: true });
    const config = makeConfig(personasDir, "ghostfixture");
    const healed = await healDefaultPersonaIfBroken(config);
    expect(healed).toBeNull();
  });
});

describe("adoptAsDefaultIfMissing", () => {
  test("no-ops when default already exists on disk", async () => {
    await makePersona("phantom");
    const config = makeConfig(personasDir, "phantom");
    const changed = await adoptAsDefaultIfMissing(config, "kai");
    expect(changed).toBe(false);
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

  test("repairs casing without adopting the newly created persona", async () => {
    await makePersona("Ghostfixture");
    await makePersona("kai");
    const out = new CaptureStream();
    const changed = await adoptAsDefaultIfMissing(
      makeConfig(personasDir, "ghostfixture"),
      "kai",
      out,
    );
    expect(changed).toBe(false);
    expect(out.text).toContain("normalized default_persona");
    expect((await loadState()).default_persona).toBe("Ghostfixture");
  });
});

describe("canonicalPersonaName (#475)", () => {
  test("returns exact and unique case-insensitive matches", async () => {
    await makePersona("Ghostfixture");
    const config = makeConfig(personasDir);
    expect(canonicalPersonaName(config, "Ghostfixture")).toBe("Ghostfixture");
    expect(canonicalPersonaName(config, "ghostfixture")).toBe("Ghostfixture");
  });

  test("returns null for missing and ambiguous names", async () => {
    await makePersona("Kai");
    await makePersona("KAI");
    const config = makeConfig(personasDir);
    expect(canonicalPersonaName(config, "missing")).toBeNull();
    expect(canonicalPersonaName(config, "kai")).toBeNull();
  });

  test("ignores plain files", async () => {
    await writeFile(join(personasDir, "kai"), "not a persona");
    expect(canonicalPersonaName(makeConfig(personasDir), "kai")).toBeNull();
  });
});

/**
 * A persona dir that looks like a real phantom: one marker file is enough
 * (`PERSONA_MARKERS`), which is what separates a live persona from the husk a
 * half-finished create or a moved-out migration leaves behind.
 */
async function makePersona(name: string): Promise<string> {
  const dir = join(personasDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "identity.json"), "{}", "utf8");
  return dir;
}

describe("defaultPersonaDefect (#505)", () => {
  test("a populated persona dir is usable", async () => {
    await makePersona("phantom");
    expect(defaultPersonaDefect(makeConfig(personasDir, "phantom"), "phantom"))
      .toBeNull();
  });

  test("a missing dir is a defect", () => {
    expect(defaultPersonaDefect(makeConfig(personasDir, "ghost"), "ghost"))
      .toBe("no persona dir on disk");
  });

  test("an EMPTY dir is a defect — the bug existsSync could not see", async () => {
    await mkdir(join(personasDir, "husk"), { recursive: true });
    expect(defaultPersonaDefect(makeConfig(personasDir, "husk"), "husk"))
      .toMatch(/empty/);
  });

  test("any single marker is enough, so a lazily-created identity is not required", async () => {
    const dir = join(personasDir, "fresh");
    await mkdir(dir, { recursive: true });
    // identity.json is written LAZILY on first vault open. A persona created
    // seconds ago has only its config, and must NOT be judged broken — heal
    // would otherwise repoint a brand-new host's default at an older persona.
    await writeFile(join(dir, "config.toml"), "", "utf8");
    expect(defaultPersonaDefect(makeConfig(personasDir, "fresh"), "fresh"))
      .toBeNull();
  });
});

describe("healDefaultPersonaIfBroken — husk defaults (#505)", () => {
  test("heals away from an empty default dir", async () => {
    await mkdir(join(personasDir, "husk"), { recursive: true });
    await makePersona("real");
    const out = new CaptureStream();
    const healed = await healDefaultPersonaIfBroken(
      makeConfig(personasDir, "husk"),
      out,
    );
    expect(healed).toBe("real");
    expect((await loadState()).default_persona).toBe("real");
    expect(out.text).toMatch(/empty/);
  });

  test("prefers a populated candidate over an alphabetically earlier husk", async () => {
    await mkdir(join(personasDir, "husk"), { recursive: true });
    await mkdir(join(personasDir, "ahusk"), { recursive: true });
    await makePersona("zreal");
    const healed = await healDefaultPersonaIfBroken(
      makeConfig(personasDir, "husk"),
    );
    expect(healed).toBe("zreal");
  });

  test("a case-only name match must itself be usable to win (#506 review)", async () => {
    // `kai` is broken and `Kai` is another husk: preferring the case match
    // would write a still-broken name to state.json while `real` was right
    // there. Case-insensitive is a HINT, not a licence to heal into a husk.
    await mkdir(join(personasDir, "kai"), { recursive: true });
    await mkdir(join(personasDir, "Kai"), { recursive: true });
    await makePersona("real");
    const healed = await healDefaultPersonaIfBroken(
      makeConfig(personasDir, "kai"),
    );
    expect(healed).toBe("real");
    expect((await loadState()).default_persona).toBe("real");
  });

  test("a USABLE case-only match still wins over an unrelated persona", async () => {
    await mkdir(join(personasDir, "kai"), { recursive: true });
    await makePersona("Kai");
    await makePersona("areal");
    const healed = await healDefaultPersonaIfBroken(
      makeConfig(personasDir, "kai"),
    );
    expect(healed).toBe("Kai");
  });

  test("falls back to the case match when every candidate is a husk", async () => {
    await mkdir(join(personasDir, "kai"), { recursive: true });
    await mkdir(join(personasDir, "Kai"), { recursive: true });
    await mkdir(join(personasDir, "ahusk"), { recursive: true });
    const healed = await healDefaultPersonaIfBroken(
      makeConfig(personasDir, "kai"),
    );
    expect(healed).toBe("Kai");
  });

  test("leaves a populated default alone even when other personas exist", async () => {
    await makePersona("phantom");
    await makePersona("kai");
    const healed = await healDefaultPersonaIfBroken(
      makeConfig(personasDir, "phantom"),
    );
    expect(healed).toBe("phantom");
    expect((await loadState()).default_persona).toBeUndefined();
  });
});

describe("defaultPersonaProvenance (#505)", () => {
  const SAVED_ENV = process.env.PHANTOMBOT_DEFAULT_PERSONA;
  afterEach(() => {
    if (SAVED_ENV === undefined) delete process.env.PHANTOMBOT_DEFAULT_PERSONA;
    else process.env.PHANTOMBOT_DEFAULT_PERSONA = SAVED_ENV;
  });

  test("state.json wins over config.toml, and says so", async () => {
    await writeFile(
      join(workdir, "config.toml"),
      'default_persona = "fromtoml"\n',
      "utf8",
    );
    await writeFile(
      join(workdir, "state.json"),
      JSON.stringify({ default_persona: "fromstate" }),
      "utf8",
    );
    expect(await defaultPersonaProvenance(makeConfig(personasDir))).toBe(
      "state",
    );
  });

  test("config.toml is reported only when state.json is silent", async () => {
    await writeFile(
      join(workdir, "config.toml"),
      'default_persona = "fromtoml"\n',
      "utf8",
    );
    expect(await defaultPersonaProvenance(makeConfig(personasDir))).toBe(
      "config",
    );
  });

  test("no state, no toml key → built-in fallback", async () => {
    expect(await defaultPersonaProvenance(makeConfig(personasDir))).toBe(
      "builtin",
    );
  });

  test("the env override outranks everything", async () => {
    process.env.PHANTOMBOT_DEFAULT_PERSONA = "fromenv";
    await writeFile(
      join(workdir, "state.json"),
      JSON.stringify({ default_persona: "fromstate" }),
      "utf8",
    );
    expect(await defaultPersonaProvenance(makeConfig(personasDir))).toBe("env");
  });
});
