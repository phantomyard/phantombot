/**
 * Tests for the per-persona phantomchat store: identity + relays + allowlist
 * live in `<persona-dir>/phantomchat.json`, making a persona folder portable
 * and letting one machine run many personas, each with its own npub.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_PHANTOMCHAT_RELAYS, type Config } from "../src/config.ts";
import {
  listPhantomchatPersonas,
  loadPhantomchatPersonaConfig,
  phantomchatConfigPath,
  savePhantomchatPersonaConfig,
} from "../src/channels/phantomchat/personaStore.ts";
import { decodeNpubToHex, generateIdentity } from "../src/lib/nostrIdentity.ts";

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-pc-store-"));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("save/load round-trip", () => {
  test("writes phantomchat.json and reads identity + relays + allowlist back", async () => {
    const id = generateIdentity();
    const allowed = generateIdentity().npub;
    const agentDir = join(workdir, "lena");
    await mkdir(agentDir, { recursive: true });

    const path = await savePhantomchatPersonaConfig(agentDir, {
      nsec: id.nsec,
      relays: ["wss://a.example", "wss://b.example"],
      allowedNpubs: [allowed],
    });
    expect(path).toBe(phantomchatConfigPath(agentDir));

    const loaded = loadPhantomchatPersonaConfig(agentDir);
    expect(loaded).toBeDefined();
    expect(loaded!.identity.npub).toBe(id.npub);
    expect(loaded!.identity.secretKey).toEqual(id.secretKey);
    expect(loaded!.relays).toEqual(["wss://a.example", "wss://b.example"]);
    expect(loaded!.allowedNpubs).toEqual([allowed]);
    // allowedHex is the decoded lowercase-hex form used by the auth gate.
    expect(loaded!.allowedHex).toEqual([decodeNpubToHex(allowed)]);
  });

  test("file is written mode 0600 (the nsec is a secret)", async () => {
    const id = generateIdentity();
    const agentDir = join(workdir, "kai");
    await mkdir(agentDir, { recursive: true });
    const path = await savePhantomchatPersonaConfig(agentDir, {
      nsec: id.nsec,
      relays: [],
      allowedNpubs: [],
    });
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("omitted/empty relays fall back to the default PWA relay set", async () => {
    const id = generateIdentity();
    const agentDir = join(workdir, "p");
    await mkdir(agentDir, { recursive: true });
    await savePhantomchatPersonaConfig(agentDir, {
      nsec: id.nsec,
      relays: [],
      allowedNpubs: [],
    });
    const loaded = loadPhantomchatPersonaConfig(agentDir);
    expect(loaded!.relays).toEqual([...DEFAULT_PHANTOMCHAT_RELAYS]);
  });
});

describe("loadPhantomchatPersonaConfig — robustness", () => {
  test("absent file → undefined", () => {
    expect(loadPhantomchatPersonaConfig(join(workdir, "nope"))).toBeUndefined();
  });

  test("file without nsec → undefined (channel not enabled)", async () => {
    const agentDir = join(workdir, "noidentity");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      phantomchatConfigPath(agentDir),
      JSON.stringify({ relays: ["wss://a.example"] }),
    );
    expect(loadPhantomchatPersonaConfig(agentDir)).toBeUndefined();
  });

  test("invalid nsec → undefined (skipped, not a crash)", async () => {
    const agentDir = join(workdir, "badnsec");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      phantomchatConfigPath(agentDir),
      JSON.stringify({ nsec: "not-an-nsec" }),
    );
    expect(loadPhantomchatPersonaConfig(agentDir)).toBeUndefined();
  });

  test("malformed JSON → undefined (skipped, not a crash)", async () => {
    const agentDir = join(workdir, "badjson");
    await mkdir(agentDir, { recursive: true });
    await writeFile(phantomchatConfigPath(agentDir), "{ not json");
    expect(loadPhantomchatPersonaConfig(agentDir)).toBeUndefined();
  });
});

describe("listPhantomchatPersonas — multi-persona fan-out", () => {
  function configWithPersonasDir(personasDir: string): Config {
    return { personasDir } as unknown as Config;
  }

  test("returns one spec per persona dir that has a valid phantomchat.json", async () => {
    const personasDir = join(workdir, "personas");
    // lena + kai are configured; jake has a dir but no phantomchat.json.
    const lena = generateIdentity();
    const kai = generateIdentity();
    for (const [name, id] of [
      ["lena", lena],
      ["kai", kai],
    ] as const) {
      const dir = join(personasDir, name);
      await mkdir(dir, { recursive: true });
      await savePhantomchatPersonaConfig(dir, {
        nsec: id.nsec,
        relays: [],
        allowedNpubs: [],
      });
    }
    await mkdir(join(personasDir, "jake"), { recursive: true });

    const specs = listPhantomchatPersonas(configWithPersonasDir(personasDir));
    const byName = Object.fromEntries(specs.map((s) => [s.persona, s]));
    expect(Object.keys(byName).sort()).toEqual(["kai", "lena"]);
    expect(byName.lena!.config.identity.npub).toBe(lena.npub);
    expect(byName.kai!.config.identity.npub).toBe(kai.npub);
    // Each persona has its OWN distinct identity.
    expect(byName.lena!.config.identity.npub).not.toBe(
      byName.kai!.config.identity.npub,
    );
  });

  test("missing personasDir → empty list (no crash)", () => {
    const specs = listPhantomchatPersonas(
      configWithPersonasDir(join(workdir, "does-not-exist")),
    );
    expect(specs).toEqual([]);
  });
});
