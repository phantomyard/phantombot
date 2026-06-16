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
  cacheRelaysForPersona,
  listPhantomchatPersonas,
  loadPhantomchatPersonaConfig,
  phantomchatConfigPath,
  recordGreeted,
  recordTrustedNpub,
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

  test("tofu round-trips: persisted only when enabled, defaults false", async () => {
    const id = generateIdentity();
    const onDir = join(workdir, "tofu-on");
    const offDir = join(workdir, "tofu-off");
    await mkdir(onDir, { recursive: true });
    await mkdir(offDir, { recursive: true });

    await savePhantomchatPersonaConfig(onDir, {
      nsec: id.nsec,
      relays: [],
      allowedNpubs: [],
      tofu: true,
    });
    await savePhantomchatPersonaConfig(offDir, {
      nsec: id.nsec,
      relays: [],
      allowedNpubs: [],
    });

    expect(loadPhantomchatPersonaConfig(onDir)!.tofu).toBe(true);
    expect(loadPhantomchatPersonaConfig(offDir)!.tofu).toBe(false);
  });

  test("recordTrustedNpub appends the npub and clears tofu (lock)", async () => {
    const id = generateIdentity();
    const trusted = generateIdentity().npub;
    const agentDir = join(workdir, "tofu-commit");
    await mkdir(agentDir, { recursive: true });
    await savePhantomchatPersonaConfig(agentDir, {
      nsec: id.nsec,
      relays: ["wss://keep.example"],
      allowedNpubs: [],
      tofu: true,
    });

    const updated = await recordTrustedNpub(agentDir, trusted);
    expect(updated).toEqual([trusted]);

    const loaded = loadPhantomchatPersonaConfig(agentDir)!;
    expect(loaded.allowedNpubs).toEqual([trusted]);
    expect(loaded.tofu).toBe(false); // locked
    expect(loaded.relays).toEqual(["wss://keep.example"]); // preserved
    // Idempotent: re-recording the same npub doesn't duplicate it.
    expect(await recordTrustedNpub(agentDir, trusted)).toEqual([trusted]);
  });

  test("greeted round-trips: persisted only when non-empty, defaults []", async () => {
    const id = generateIdentity();
    const a = generateIdentity().npub;
    const withDir = join(workdir, "greeted-on");
    const withoutDir = join(workdir, "greeted-off");
    await mkdir(withDir, { recursive: true });
    await mkdir(withoutDir, { recursive: true });

    await savePhantomchatPersonaConfig(withDir, {
      nsec: id.nsec,
      relays: [],
      allowedNpubs: [a],
      greeted: [a],
    });
    await savePhantomchatPersonaConfig(withoutDir, {
      nsec: id.nsec,
      relays: [],
      allowedNpubs: [a],
    });

    expect(loadPhantomchatPersonaConfig(withDir)!.greeted).toEqual([a]);
    expect(loadPhantomchatPersonaConfig(withoutDir)!.greeted).toEqual([]);
  });

  test("recordGreeted appends, is idempotent, and preserves identity/allowlist/tofu", async () => {
    const id = generateIdentity();
    const a = generateIdentity().npub;
    const b = generateIdentity().npub;
    const agentDir = join(workdir, "greet-record");
    await mkdir(agentDir, { recursive: true });
    await savePhantomchatPersonaConfig(agentDir, {
      nsec: id.nsec,
      relays: ["wss://keep.example"],
      allowedNpubs: [a, b],
    });

    expect(await recordGreeted(agentDir, a)).toEqual([a]);
    expect(await recordGreeted(agentDir, b)).toEqual([a, b]);
    // Idempotent — re-recording doesn't duplicate.
    expect(await recordGreeted(agentDir, a)).toEqual([a, b]);

    const loaded = loadPhantomchatPersonaConfig(agentDir)!;
    expect(loaded.greeted).toEqual([a, b]);
    expect(loaded.allowedNpubs).toEqual([a, b]); // preserved
    expect(loaded.relays).toEqual(["wss://keep.example"]); // preserved
    expect(loaded.identity.npub).toBe(id.npub); // preserved
  });

  test("recordTrustedNpub preserves an existing greeted list", async () => {
    const id = generateIdentity();
    const greetedNpub = generateIdentity().npub;
    const trusted = generateIdentity().npub;
    const agentDir = join(workdir, "trust-keeps-greeted");
    await mkdir(agentDir, { recursive: true });
    await savePhantomchatPersonaConfig(agentDir, {
      nsec: id.nsec,
      relays: [],
      allowedNpubs: [],
      tofu: true,
      greeted: [greetedNpub],
    });

    await recordTrustedNpub(agentDir, trusted);
    expect(loadPhantomchatPersonaConfig(agentDir)!.greeted).toEqual([greetedNpub]);
  });

  test("cacheRelaysForPersona updates only relays, preserving identity + allowlist", async () => {
    const id = generateIdentity();
    const allowed = generateIdentity().npub;
    const agentDir = join(workdir, "relay-cache");
    await mkdir(agentDir, { recursive: true });
    await savePhantomchatPersonaConfig(agentDir, {
      nsec: id.nsec,
      relays: ["wss://old.example"],
      allowedNpubs: [allowed],
    });

    const ok = await cacheRelaysForPersona(agentDir, [
      "wss://new1.example",
      "wss://new2.example",
    ]);
    expect(ok).toBe(true);

    const loaded = loadPhantomchatPersonaConfig(agentDir)!;
    expect(loaded.relays).toEqual(["wss://new1.example", "wss://new2.example"]);
    expect(loaded.allowedNpubs).toEqual([allowed]); // preserved
    expect(loaded.identity.npub).toBe(id.npub); // preserved

    // No config → no-op false.
    expect(await cacheRelaysForPersona(join(workdir, "absent"), [])).toBe(false);
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
