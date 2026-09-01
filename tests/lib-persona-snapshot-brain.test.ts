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

describe("personaSnapshot autostart mode resolution (Caveat-1)", () => {
  test("recorded [autostart_modes] wins over the probe", async () => {
    const personasDir = setup(`
default_persona = "alice"
autostart_personas = ["alice", "bob"]
[autostart_modes]
alice = "login"
`);
    void personasDir;
    const { config, host } = await loadConfigForPersona("alice");
    const snap = await personaSnapshot(config, host, "alice", async () => true);
    expect(snap.autostart).toBe(true);
    expect(snap.autostartMode).toBe("login");
  });

  test("no record + probed boot state (inherited macOS daemon) → boot", async () => {
    setup(`
default_persona = "alice"
autostart_personas = ["alice", "bob"]
`);
    const { config, host } = await loadConfigForPersona("alice");
    const snap = await personaSnapshot(config, host, "alice", async () => true);
    expect(snap.autostartMode).toBe("boot");
  });

  test("no record + probe says not boot → login", async () => {
    setup(`
default_persona = "alice"
autostart_personas = ["alice"]
`);
    const { config, host } = await loadConfigForPersona("alice");
    const snap = await personaSnapshot(config, host, "alice", async () => false);
    expect(snap.autostartMode).toBe("login");
  });

  test("not served (not default, not on the list) → off, probe never consulted", async () => {
    setup(`
default_persona = "bob"
autostart_personas = ["bob"]
`);
    const { config, host } = await loadConfigForPersona("alice");
    let probed = 0;
    const snap = await personaSnapshot(config, host, "alice", async () => {
      probed++;
      return true;
    });
    expect(snap.autostart).toBe(false);
    expect(snap.autostartViaDefault).toBe(false);
    expect(snap.autostartMode).toBe("login");
    expect(probed).toBe(0);
  });

  // #512: the daemon serves `defaultPersona` plus `autostart_personas`
  // (config.ts `servedPersonasOf`), so the default persona autostarts even
  // when it is on no list — the shape a single-persona `phantombot install`
  // leaves behind on macOS and Windows. Reading membership alone reported
  // those hosts as Off while their LaunchAgent / logon task was in fact
  // starting the daemon at every login.
  test("default persona with NO autostart_personas key at all → served", async () => {
    setup(`
default_persona = "alice"
`);
    const { config, host } = await loadConfigForPersona("alice");
    const snap = await personaSnapshot(config, host, "alice", async () => false);
    expect(snap.autostart).toBe(true);
    expect(snap.autostartViaDefault).toBe(true);
    expect(snap.autostartMode).toBe("login");
  });

  test("default persona off the list is probed for an inherited boot state", async () => {
    setup(`
default_persona = "alice"
autostart_personas = ["bob"]
`);
    const { config, host } = await loadConfigForPersona("alice");
    let probed = 0;
    const snap = await personaSnapshot(config, host, "alice", async () => {
      probed++;
      return true;
    });
    expect(snap.autostart).toBe(true);
    expect(snap.autostartViaDefault).toBe(true);
    expect(snap.autostartMode).toBe("boot");
    expect(probed).toBe(1);
  });

  test("default persona ON the list is served, but not via the default rule", async () => {
    setup(`
default_persona = "alice"
autostart_personas = ["alice"]
`);
    const { config, host } = await loadConfigForPersona("alice");
    const snap = await personaSnapshot(config, host, "alice", async () => false);
    expect(snap.autostart).toBe(true);
    expect(snap.autostartViaDefault).toBe(false);
  });

  test("a recorded mode always wins over the probe", async () => {
    setup(`
default_persona = "alice"

[autostart_modes]
alice = "boot"
`);
    const { config, host } = await loadConfigForPersona("alice");
    let probed = 0;
    const snap = await personaSnapshot(config, host, "alice", async () => {
      probed++;
      return false;
    });
    expect(snap.autostartMode).toBe("boot");
    expect(probed).toBe(0);
  });
});
