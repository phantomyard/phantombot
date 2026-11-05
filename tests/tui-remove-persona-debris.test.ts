/**
 * `applyRemovePersona` must leave nothing keyed by the removed NAME behind
 * (issue #771, acceptance 3).
 *
 * REGRESSION test. The TUI's removal path ARCHIVES the persona directory and,
 * before this, pruned only `autostart_personas` — and only when the persona
 * was in it. Two things keyed by the name survived:
 *
 *   - the `[autostart_modes]` record, which is the OTHER half of the same host
 *     roster and is written by a separate writer, so a removed phantom could
 *     keep a `boot` record for a name that no longer exists;
 *   - `pi-native/personas/<name>` — the embedded engine's auth.json and model
 *     store. `ensureNativeAgentDir` only absorbs what is MISSING, so a persona
 *     re-created under the same name found the archived phantom's credential
 *     already in place and ran on it.
 *
 * The sibling assertions matter as much as the removal ones: the debris prune
 * must never reach a SURVIVING persona's native scope, and never the
 * host-level `pi-native/agent` migration source every persona absorbs from.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../src/config.ts";
import type { ServiceControl } from "../src/lib/platform.ts";
import { applyRemovePersona } from "../src/tui/actions.ts";

let root: string;
let dataHome: string;
let personasDir: string;
const saved: Record<string, string | undefined> = {};
const ENV = ["XDG_DATA_HOME", "PHANTOMBOT_PERSONA"] as const;

const noopService = {
  isActive: async () => true,
  start: async () => ({ ok: true }),
  stop: async () => ({ ok: true }),
  restart: async () => ({ ok: true }),
} as unknown as ServiceControl;

const CONFIG_TOML = `update_channel = "stable"

autostart_personas = ["bob"]

[autostart_modes]
bob = "boot"
`;

function configFor(overrides: Partial<Config> = {}): Config {
  return {
    configPath: join(root, "config.toml"),
    personasDir,
    defaultPersona: "ana",
    autostartPersonas: ["bob"],
    autostartModes: { bob: "boot" },
    ...overrides,
  } as unknown as Config;
}

function makePersona(name: string): void {
  mkdirSync(join(personasDir, name), { recursive: true });
  writeFileSync(join(personasDir, name, "IDENTITY.md"), `# ${name}\n`);
}

function makeNativeScope(name: string, contents = `{"${name}":"key"}`): string {
  const dir = join(dataHome, "pi-native", "personas", name, "agent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), contents);
  return dir;
}

const remove = (persona: string, config = configFor()) =>
  applyRemovePersona({
    config,
    persona,
    serviceControl: noopService,
    syncHeartbeatInstances: async () => undefined,
  });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "phantombot-tui-remove-"));
  dataHome = join(root, "data");
  personasDir = join(root, "data", "personas");
  mkdirSync(personasDir, { recursive: true });
  for (const k of ENV) saved[k] = process.env[k];
  process.env.XDG_DATA_HOME = dataHome;
  delete process.env.PHANTOMBOT_PERSONA;
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("applyRemovePersona — name-keyed debris (#771)", () => {
  test("drops BOTH roster keys and the persona's native agent scope", async () => {
    writeFileSync(join(root, "config.toml"), CONFIG_TOML);
    makePersona("bob");
    makePersona("ana");
    const bobScope = makeNativeScope("bob");
    const anaScope = makeNativeScope("ana", '{"ana":"key"}');
    const legacyDir = join(dataHome, "pi-native", "agent");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "auth.json"), '{"legacy":"key"}');

    const r = await remove("bob");
    expect(r.ok).toBe(true);
    expect(r.archive).toBeString();

    // Archived, not deleted: the persona's own content is recoverable.
    expect(existsSync(join(personasDir, "bob"))).toBe(false);
    expect(existsSync(join(personasDir, "..", "personas-archive"))).toBe(true);

    // Both halves of the host roster.
    const toml = readFileSync(join(root, "config.toml"), "utf8");
    expect(toml).not.toContain("bob");
    expect(toml).not.toContain("autostart_modes");

    // The name-keyed engine state, and ONLY that persona's.
    expect(existsSync(bobScope)).toBe(false);
    expect(existsSync(join(bobScope, ".."))).toBe(false);
    expect(existsSync(join(anaScope, "auth.json"))).toBe(true);
    expect(readFileSync(join(legacyDir, "auth.json"), "utf8")).toBe(
      '{"legacy":"key"}',
    );
  });

  test("a re-created persona under the same name starts with no credential", async () => {
    writeFileSync(join(root, "config.toml"), CONFIG_TOML);
    makePersona("bob");
    makeNativeScope("bob");

    expect((await remove("bob")).ok).toBe(true);

    makePersona("bob");
    expect(
      existsSync(join(dataHome, "pi-native", "personas", "bob", "agent", "auth.json")),
    ).toBe(false);
  });

  test("prunes a mode record that has no autostart_personas entry", async () => {
    writeFileSync(
      join(root, "config.toml"),
      'autostart_modes = { bob = "boot" }\n',
    );
    makePersona("bob");
    const config = configFor({ autostartPersonas: [], autostartModes: { bob: "boot" } });

    expect((await remove("bob", config)).ok).toBe(true);
    expect(readFileSync(join(root, "config.toml"), "utf8")).not.toContain("bob");
  });

  test("rewrites nothing when there is no debris to remove", async () => {
    writeFileSync(join(root, "config.toml"), '# untouched\nupdate_channel = "stable"\n');
    makePersona("bob");
    const config = configFor({ autostartPersonas: [], autostartModes: {} });

    expect((await remove("bob", config)).ok).toBe(true);
    expect(readFileSync(join(root, "config.toml"), "utf8")).toBe(
      '# untouched\nupdate_channel = "stable"\n',
    );
  });
});
