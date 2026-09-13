/**
 * The Vault screen must offer a row for EVERY native chain entry's key.
 *
 * Review finding on #549: Brain persists a native→native chain as named
 * instances `pi-primary` / `pi-fallback`, each reading its own suffixed vault
 * key. The screen only matched the literal id `native`, so neither key had a
 * row and a missing one could not be restored without rerunning Brain.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfigForPersona } from "../src/config.ts";
import { nativeApiKeyNameFor } from "../src/harnesses/buildChain.ts";
import { expectedSecrets, keyRows } from "../src/tui/screens/Keys.tsx";
import { personaSnapshot } from "../src/tui/snapshot.ts";

const ROUTING_ENV = [
  "PHANTOMBOT_PI_PROVIDER",
  "PHANTOMBOT_PRIMARY_MODEL",
  "PHANTOMBOT_IMAGE_MODEL",
  "PHANTOMBOT_CODING_MODEL",
] as const;
const KEYS = ["PHANTOMBOT_CONFIG", "PHANTOMBOT_PERSONAS_DIR", "XDG_DATA_HOME", ...ROUTING_ENV];
const SAVED = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let work = "";

afterEach(() => {
  for (const k of KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
  if (work) rmSync(work, { recursive: true, force: true });
  work = "";
});

async function snapshotFor(configToml: string) {
  for (const k of ROUTING_ENV) delete process.env[k];
  work = mkdtempSync(join(tmpdir(), "tui-keys-native-"));
  const personasDir = join(work, "personas");
  mkdirSync(join(personasDir, "alice"), { recursive: true });
  writeFileSync(join(work, "config.toml"), configToml);
  process.env.PHANTOMBOT_CONFIG = join(work, "config.toml");
  process.env.PHANTOMBOT_PERSONAS_DIR = personasDir;
  process.env.XDG_DATA_HOME = join(work, "data");
  const { config, host } = await loadConfigForPersona("alice");
  return { config, snap: await personaSnapshot(config, host, "alice", async () => false) };
}

const ROUTING = `provider = "openrouter"\nprimary_model = "openai/gpt-5"`;

describe("Vault screen — native harness keys", () => {
  test("a native→native chain expects BOTH instance keys", async () => {
    const { snap } = await snapshotFor(`
[harnesses]
chain = ["pi-primary", "pi-fallback"]

[harnesses.instances.pi-primary]
type = "native"
[harnesses.instances.pi-primary.routing]
${ROUTING}

[harnesses.instances.pi-fallback]
type = "native"
[harnesses.instances.pi-fallback.routing]
${ROUTING}
`);
    const names = expectedSecrets(snap).map((e) => e.name);
    expect(names).toContain("PHANTOMBOT_PI_API_KEY_PI_PRIMARY");
    expect(names).toContain("PHANTOMBOT_PI_API_KEY_PI_FALLBACK");
    expect(names).not.toContain("PHANTOMBOT_PI_API_KEY");

    // Absent from the vault → still a row the user can set.
    const rows = keyRows({ ...snap, secretNames: [] });
    const primary = rows.find((r) => r.name === "PHANTOMBOT_PI_API_KEY_PI_PRIMARY");
    expect(primary).toMatchObject({ set: false, usedBy: "harness: pi-primary (native)" });
    expect(rows.find((r) => r.name === "PHANTOMBOT_PI_API_KEY_PI_FALLBACK")?.set).toBe(false);
  });

  test("the unnamed native slot keeps PHANTOMBOT_PI_API_KEY", async () => {
    const { snap } = await snapshotFor(`
[harnesses]
chain = ["claude", "native"]
[harnesses.pi.routing]
${ROUTING}
`);
    expect(expectedSecrets(snap).filter((e) => e.name.startsWith("PHANTOMBOT_PI_API_KEY"))).toEqual([
      { name: "PHANTOMBOT_PI_API_KEY", usedBy: "harness: native" },
    ]);
  });

  test("pi-host instances and claude/codex expect no pi key", async () => {
    const { config, snap } = await snapshotFor(`
[harnesses]
chain = ["claude", "codex", "pi-mine"]
[harnesses.instances.pi-mine]
type = "pi-host"
`);
    expect(expectedSecrets(snap).some((e) => e.name.startsWith("PHANTOMBOT_PI_API_KEY"))).toBe(false);
    expect(nativeApiKeyNameFor(config, "pi-mine")).toBeUndefined();
    expect(nativeApiKeyNameFor(config, "claude")).toBeUndefined();
  });
});
