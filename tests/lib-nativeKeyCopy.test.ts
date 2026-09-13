/**
 * Native-harness key copy: the key must land in the persona vault BEFORE
 * anything depends on native, from legacy sources only, never invented.
 *
 * Regression (2026-09-13, Atlas): #549 migrated legacy pi slots to native
 * without copying their API key. The key lived only in ~/.pi/agent/auth.json;
 * deleting ~/.pi killed both native harnesses while doctor reported ok.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfigForPersona, type Config } from "../src/config.ts";
import {
  copyNativeKeys,
  nativeSlotsFor,
  readAuthStoreKey,
  type NativeKeyVault,
} from "../src/lib/nativeKeyCopy.ts";

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

async function configFor(configToml: string): Promise<Config> {
  for (const k of ROUTING_ENV) delete process.env[k];
  work = mkdtempSync(join(tmpdir(), "native-key-copy-"));
  const personasDir = join(work, "personas");
  mkdirSync(join(personasDir, "alice"), { recursive: true });
  writeFileSync(join(work, "config.toml"), configToml);
  process.env.PHANTOMBOT_CONFIG = join(work, "config.toml");
  process.env.PHANTOMBOT_PERSONAS_DIR = personasDir;
  process.env.XDG_DATA_HOME = join(work, "data");
  const { config } = await loadConfigForPersona("alice");
  return config;
}

function fakeVault(rows: Record<string, string> = {}): NativeKeyVault & {
  rows: Record<string, string>;
  writes: string[];
} {
  const writes: string[] = [];
  return {
    rows,
    writes,
    get: (name) => rows[name],
    set: (name, value) => {
      writes.push(name);
      rows[name] = value;
    },
  };
}

function authStore(entries: Record<string, unknown>): string {
  const p = join(work, "auth.json");
  writeFileSync(p, JSON.stringify(entries));
  return p;
}

const TWO_NATIVE = `
[harnesses]
chain = ["pi-primary", "pi-fallback"]

[harnesses.instances.pi-primary]
type = "native"
[harnesses.instances.pi-primary.routing]
provider = "openrouter"
primary_model = "openai/gpt-5"

[harnesses.instances.pi-fallback]
type = "native"
[harnesses.instances.pi-fallback.routing]
provider = "openrouter"
primary_model = "openai/gpt-5-mini"
`;

const PRIMARY = "PHANTOMBOT_PI_API_KEY_PI_PRIMARY";
const FALLBACK = "PHANTOMBOT_PI_API_KEY_PI_FALLBACK";

describe("nativeSlotsFor", () => {
  test("lists only native slots, with the secret the runtime reads", async () => {
    const config = await configFor(`
[harnesses]
chain = ["claude", "pi-primary", "pi-mine"]
[harnesses.instances.pi-primary]
type = "native"
[harnesses.instances.pi-primary.routing]
provider = "openrouter"
primary_model = "openai/gpt-5"
[harnesses.instances.pi-mine]
type = "pi-host"
`);
    expect(nativeSlotsFor(config, "alice")).toEqual([
      { id: "pi-primary", secretName: PRIMARY, provider: "openrouter" },
    ]);
  });
});

describe("readAuthStoreKey", () => {
  test("reads api_key entries, ignores oauth and malformed stores", async () => {
    await configFor(TWO_NATIVE);
    const p = authStore({
      openrouter: { type: "api_key", key: "  sk-or  " },
      anthropic: { type: "oauth", access: "tok" },
    });
    expect(readAuthStoreKey(p, "openrouter")).toBe("sk-or");
    expect(readAuthStoreKey(p, "anthropic")).toBeUndefined();
    expect(readAuthStoreKey(p, "google")).toBeUndefined();
    writeFileSync(p, "{not json");
    expect(readAuthStoreKey(p, "openrouter")).toBeUndefined();
    expect(readAuthStoreKey(join(work, "absent.json"), "openrouter")).toBeUndefined();
  });
});

describe("copyNativeKeys", () => {
  test("a stored key is kept and nothing is written", async () => {
    const config = await configFor(TWO_NATIVE);
    const vault = fakeVault({ [PRIMARY]: "sk-1", [FALLBACK]: "sk-2" });
    const r = await copyNativeKeys({
      config,
      persona: "alice",
      vault,
      vaultInjected: true,
      authPath: authStore({ openrouter: { type: "api_key", key: "sk-auth" } }),
    });
    expect(r.slots.map((s) => s.source)).toEqual(["stored", "stored"]);
    expect(r.copied).toEqual([]);
    expect(vault.writes).toEqual([]);
  });

  test("copies from the legacy auth store, then is idempotent", async () => {
    const config = await configFor(TWO_NATIVE);
    const vault = fakeVault();
    const authPath = authStore({ openrouter: { type: "api_key", key: "sk-auth" } });
    const first = await copyNativeKeys({ config, persona: "alice", vault, vaultInjected: true, authPath });
    expect(first.copied.map((c) => c.from)).toEqual(["auth-store", "auth-store"]);
    expect(vault.rows[PRIMARY]).toBe("sk-auth");
    expect(vault.rows[FALLBACK]).toBe("sk-auth");
    expect(first.stillMissing).toEqual([]);

    // The user now deletes ~/.pi: native must still resolve from the vault.
    rmSync(authPath);
    const second = await copyNativeKeys({ config, persona: "alice", vault, vaultInjected: true, authPath });
    expect(second.copied).toEqual([]);
    expect(second.slots.map((s) => s.source)).toEqual(["stored", "stored"]);
  });

  test("falls back to the OPENROUTER_API_KEY row for openrouter slots", async () => {
    const config = await configFor(TWO_NATIVE);
    const vault = fakeVault({ OPENROUTER_API_KEY: "sk-row" });
    const r = await copyNativeKeys({
      config,
      persona: "alice",
      vault,
      vaultInjected: true,
      authPath: join(work, "absent.json"),
    });
    expect(r.copied.map((c) => c.from)).toEqual(["openrouter-row", "openrouter-row"]);
    expect(vault.rows[FALLBACK]).toBe("sk-row");
  });

  test("copies a sibling slot's key when the provider matches", async () => {
    const config = await configFor(TWO_NATIVE);
    const vault = fakeVault({ [PRIMARY]: "sk-primary" });
    const r = await copyNativeKeys({
      config,
      persona: "alice",
      vault,
      vaultInjected: true,
      authPath: join(work, "absent.json"),
    });
    expect(r.copied).toEqual([{ id: "pi-fallback", secretName: FALLBACK, from: "sibling" }]);
    expect(vault.rows[FALLBACK]).toBe("sk-primary");
  });

  test("never invents a key: an unresolvable slot is reported missing", async () => {
    const config = await configFor(TWO_NATIVE.replaceAll('"openrouter"', '"google"'));
    const vault = fakeVault({ OPENROUTER_API_KEY: "sk-wrong-provider" });
    const r = await copyNativeKeys({
      config,
      persona: "alice",
      vault,
      vaultInjected: true,
      authPath: authStore({ openrouter: { type: "api_key", key: "sk-wrong-provider" } }),
    });
    expect(r.stillMissing.map((s) => s.secretName)).toEqual([PRIMARY, FALLBACK]);
    expect(vault.writes).toEqual([]);
  });

  test("dryRun reports the source but writes nothing", async () => {
    const config = await configFor(TWO_NATIVE);
    const vault = fakeVault();
    const r = await copyNativeKeys({
      config,
      persona: "alice",
      vault,
      vaultInjected: true,
      dryRun: true,
      authPath: authStore({ openrouter: { type: "api_key", key: "sk-auth" } }),
    });
    expect(r.copied.map((c) => c.from)).toEqual(["auth-store", "auth-store"]);
    expect(vault.writes).toEqual([]);
  });

  test("dryRun with no openable vault still reports what --fix would copy", async () => {
    // Doctor's inspection opener returns undefined for a persona with no
    // identity (it must not mint one). The audit must still say the auth
    // store resolves the slot, not report it missing.
    const config = await configFor(TWO_NATIVE);
    const r = await copyNativeKeys({
      config,
      persona: "alice",
      personaDir: join(work, "personas", "alice"),
      openVault: async () => undefined,
      dryRun: true,
      authPath: authStore({ openrouter: { type: "api_key", key: "sk-auth" } }),
    });
    expect(r.slots.map((s) => s.source)).toEqual(["auth-store", "auth-store"]);
    expect(r.stillMissing).toEqual([]);
  });
});
