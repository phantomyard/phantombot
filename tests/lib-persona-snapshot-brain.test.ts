/**
 * The settings badge must speak the SAME brain predicate as the boot gate.
 *
 * Reported live: a default persona whose Brain flow wrote the chain to the
 * host config as `[harnesses.personas.<name>]` (the #441 legacy shape) chatted
 * happily, yet PersonaDetail showed red `required` forever — the snapshot's
 * `brainConfigured` read only the persona's own config file, and the chain it
 * probed ignored the personas-table record too. The snapshot now delegates to
 * the shared predicate (`defaultLocalChain`) and the runtime's chain resolver
 * (`harnessChainIds`), so a phantom that chats can never show `required`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfigForPersona } from "../src/config.ts";
import { personaSnapshot } from "../src/tui/snapshot.ts";

const SAVED = {
  config: process.env.PHANTOMBOT_CONFIG,
  personas: process.env.PHANTOMBOT_PERSONAS_DIR,
  data: process.env.XDG_DATA_HOME,
};
const WORK = mkdtempSync(join(tmpdir(), "tui-snapshot-brain-"));

afterEach(() => {
  if (SAVED.config === undefined) delete process.env.PHANTOMBOT_CONFIG;
  else process.env.PHANTOMBOT_CONFIG = SAVED.config;
  if (SAVED.personas === undefined) delete process.env.PHANTOMBOT_PERSONAS_DIR;
  else process.env.PHANTOMBOT_PERSONAS_DIR = SAVED.personas;
  if (SAVED.data === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = SAVED.data;
  rmSync(WORK, { recursive: true, force: true });
});

function setup(configToml: string): string {
  const personasDir = join(WORK, "personas");
  mkdirSync(join(personasDir, "alice"), { recursive: true });
  mkdirSync(join(personasDir, "bob"), { recursive: true });
  writeFileSync(join(WORK, "config.toml"), configToml);
  process.env.PHANTOMBOT_CONFIG = join(WORK, "config.toml");
  process.env.PHANTOMBOT_PERSONAS_DIR = personasDir;
  process.env.XDG_DATA_HOME = join(WORK, "data");
  return personasDir;
}

const HOST_RECORD_CONFIG = `
default_persona = "alice"

[harnesses.pi]
bin = "/bin/true"

[harnesses.personas.alice]
chain = [ "pi" ]
`;

describe("personaSnapshot brain badge source of truth", () => {
  test("a host personas-table record counts as a configured brain", async () => {
    setup(HOST_RECORD_CONFIG);
    const { config, host } = await loadConfigForPersona("alice");
    const snap = await personaSnapshot(config, host, "alice");

    // The badge's two fields agree with the runtime and the boot gate:
    expect(snap.brainConfigured).toBe(true);
    expect(snap.chain).toEqual(["pi"]);
    expect(snap.resolvedHarness?.id).toBe("pi");
    expect(snap.resolvedHarness?.path).toBe("/bin/true");
    expect(snap.completeness.complete).toBe(true);
  });

  test("a persona with no record of its own still shows not configured", async () => {
    setup(HOST_RECORD_CONFIG);
    const { config, host } = await loadConfigForPersona("bob");
    const snap = await personaSnapshot(config, host, "bob");

    // bob inherits nothing: the bare host chain is not a recorded choice.
    expect(snap.brainConfigured).toBe(false);
    expect(snap.completeness.complete).toBe(false);
  });
});
