/**
 * Per-persona config layering + migration (phantombot#439).
 *
 * The invariants under test are the ones that make `/update` safe to type at
 * any time from any version: the merge never invents a default, migration
 * copies without deleting, and running it twice changes nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HOST_ONLY_KEYS,
  mergeToml,
  migratePersonaConfig,
  personaConfigPath,
  readPersonaToml,
  stripHostOnlyKeys,
} from "../src/lib/personaConfig.ts";
import { loadConfig } from "../src/config.ts";
import { readConfigToml } from "../src/lib/configWriter.ts";

let workdir: string;
let personasDir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-personacfg-"));
  personasDir = join(workdir, "personas");
  await mkdir(join(personasDir, "robbie"), { recursive: true });
  await mkdir(join(personasDir, "lena"), { recursive: true });
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("mergeToml", () => {
  test("merges per key, override wins, tables recurse", () => {
    const merged = mergeToml(
      {
        chattiness: true,
        channels: {
          telegram: { token: "global", poll_timeout_s: 30 },
        },
      },
      { channels: { telegram: { token: "persona" } } },
    );
    expect(merged).toEqual({
      chattiness: true,
      channels: { telegram: { token: "persona", poll_timeout_s: 30 } },
    });
  });

  test("a key absent from the override falls back to the base, not a default", () => {
    const merged = mergeToml({ voice: { provider: "elevenlabs" } }, {});
    expect(merged).toEqual({ voice: { provider: "elevenlabs" } });
  });

  test("arrays replace wholesale so a persona can NARROW an allowlist", () => {
    const merged = mergeToml(
      { channels: { telegram: { allowed_user_ids: [1, 2, 3] } } },
      { channels: { telegram: { allowed_user_ids: [2] } } },
    );
    expect(
      (merged.channels as any).telegram.allowed_user_ids,
    ).toEqual([2]);
  });

  test("neither input is mutated", () => {
    const base = { channels: { telegram: { token: "a" } } };
    const override = { channels: { telegram: { token: "b" } } };
    mergeToml(base, override);
    expect(base.channels.telegram.token).toBe("a");
    expect(override.channels.telegram.token).toBe("b");
  });
});

describe("stripHostOnlyKeys", () => {
  test("drops every host-level key and keeps the rest", () => {
    const stripped = stripHostOnlyKeys({
      default_persona: "evil",
      update_channel: "preview",
      personas_dir: "/tmp/elsewhere",
      memory_db: "/tmp/other.sqlite",
      autostart_personas: ["evil"],
      chattiness: false,
    });
    expect(stripped).toEqual({ chattiness: false });
    for (const key of HOST_ONLY_KEYS) {
      expect(Object.keys(stripped)).not.toContain(key);
    }
  });
});

describe("migratePersonaConfig", () => {
  const globalToml = {
    default_persona: "robbie",
    update_channel: "preview",
    chattiness: false,
    voice: { provider: "elevenlabs" },
    channels: {
      telegram: {
        token: "default-bot",
        allowed_user_ids: [7],
        personas: { lena: { token: "lena-bot" } },
      },
    },
    harnesses: {
      chain: ["claude"],
      claude: { bin: "/usr/bin/claude" },
      personas: { lena: { chain: ["pi", "claude"] } },
    },
  };

  test("seeds the default persona with the persona-scoped keys only", async () => {
    const r = await migratePersonaConfig({
      personasDir,
      persona: "robbie",
      globalToml,
      isDefault: true,
    });
    expect(r.migrated).toBe(true);

    const written = await readPersonaToml(personasDir, "robbie");
    expect(written.chattiness).toBe(false);
    expect(written.voice).toEqual({ provider: "elevenlabs" });
    expect((written.channels as any).telegram.token).toBe("default-bot");
    // Host-level keys never travel into a persona file...
    expect(written.default_persona).toBeUndefined();
    expect(written.update_channel).toBeUndefined();
    // ...and neither does the host's persona→bot routing table.
    expect((written.channels as any).telegram.personas).toBeUndefined();
    // Harness BINS are host-level; only a persona's own chain moves.
    expect(written.harnesses).toBeUndefined();
  });

  test("a non-default persona takes its OWN bot, never the default's", async () => {
    await migratePersonaConfig({
      personasDir,
      persona: "lena",
      globalToml,
      isDefault: false,
    });
    const written = await readPersonaToml(personasDir, "lena");
    expect((written.channels as any).telegram.token).toBe("lena-bot");
    // Its per-persona harness chain becomes its plain chain.
    expect((written.harnesses as any).chain).toEqual(["pi", "claude"]);
  });

  test("a non-default persona with no bot of its own inherits none", async () => {
    await mkdir(join(personasDir, "kai"), { recursive: true });
    await migratePersonaConfig({
      personasDir,
      persona: "kai",
      globalToml,
      isDefault: false,
    });
    const written = await readPersonaToml(personasDir, "kai");
    expect((written.channels as any)?.telegram).toBeUndefined();
  });

  test("NEVER deletes from the global file", async () => {
    const globalPath = join(workdir, "config.toml");
    const before = 'default_persona = "robbie"\n\n[channels.telegram]\ntoken = "default-bot"\n';
    await writeFile(globalPath, before, "utf8");
    await migratePersonaConfig({
      personasDir,
      persona: "robbie",
      globalToml: await readConfigToml(globalPath),
      isDefault: true,
    });
    expect(await readFile(globalPath, "utf8")).toBe(before);
  });

  test("idempotent: a second run is a no-op and never clobbers hand edits", async () => {
    await migratePersonaConfig({
      personasDir,
      persona: "robbie",
      globalToml,
      isDefault: true,
    });
    const path = personaConfigPath(personasDir, "robbie");
    await writeFile(path, 'chattiness = true\n', "utf8");

    const second = await migratePersonaConfig({
      personasDir,
      persona: "robbie",
      globalToml,
      isDefault: true,
    });
    expect(second).toEqual({ migrated: false, reason: "exists" });
    expect(await readFile(path, "utf8")).toBe("chattiness = true\n");
  });

  test("a host with nothing persona-scoped grows no empty file", async () => {
    const r = await migratePersonaConfig({
      personasDir,
      persona: "robbie",
      globalToml: { default_persona: "robbie" },
      isDefault: true,
    });
    expect(r).toEqual({ migrated: false, reason: "nothing-to-copy" });
    expect(await readPersonaToml(personasDir, "robbie")).toEqual({});
  });
});

describe("loadConfig persona layering", () => {
  const SAVED = {
    config: process.env.PHANTOMBOT_CONFIG,
    personas: process.env.PHANTOMBOT_PERSONAS_DIR,
    state: process.env.PHANTOMBOT_STATE,
    persona: process.env.PHANTOMBOT_DEFAULT_PERSONA,
  };

  beforeEach(() => {
    process.env.PHANTOMBOT_CONFIG = join(workdir, "config.toml");
    process.env.PHANTOMBOT_PERSONAS_DIR = personasDir;
    process.env.PHANTOMBOT_STATE = join(workdir, "state.json");
    delete process.env.PHANTOMBOT_DEFAULT_PERSONA;
  });
  afterEach(() => {
    for (const [k, v] of [
      ["PHANTOMBOT_CONFIG", SAVED.config],
      ["PHANTOMBOT_PERSONAS_DIR", SAVED.personas],
      ["PHANTOMBOT_STATE", SAVED.state],
      ["PHANTOMBOT_DEFAULT_PERSONA", SAVED.persona],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("no persona file = exactly the pre-#439 behaviour", async () => {
    await writeFile(
      process.env.PHANTOMBOT_CONFIG!,
      'default_persona = "robbie"\n\n[channels.telegram]\ntoken = "global-bot"\n',
      "utf8",
    );
    const config = await loadConfig();
    expect(config.channels.telegram?.token).toBe("global-bot");
    expect(config.personaLayer).toBe("robbie");
    expect(config.autostartPersonas).toEqual([]);
  });

  test("the persona file wins per key; unmentioned keys fall back to global", async () => {
    await writeFile(
      process.env.PHANTOMBOT_CONFIG!,
      'default_persona = "robbie"\nchattiness = false\n\n' +
        '[channels.telegram]\ntoken = "global-bot"\npoll_timeout_s = 11\n',
      "utf8",
    );
    await writeFile(
      personaConfigPath(personasDir, "robbie"),
      '[channels.telegram]\ntoken = "robbie-bot"\n',
      "utf8",
    );
    const config = await loadConfig();
    expect(config.channels.telegram?.token).toBe("robbie-bot");
    expect(config.channels.telegram?.pollTimeoutS).toBe(11);
    expect(config.chattiness).toBe(false);
  });

  test("loadConfig(name) layers ANOTHER persona without changing the default", async () => {
    await writeFile(
      process.env.PHANTOMBOT_CONFIG!,
      'default_persona = "robbie"\n\n[channels.telegram]\ntoken = "global-bot"\n',
      "utf8",
    );
    await writeFile(
      personaConfigPath(personasDir, "lena"),
      '[channels.telegram]\ntoken = "lena-bot"\n',
      "utf8",
    );
    const lena = await loadConfig("lena");
    expect(lena.channels.telegram?.token).toBe("lena-bot");
    expect(lena.defaultPersona).toBe("robbie");
    expect(lena.personaLayer).toBe("lena");
  });

  test("a persona cannot elect itself default or move the host's channel", async () => {
    await writeFile(
      process.env.PHANTOMBOT_CONFIG!,
      'default_persona = "robbie"\nupdate_channel = "stable"\n',
      "utf8",
    );
    await writeFile(
      personaConfigPath(personasDir, "lena"),
      'default_persona = "lena"\nupdate_channel = "preview"\n' +
        `personas_dir = "${join(workdir, "hijacked")}"\n`,
      "utf8",
    );
    const config = await loadConfig("lena");
    expect(config.defaultPersona).toBe("robbie");
    expect(config.updateChannel).toBe("stable");
    expect(config.personasDir).toBe(personasDir);
  });

  test("autostart_personas parses, trims, dedupes and survives junk", async () => {
    await writeFile(
      process.env.PHANTOMBOT_CONFIG!,
      'default_persona = "robbie"\nautostart_personas = ["lena", " kai ", "lena", ""]\n',
      "utf8",
    );
    expect((await loadConfig()).autostartPersonas).toEqual(["lena", "kai"]);

    await writeFile(
      process.env.PHANTOMBOT_CONFIG!,
      'default_persona = "robbie"\nautostart_personas = "lena"\n',
      "utf8",
    );
    expect((await loadConfig()).autostartPersonas).toEqual([]);
  });
});
