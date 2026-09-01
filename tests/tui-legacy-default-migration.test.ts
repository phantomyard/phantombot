/**
 * Legacy default_persona migration (follow-up to #509).
 *
 * REGRESSION test for the #509 opening doctrine vs the installed base.
 * Pre-#509 the TUI silently fell back to `personas[0]`'s chat when no
 * default_persona was configured anywhere. #509 made that fallback the
 * wizard — correct for NEW installs (nothing set up yet), but it shoved a
 * working legacy host into the create flow on first launch after upgrade.
 *
 * The migration makes the old fallback explicit ONCE: personas on disk +
 * provenance "builtin" (env > state.json > config.toml all silent) →
 * `default_persona` = the pre-#509 fallback choice (resolved default, else
 * personas[0]) written to config.toml, and the resolver
 * proceeds exactly as if the operator had configured it.
 *
 * Pinned guarantees:
 *  - a legacy host opens in chat/configure, NEVER the wizard;
 *  - an explicit default (config.toml, state.json, or env) is NEVER touched;
 *  - no personas on disk → wizard, and nothing is written.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveOpeningScreen } from "../src/tui/index.tsx";

const ENV_KEYS = [
  "PHANTOMBOT_CONFIG",
  "PHANTOMBOT_PERSONAS_DIR",
  "PHANTOMBOT_STATE",
  "PHANTOMBOT_STATE_AUDIT",
  "PHANTOMBOT_DEFAULT_PERSONA",
] as const;

let workdir: string;
let configPath: string;
let personasDir: string;
const saved: Record<string, string | undefined> = {};

async function makePersona(name: string): Promise<void> {
  const dir = join(personasDir, name);
  await mkdir(dir, { recursive: true });
  // identity.json is the one wizard-fixable gate (personaCompleteness);
  // without it the resolver would route to the wizard for completeness, not
  // for the missing default — hiding the regression this file pins.
  await writeFile(join(dir, "identity.json"), "{}", "utf8");
}

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-legacy-default-"));
  configPath = join(workdir, "config.toml");
  personasDir = join(workdir, "personas");
  await mkdir(personasDir, { recursive: true });
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.PHANTOMBOT_CONFIG = configPath;
  process.env.PHANTOMBOT_PERSONAS_DIR = personasDir;
  process.env.PHANTOMBOT_STATE = join(workdir, "state.json");
  process.env.PHANTOMBOT_STATE_AUDIT = join(workdir, "state-audit.log");
  delete process.env.PHANTOMBOT_DEFAULT_PERSONA;
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  await rm(workdir, { recursive: true, force: true });
});

describe("resolveOpeningScreen — legacy default migration", () => {
  test("legacy host (personas, no default anywhere) adopts personas[0] and opens chat", async () => {
    await makePersona("lena");
    await writeFile(configPath, "", "utf8");

    const opening = await resolveOpeningScreen();

    // Identity is present, so the migrated default routes straight past the
    // wizard — chat (brain recorded) or configure (brain pending), exactly the
    // screens a working host gets. NEVER the wizard.
    expect(opening.screen === "chat" || opening.screen === "configure").toBe(
      true,
    );
    expect(opening.persona).toBe("lena");

    const toml = await readFile(configPath, "utf8");
    expect(toml).toContain('default_persona = "lena"');
  });

  test("an explicit config.toml default is never overwritten", async () => {
    await makePersona("lena");
    await makePersona("kai");
    await writeFile(configPath, 'default_persona = "kai"\n', "utf8");

    const opening = await resolveOpeningScreen();

    expect(opening.screen).not.toBe("wizard");
    expect(opening.persona).toBe("kai");
    const toml = await readFile(configPath, "utf8");
    expect(toml).toContain('default_persona = "kai"');
    expect(toml).not.toContain('"lena"');
  });

  test("a state.json default wins and is respected (no config write)", async () => {
    await makePersona("lena");
    await writeFile(configPath, "", "utf8");
    await writeFile(
      join(workdir, "state.json"),
      JSON.stringify({ default_persona: "lena" }),
      "utf8",
    );

    const opening = await resolveOpeningScreen();

    expect(opening.screen).not.toBe("wizard");
    expect(await readFile(configPath, "utf8")).not.toContain("default_persona");
  });

  test("no personas on disk → wizard, nothing written", async () => {
    await writeFile(configPath, "", "utf8");

    const opening = await resolveOpeningScreen();

    expect(opening.screen).toBe("wizard");
    expect(await readFile(configPath, "utf8")).not.toContain("default_persona");
  });

  test("adoption matches the pre-#509 fallback exactly: a 'phantom' persona wins over personas[0]", async () => {
    // The unconfigured defaultPersona resolves to the builtin "phantom"
    // (config.ts), and the old fallback was
    // `personas.find((p) => p.name === defaultPersona) ?? personas[0]` — so a
    // host with both personas opened "phantom", not the alphabetically first.
    await makePersona("alpha");
    await makePersona("phantom");
    await writeFile(configPath, "", "utf8");

    const opening = await resolveOpeningScreen();

    expect(opening.screen === "chat" || opening.screen === "configure").toBe(
      true,
    );
    expect(opening.persona).toBe("phantom");
    const toml = await readFile(configPath, "utf8");
    expect(toml).toContain('default_persona = "phantom"');
  });

  test("migration is one-shot: second run changes nothing", async () => {
    await makePersona("lena");
    await writeFile(configPath, "", "utf8");

    await resolveOpeningScreen();
    const once = await readFile(configPath, "utf8");
    await resolveOpeningScreen();
    expect(await readFile(configPath, "utf8")).toBe(once);
  });
});

describe("migrateLegacyAutostartModes (legacy-install migration)", () => {
  // Unit tests with injected probes — the real probes read HOST state (linger
  // / LaunchDaemons / task markers), which differs across the dev fleet, so
  // exact mode values are pinned here via the seams only.
  const {
    migrateLegacyAutostartModes,
  } = require("../src/lib/personaDefault.ts") as typeof import("../src/lib/personaDefault.ts");
  const { loadConfig } = require("../src/config.ts") as typeof import("../src/config.ts");

  test("legacy signature (autostart_personas, no records) → backfilled per platform", async () => {
    await writeFile(
      configPath,
      'autostart_personas = ["lena", "kai"]\n',
      "utf8",
    );
    const config = await loadConfig();

    const { currentPlatform } = await import("../src/lib/platform.ts");
    await migrateLegacyAutostartModes(config, {
      // Must never be consulted on Linux (see the Linux pin below).
      bootProbe: async (name: string) => name === "lena",
    });

    const toml = await readFile(configPath, "utf8");
    expect(toml).toContain("[autostart_modes]");
    if (currentPlatform() === "linux") {
      // Linux never probes: linger is an installer default, not a Boot
      // choice, so the record is ALWAYS login.
      expect(toml).toContain('lena = "login"');
      expect(toml).toContain('kai = "login"');
      expect(config.autostartModes).toEqual({ lena: "login", kai: "login" });
    } else {
      expect(toml).toContain('lena = "boot"');
      expect(toml).toContain('kai = "login"');
      expect(config.autostartModes).toEqual({ lena: "boot", kai: "login" });
    }
  });

  test("linux: record is login unconditionally — no probe is ever consulted", async () => {
    const { currentPlatform } = await import("../src/lib/platform.ts");
    if (currentPlatform() !== "linux") return; // pinned by the linux CI job
    await writeFile(
      configPath,
      // Host with linger on and the unit enabled — the standard-installer
      // state that must NOT produce a boot record (teardown authority).
      'autostart_personas = ["lena"]\n',
      "utf8",
    );
    const config = await loadConfig();

    await migrateLegacyAutostartModes(config, {
      bootProbe: async () => {
        throw new Error("linux backfill must never probe boot state");
      },
    });

    const toml = await readFile(configPath, "utf8");
    expect(toml).toContain('lena = "login"');
    expect(toml).not.toContain('lena = "boot"');
  });

  test("any existing records → no-op (never overwrites an operator choice)", async () => {
    await writeFile(
      configPath,
      'autostart_personas = ["lena"]\n\n[autostart_modes]\nlena = "login"\n',
      "utf8",
    );
    const config = await loadConfig();

    await migrateLegacyAutostartModes(config, {
      bootProbe: async () => true,
    });

    const toml = await readFile(configPath, "utf8");
    expect(toml).toContain('lena = "login"');
    expect(toml).not.toContain('lena = "boot"');
  });

  test("no autostart_personas and no chosen default → nothing written", async () => {
    await writeFile(configPath, 'update_channel = "preview"\n', "utf8");
    const config = await loadConfig();

    await migrateLegacyAutostartModes(config, {
      bootProbe: async () => true,
    });

    expect(await readFile(configPath, "utf8")).not.toContain("autostart_modes");
  });

  // #512 — the shape a single-persona `phantombot install` actually leaves:
  // a default_persona and NO autostart_personas key at all. Verified on Matt
  // (macOS, LaunchAgent dev.phantombot.phantombot.plist) and Megan (Windows,
  // \Phantombot\phantombot-megan at logon) on 2026-09-01: both were serving
  // their persona at every login while the TUI reported Autostart: off,
  // because the gate here was "autostart_personas is non-empty" and this
  // migration never ran at all.
  test("default_persona with NO autostart_personas → the default is backfilled", async () => {
    await writeFile(configPath, 'default_persona = "lena"\n', "utf8");
    const config = await loadConfig();

    const { currentPlatform } = await import("../src/lib/platform.ts");
    await migrateLegacyAutostartModes(config, {
      bootProbe: async () => true,
    });

    const toml = await readFile(configPath, "utf8");
    expect(toml).toContain("[autostart_modes]");
    // Linux is still login unconditionally (#511 doctrine, unchanged): an
    // enabled unit is the installer's default, never a Boot choice.
    expect(toml).toContain(
      currentPlatform() === "linux" ? 'lena = "login"' : 'lena = "boot"',
    );
  });

  test("a builtin-provenance default is NOT treated as served", async () => {
    // Nothing chose a default — `config.defaultPersona` is only the bare
    // fallback name, and may not exist on disk. Backfilling a record for it
    // would invent autostart state nobody asked for.
    await writeFile(configPath, 'autostart_personas = ["lena"]\n', "utf8");
    const config = await loadConfig();

    await migrateLegacyAutostartModes(config, { bootProbe: async () => false });

    const toml = await readFile(configPath, "utf8");
    expect(toml).toContain('lena = "login"');
    expect(toml).not.toContain("phantom =");
  });

  test("default already on the list is recorded once, not twice", async () => {
    await writeFile(
      configPath,
      'default_persona = "lena"\nautostart_personas = ["lena", "kai"]\n',
      "utf8",
    );
    const config = await loadConfig();

    await migrateLegacyAutostartModes(config, { bootProbe: async () => false });

    const toml = await readFile(configPath, "utf8");
    expect(toml.match(/^lena = /gm)?.length).toBe(1);
    expect(Object.keys(config.autostartModes ?? {}).sort()).toEqual([
      "kai",
      "lena",
    ]);
  });
});

describe("resolveOpeningScreen — legacy autostart backfill", () => {
  test("legacy host gets [autostart_modes] records on first launch", async () => {
    await makePersona("lena");
    await writeFile(configPath, 'autostart_personas = ["lena"]\n', "utf8");

    await resolveOpeningScreen();

    const toml = await readFile(configPath, "utf8");
    expect(toml).toContain("default_persona");
    expect(toml).toContain("[autostart_modes]");
    // Linux always records login (conservative, never arms teardown);
    // mac/win record from ours-only probes. Either way a valid record,
    // never a missing table.
    expect(toml).toMatch(/lena = "(boot|login)"/);
  });
});

describe("resolveOpeningScreen — broken default heals instead of wizard", () => {
  test("stale state default + operator config.toml default → heals to the config choice", async () => {
    await makePersona("lena");
    await makePersona("jake");
    await writeFile(
      configPath,
      'default_persona = "lena"\nautostart_personas = ["lena"]\n',
      "utf8",
    );
    await writeFile(
      join(workdir, "state.json"),
      JSON.stringify({ default_persona: "Phantom" }),
      "utf8",
    );

    const opening = await resolveOpeningScreen();

    expect(opening.screen).not.toBe("wizard");
    expect(opening.persona).toBe("lena");
    // The stale state entry is rewritten once — the host is now consistent.
    const state = JSON.parse(await readFile(join(workdir, "state.json"), "utf8"));
    expect(state.default_persona).toBe("lena");
  });

  test("stale state default, no config default → generic heal (first usable)", async () => {
    await makePersona("jake");
    await writeFile(configPath, "", "utf8");
    await writeFile(
      join(workdir, "state.json"),
      JSON.stringify({ default_persona: "Phantom" }),
      "utf8",
    );

    const opening = await resolveOpeningScreen();

    expect(opening.screen).not.toBe("wizard");
    expect(opening.persona).toBe("jake");
    const state = JSON.parse(await readFile(join(workdir, "state.json"), "utf8"));
    expect(state.default_persona).toBe("jake");
  });

  test("broken default and no personas at all → wizard, nothing healed", async () => {
    await writeFile(configPath, "", "utf8");
    await writeFile(
      join(workdir, "state.json"),
      JSON.stringify({ default_persona: "Phantom" }),
      "utf8",
    );

    const opening = await resolveOpeningScreen();

    expect(opening.screen).toBe("wizard");
    const state = JSON.parse(await readFile(join(workdir, "state.json"), "utf8"));
    expect(state.default_persona).toBe("Phantom");
  });
});
