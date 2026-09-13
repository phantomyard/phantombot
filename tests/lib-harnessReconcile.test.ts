/**
 * The legacy-`pi` reconcile: one decision (lib/harnessReconcile.ts) shared by
 * loadConfig's read-time mapping and doctor's writer
 * (lib/harnessConfigRepair.ts). What must hold:
 *
 *   - routing → native; no routing → pi-host, unless doctor KNOWS there is no
 *     host pi, in which case → native (repair). Read time (unknown) keeps the
 *     pre-upgrade meaning.
 *   - A claude-only or codex-only config is normal: zero changes, no output,
 *     file byte-for-byte unchanged, native never injected.
 *   - Idempotent: the second run changes nothing and writes nothing.
 *   - Writes keep a backup of the original bytes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideLegacyPi,
  mapLegacyChain,
  piEngineFor,
  reconcileHarnessToml,
  routingIsConfigured,
} from "../src/lib/harnessReconcile.ts";
import {
  listHarnessConfigFiles,
  reconcileHarnessConfigFiles,
} from "../src/lib/harnessConfigRepair.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const harnessesOf = (toml: unknown) => (toml as { harnesses: any }).harnesses;

describe("decideLegacyPi — the one decision", () => {
  test("routing configured → native, whatever the host has installed", () => {
    expect(decideLegacyPi({ routingConfigured: true, hostPiInstalled: true })).toBe("native");
    expect(decideLegacyPi({ routingConfigured: true, hostPiInstalled: false })).toBe("native");
    expect(decideLegacyPi({ routingConfigured: true })).toBe("native");
  });

  test("no routing + host pi installed → pi-host", () => {
    expect(decideLegacyPi({ routingConfigured: false, hostPiInstalled: true })).toBe("pi-host");
  });

  test("no routing + host pi known ABSENT → native (repair: nothing else could serve it)", () => {
    expect(decideLegacyPi({ routingConfigured: false, hostPiInstalled: false })).toBe("native");
  });

  test("no routing + not probed (read time) → pi-host, the entry's pre-upgrade meaning", () => {
    expect(decideLegacyPi({ routingConfigured: false })).toBe("pi-host");
  });
});

describe("routingIsConfigured", () => {
  test("a provider or any model counts, in TOML or resolved field names", () => {
    expect(routingIsConfigured({ provider: "openrouter" })).toBe(true);
    expect(routingIsConfigured({ primary_model: "m" })).toBe(true);
    expect(routingIsConfigured({ imageModel: "v" })).toBe(true);
    expect(routingIsConfigured({ codingModel: "c" })).toBe(true);
  });

  test("the use_local_config opt-out is NOT phantombot routing", () => {
    expect(routingIsConfigured({ use_local_config: true, primary_model: "m" })).toBe(false);
    expect(routingIsConfigured({ useLocalConfig: true, provider: "openrouter" })).toBe(false);
  });

  test("missing, empty and blank are not routing", () => {
    expect(routingIsConfigured(undefined)).toBe(false);
    expect(routingIsConfigured({})).toBe(false);
    expect(routingIsConfigured({ provider: "   " })).toBe(false);
    expect(routingIsConfigured([])).toBe(false);
  });
});

describe("mapLegacyChain", () => {
  test("Megan's ['claude', 'pi'] keeps claude primary and maps only the pi slot", () => {
    expect(mapLegacyChain(["claude", "pi"], { routingConfigured: true })).toEqual(["claude", "native"]);
    expect(mapLegacyChain(["claude", "pi"], { routingConfigured: false, hostPiInstalled: true }))
      .toEqual(["claude", "pi-host"]);
    expect(mapLegacyChain(["claude", "pi"], { routingConfigured: false, hostPiInstalled: false }))
      .toEqual(["claude", "native"]);
  });

  test("a chain without legacy pi comes back unchanged", () => {
    expect(mapLegacyChain(["claude", "codex"], { routingConfigured: true })).toEqual(["claude", "codex"]);
    expect(mapLegacyChain(["native", "pi-host"], { routingConfigured: false })).toEqual(["native", "pi-host"]);
  });

  test("mapping never produces a duplicate entry", () => {
    expect(mapLegacyChain(["native", "pi"], { routingConfigured: true })).toEqual(["native"]);
  });
});

describe("piEngineFor", () => {
  const harnesses = {
    pi: { routing: { provider: "openrouter" } },
    instances: {
      "pi-primary": { type: "native" },
      "pi-fallback": { type: "pi-host" },
      "old-a": { type: "pi", routing: { primary_model: "m" } },
      "old-b": { type: "pi" },
    },
  };

  test("current ids and instance types", () => {
    expect(piEngineFor(harnesses, "native")).toBe("native");
    expect(piEngineFor(harnesses, "pi-host")).toBe("pi-host");
    expect(piEngineFor(harnesses, "pi-primary")).toBe("native");
    expect(piEngineFor(harnesses, "pi-fallback")).toBe("pi-host");
  });

  test("non-pi ids are not pi engines", () => {
    expect(piEngineFor(harnesses, "claude")).toBeUndefined();
    expect(piEngineFor(harnesses, "codex")).toBeUndefined();
    expect(piEngineFor(harnesses, "mystery")).toBeUndefined();
  });

  test("legacy ids that reach it still go through the one decision", () => {
    expect(piEngineFor(harnesses, "pi")).toBe("native");
    expect(piEngineFor({ pi: {} }, "pi")).toBe("pi-host");
    expect(piEngineFor(harnesses, "old-a")).toBe("native");
    expect(piEngineFor(harnesses, "old-b")).toBe("pi-host");
  });
});

describe("reconcileHarnessToml", () => {
  const facts = (routing: boolean, hostPiInstalled?: boolean) => ({
    routingConfigured: () => routing,
    hostPiInstalled,
  });

  test("claude-only and codex-only configs: zero changes, and native is never injected", () => {
    for (const chain of [["claude"], ["codex"], ["claude", "codex"]]) {
      const toml = { harnesses: { chain, claude: { model: "opus" } } };
      const r = reconcileHarnessToml(toml, facts(true, false));
      expect(r.changes).toEqual([]);
      expect(r.toml).toEqual(toml);
    }
    expect(reconcileHarnessToml({}, facts(false, false)).changes).toEqual([]);
    expect(reconcileHarnessToml({ harnesses: {} }, facts(false, false)).changes).toEqual([]);
  });

  test("the global chain, persona tables and named instances are all mapped", () => {
    const toml = {
      harnesses: {
        chain: ["claude", "pi"],
        personas: { lena: { chain: ["pi"] }, kai: { chain: ["codex"] } },
        pi: { routing: { provider: "openrouter" } },
        instances: {
          "pi-primary": { type: "pi", routing: { primary_model: "m" } },
          "pi-fallback": { type: "pi" },
        },
      },
    };
    const r = reconcileHarnessToml(toml, {
      routingConfigured: (persona) => persona !== "lena",
      hostPiInstalled: true,
    });
    const h = harnessesOf(r.toml);
    expect(h.chain).toEqual(["claude", "native"]);
    expect(h.personas.lena.chain).toEqual(["pi-host"]);
    expect(h.personas.kai.chain).toEqual(["codex"]);
    expect(h.instances["pi-primary"].type).toBe("native");
    expect(h.instances["pi-fallback"].type).toBe("pi-host");
    expect(r.changes.map((c) => c.path)).toEqual([
      "harnesses.chain",
      "harnesses.personas.lena.chain",
      "harnesses.instances.pi-primary.type",
      "harnesses.instances.pi-fallback.type",
    ]);
  });

  test("never mutates its input", () => {
    const toml = { harnesses: { chain: ["pi"] } };
    reconcileHarnessToml(toml, facts(true));
    expect(toml.harnesses.chain).toEqual(["pi"]);
  });

  test("idempotent: a second pass over its own output changes nothing", () => {
    const toml = {
      harnesses: {
        chain: ["pi", "claude"],
        instances: { "pi-primary": { type: "pi" } },
      },
    };
    const first = reconcileHarnessToml(toml, facts(false, false));
    expect(first.changes.length).toBeGreaterThan(0);
    const second = reconcileHarnessToml(first.toml, facts(false, false));
    expect(second.changes).toEqual([]);
    expect(second.toml).toEqual(first.toml);
  });
});

describe("reconcileHarnessConfigFiles (doctor's writer)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "phantombot-reconcile-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const backups = async () => (await readdir(dir)).filter((n) => n.includes(".bak-"));

  test("Megan's config: migrated with a backup of the original, and a second run is byte-identical", async () => {
    const path = join(dir, "config.toml");
    const original =
      '[harnesses]\nchain = ["claude", "pi"]\n\n' +
      '[harnesses.pi.routing]\nprovider = "google"\nprimary_model = "gemini-2.5-flash"\n';
    await writeFile(path, original, "utf8");

    const first = await reconcileHarnessConfigFiles({
      files: [{ path }],
      routingConfigured: () => true,
      hostPiInstalled: false,
      repair: true,
      now: new Date("2026-09-13T12:00:00Z"),
    });
    expect(first).toHaveLength(1);
    expect(first[0]!.written).toBe(true);
    expect(first[0]!.changes[0]).toMatchObject({
      path: "harnesses.chain",
      from: '["claude","pi"]',
      to: '["claude","native"]',
    });
    expect(await readFile(first[0]!.backupPath!, "utf8")).toBe(original);

    const after = await readFile(path, "utf8");
    expect(after).toContain('"native"');
    expect(after).not.toMatch(/"pi"/);
    // Routing survives the rewrite.
    expect(after).toContain("gemini-2.5-flash");

    const second = await reconcileHarnessConfigFiles({
      files: [{ path }],
      routingConfigured: () => true,
      hostPiInstalled: false,
      repair: true,
    });
    expect(second).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(after);
    expect(await backups()).toHaveLength(1);
  });

  test("claude-only and codex-only files: no result, no write, no backup — byte-for-byte unchanged", async () => {
    const files = [
      { name: "claude.toml", text: '# hand notes survive\n[harnesses]\nchain = ["claude"]\n' },
      { name: "codex.toml", text: '[harnesses]\nchain = [ "codex" ]\n\n[harnesses.codex]\nmodel = "gpt-5"\n' },
    ];
    for (const f of files) await writeFile(join(dir, f.name), f.text, "utf8");
    const results = await reconcileHarnessConfigFiles({
      files: files.map((f) => ({ path: join(dir, f.name) })),
      routingConfigured: () => false,
      hostPiInstalled: false,
      repair: true,
    });
    expect(results).toEqual([]);
    for (const f of files) {
      expect(await readFile(join(dir, f.name), "utf8")).toBe(f.text);
    }
    expect(await backups()).toEqual([]);
  });

  test("repair off: reports the pending change and writes nothing", async () => {
    const path = join(dir, "config.toml");
    const original = '[harnesses]\nchain = ["pi"]\n';
    await writeFile(path, original, "utf8");
    const results = await reconcileHarnessConfigFiles({
      files: [{ path }],
      routingConfigured: () => false,
      hostPiInstalled: true,
      repair: false,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.written).toBe(false);
    expect(results[0]!.changes[0]!.to).toBe('["pi-host"]');
    expect(await readFile(path, "utf8")).toBe(original);
    expect(await backups()).toEqual([]);
  });

  test("an unparseable file is reported and left alone", async () => {
    const path = join(dir, "config.toml");
    const broken = '[harnesses\nchain = ["pi"\n';
    await writeFile(path, broken, "utf8");
    const results = await reconcileHarnessConfigFiles({
      files: [{ path }],
      routingConfigured: () => true,
      hostPiInstalled: false,
      repair: true,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.error).toContain("unparseable");
    expect(await readFile(path, "utf8")).toBe(broken);
  });

  test("a missing file is skipped silently", async () => {
    const results = await reconcileHarnessConfigFiles({
      files: [{ path: join(dir, "absent.toml") }],
      routingConfigured: () => true,
      hostPiInstalled: false,
      repair: true,
    });
    expect(results).toEqual([]);
  });

  test("a persona file's own chain resolves routing through THAT persona", async () => {
    const path = join(dir, "lena.toml");
    await writeFile(path, '[harnesses]\nchain = ["pi"]\n', "utf8");
    const asked: Array<string | undefined> = [];
    const results = await reconcileHarnessConfigFiles({
      files: [{ path, persona: "lena" }],
      routingConfigured: (persona) => {
        asked.push(persona);
        return persona === "lena";
      },
      hostPiInstalled: true,
      repair: true,
    });
    expect(asked).toEqual(["lena"]);
    expect(results[0]!.changes[0]!.to).toBe('["native"]');
  });

  test("listHarnessConfigFiles: the global file plus every persona dir's config.toml", async () => {
    await mkdir(join(dir, "personas", "lena"), { recursive: true });
    await mkdir(join(dir, "personas", "kai"), { recursive: true });
    const files = await listHarnessConfigFiles(join(dir, "config.toml"), join(dir, "personas"));
    expect(files).toEqual([
      { path: join(dir, "config.toml") },
      { path: join(dir, "personas", "kai", "config.toml"), persona: "kai" },
      { path: join(dir, "personas", "lena", "config.toml"), persona: "lena" },
    ]);
    expect(await listHarnessConfigFiles(join(dir, "c.toml"), join(dir, "nope"))).toEqual([
      { path: join(dir, "c.toml") },
    ]);
  });
});
