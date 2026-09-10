import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyRouting,
  clearPiRouting,
  resolveHarnessWriteTarget,
  restorePiRouting,
  snapshotPiRouting,
} from "../src/cli/harness.ts";
import {
  computeRoutingClears,
  resolveRoutingProvider,
} from "../src/lib/piRouting.ts";
import { readConfigToml } from "../src/lib/configWriter.ts";

let workdir: string;
let configPath: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-route-"));
  configPath = join(workdir, "config.toml");
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("clearPiRouting (the 'Use Pi's own config' path)", () => {
  test("erases routing from config.toml after a configured run", async () => {
    // THE regression: the old "later" option returned early without clearing,
    // so once "now" had run, its routing persisted and pi.ts kept threading
    // --model/--provider forever. Configure first, then delegate to Pi.
    await applyRouting(
      configPath,
      {
        provider: "openrouter",
        primaryModel: "deepseek-v4-pro",
        imageModel: "gpt-4o",
        codingModel: "gpt-5.2-codex",
      }
    );
    await clearPiRouting(configPath);

    const toml = await readConfigToml(configPath);
    const routing = (toml as any).harnesses.pi.routing;
    expect(routing.provider).toBeUndefined();
    expect(routing.primary_model).toBeUndefined();
    expect(routing.image_model).toBeUndefined();
    expect(routing.coding_model).toBeUndefined();
  });

  test("leaves unrelated config alone", async () => {
    await applyRouting(configPath, { primaryModel: "gpt-5.2" });
    const { applyHarnessChain } = await import("../src/cli/harness.ts");
    await applyHarnessChain(configPath, ["pi", "claude"]);

    await clearPiRouting(configPath);

    const toml = await readConfigToml(configPath);
    expect((toml.harnesses as Record<string, any>).chain).toEqual([
      "pi",
      "claude",
    ]);
  });

  test("is a safe no-op on a virgin box (nothing configured yet)", async () => {
    await clearPiRouting(configPath);
    expect(await readConfigToml(configPath)).toBeDefined();
  });

  test("clears every key applyRouting can write", () => {
    // Guard against drift: if computeRoutingWrites learns a new key, this fails
    // until computeRoutingClears erases it too.
    const clears = computeRoutingClears();
    expect([...clears.tomlKeys].sort()).toEqual([
      "coding_model",
      "image_model",
      "primary_model",
      "provider",
    ]);
    expect(Object.values(clears.env).every((v) => v === "")).toBe(true);
  });
});

describe("applyRouting for a non-default persona (phantombot#441)", () => {
  test("the write lands in the PERSONA file and leaves the host file empty", async () => {
    // Persona isolation used to need a suffixed env mirror because the env file
    // was shared host-wide. Since #452 there is no mirror at all: the persona's
    // own config.toml is the whole story, and configuring one persona must not
    // touch the host file every other persona inherits from.
    const personaPath = join(workdir, "personas", "lena", "config.toml");
    await applyRouting(personaPath, {
      provider: "openrouter",
      primaryModel: "lena-primary",
      imageModel: "lena-vision",
    });

    const personaToml = await readConfigToml(personaPath);
    expect((personaToml as any).harnesses.pi.routing.primary_model).toBe(
      "lena-primary",
    );
    expect((personaToml as any).harnesses.pi.routing.image_model).toBe(
      "lena-vision",
    );
    expect(await readConfigToml(configPath)).toEqual({});
  });

  test("clearPiRouting clears the PERSONA file, not the host's", async () => {
    const personaPath = join(workdir, "personas", "lena", "config.toml");
    await applyRouting(configPath, { primaryModel: "host-primary" });
    await applyRouting(personaPath, { primaryModel: "lena-primary" });

    await clearPiRouting(personaPath, { tombstone: true });

    expect(
      (await readConfigToml(personaPath) as any).harnesses.pi.routing
        .primary_model,
    ).toBeUndefined();
    expect(
      (await readConfigToml(configPath) as any).harnesses.pi.routing
        .primary_model,
    ).toBe("host-primary");
  });
});

describe("applyRouting", () => {
  test("text-only primary writes all three models to config.toml", async () => {
    await applyRouting(
      configPath,
      {
        primaryModel: "deepseek-v4-pro",
        imageModel: "gpt-4o",
        codingModel: "gpt-5.2-codex",
      }
    );

    const toml = await readConfigToml(configPath);
    expect(toml).toMatchObject({
      harnesses: {
        pi: {
          routing: {
            primary_model: "deepseek-v4-pro",
            image_model: "gpt-4o",
            coding_model: "gpt-5.2-codex",
          },
        },
      },
    });

  });

  test("vision primary KEEPS the image model (no auto-skip)", async () => {
    // The wizard defaults the image pick to the vision primary, so the image
    // model commonly equals the primary — and it must be persisted, not dropped.
    await applyRouting(
      configPath,
      {
        primaryModel: "gpt-5.2",
        imageModel: "gpt-5.2",
        codingModel: "gpt-5.2-codex",
      }
    );

    const routing = (
      (await readConfigToml(configPath)).harnesses as Record<string, any>
    ).pi.routing;
    expect(routing.primary_model).toBe("gpt-5.2");
    expect(routing.coding_model).toBe("gpt-5.2-codex");
    expect(routing.image_model).toBe("gpt-5.2");
  });

  test("provider persists to config.toml, and (none) clears a previously-set one", async () => {
    await applyRouting(
      configPath,
      { provider: "openrouter", primaryModel: "z-ai/glm-5.2" }
    );
    let routing = (
      (await readConfigToml(configPath)).harnesses as Record<string, any>
    ).pi.routing;
    expect(routing.provider).toBe("openrouter");

    // Switch back to Pi's default provider (undefined) — must clear both stores.
    await applyRouting(configPath, { primaryModel: "gpt-5.2" });
    routing = (
      (await readConfigToml(configPath)).harnesses as Record<string, any>
    ).pi.routing;
    expect("provider" in routing).toBe(false);
  });

  test("explicit (none) image model clears a previously-set one", async () => {
    // First: an image model is set.
    await applyRouting(
      configPath,
      { primaryModel: "deepseek-v4-pro", imageModel: "gpt-4o" }
    );

    // Then: operator picks "(none)" for the image model — undefined — which must
    // clear the stale value in config.toml.
    await applyRouting(
      configPath,
      { primaryModel: "gpt-5.2", imageModel: undefined }
    );

    const routing = (
      (await readConfigToml(configPath)).harnesses as Record<string, any>
    ).pi.routing;
    expect("image_model" in routing).toBe(false);
  });

  test("existing provider → configure now → choose (none) → provider removed from toml", async () => {
    // Reproduces the review regression end-to-end through the wizard's two seams:
    // the provider-resolution decision (resolveRoutingProvider) and the
    // persistence (applyRouting). With openrouter already configured, the picker
    // returning "" for "(none)" must clear the provider, NOT fall back to it.
    await applyRouting(
      configPath,
      { provider: "openrouter", primaryModel: "z-ai/glm-5.2" }
    );
    const current = "openrouter";

    // Operator re-runs "configure now" and selects "(none)" → pickProvider yields
    // "". The wizard resolves the provider it will persist:
    const resolved = resolveRoutingProvider("", current);
    expect(resolved).toBe(""); // explicit clear, NOT "openrouter"

    await applyRouting(
      configPath,
      { provider: resolved, primaryModel: "gpt-5.2" }
    );

    const routing = (
      (await readConfigToml(configPath)).harnesses as Record<string, any>
    ).pi.routing;
    expect("provider" in routing).toBe(false);
  });

  test("coding_model: persists to config.toml", async () => {
    await applyRouting(
      configPath,
      {
        primaryModel: "gpt-5.2",
        codingModel: "gpt-5.2-codex",
      }
    );
    const routing = (
      (await readConfigToml(configPath)).harnesses as Record<string, any>
    ).pi.routing;
    expect(routing.coding_model).toBe("gpt-5.2-codex");
  });

  test("preserves unrelated config keys (does not clobber the chain)", async () => {
    const { applyHarnessChain } = await import("../src/cli/harness.ts");
    await applyHarnessChain(configPath, ["pi", "claude"]);
    await applyRouting(
      configPath,
      { primaryModel: "gpt-5.2" }
    );
    const toml = await readConfigToml(configPath);
    expect((toml.harnesses as Record<string, any>).chain).toEqual(["pi", "claude"]);
    expect((toml.harnesses as Record<string, any>).pi.routing.primary_model).toBe(
      "gpt-5.2",
    );
  });
});

describe("resolveHarnessWriteTarget (phantombot#441, wizard scope)", () => {
  const cfg = (defaultPersona: string) =>
    ({
      configPath,
      personasDir: join(workdir, "personas"),
      defaultPersona,
    }) as any;

  test("a NON-DEFAULT persona is written in persona scope even with no file yet", async () => {
    // THE edge Lena caught: resolvePersonaWriteTarget falls back to the GLOBAL
    // file until the persona has one of its own. For the chain that fallback is
    // harmless (it writes the legacy per-persona table), but routing is written
    // as a plain [harnesses.pi.routing] — in the global file that is the HOST
    // default every other persona inherits under the per-key merge. Configuring
    // Lena would move Kai's models via TOML, which is the very leak the suffixed
    // env mirror closes on the env side.
    const target = await resolveHarnessWriteTarget(cfg("robbie"), "lena");
    expect(target.scope).toBe("persona");
    expect(target.path).toBe(join(workdir, "personas", "lena", "config.toml"));
    expect(target.envSuffix).toBe("LENA");

    // And the write actually materialises that file rather than the global one.
    await applyRouting(target.path, { primaryModel: "lena-primary" });
    expect((await readConfigToml(target.path) as any).harnesses.pi.routing.primary_model)
      .toBe("lena-primary");
    expect(await readConfigToml(configPath)).toEqual({});
  });

  test("the DEFAULT persona keeps the global-file fallback until migration runs", async () => {
    // Unmigrated hosts must stay readable by an older binary — release rings
    // make rollback real — so the default persona only moves to its own file
    // once that file exists.
    const before = await resolveHarnessWriteTarget(cfg("robbie"), "robbie");
    expect(before.scope).toBe("global");
    expect(before.path).toBe(configPath);
    expect(before.envSuffix).toBeUndefined();

    const personaPath = join(workdir, "personas", "robbie", "config.toml");
    await applyRouting(personaPath, { primaryModel: "host-primary" });
    const after = await resolveHarnessWriteTarget(cfg("robbie"), "robbie");
    expect(after.scope).toBe("persona");
    expect(after.path).toBe(personaPath);
    expect(after.envSuffix).toBeUndefined();
  });

  test("no --persona is the default persona, not a suffixed one", async () => {
    const target = await resolveHarnessWriteTarget(cfg("robbie"));
    expect(target.persona).toBe("robbie");
    expect(target.envSuffix).toBeUndefined();
    expect(target.scope).toBe("global");
  });
});

describe("persona clears are tombstoned, not deleted (phantombot#441)", () => {
  const cfg = (defaultPersona: string) =>
    ({
      configPath,
      personasDir: join(workdir, "personas"),
      defaultPersona,
    }) as any;

  test("PERSONA scope writes an explicit use_local_config opt-out", async () => {
    // THE bug Kai caught: deleting a persona's routing keys is not clearing
    // them. Under the per-key merge an absent key falls back to the HOST's
    // [harnesses.pi.routing] — so "use Pi's own config" silently resolved to
    // the host's provider and models. The cleared state needs its own spelling.
    const target = await resolveHarnessWriteTarget(cfg("robbie"), "lena");
    await applyRouting(
      target.path,
      { provider: "openrouter", primaryModel: "lena-primary", codingModel: "lena-coder" }
    );

    await clearPiRouting(target.path, { tombstone: true });

    const routing = (await readConfigToml(target.path) as any).harnesses.pi.routing;
    expect(routing.use_local_config).toBe(true);
    expect(routing.provider).toBeUndefined();
    expect(routing.primary_model).toBeUndefined();
    expect(routing.coding_model).toBeUndefined();
  });

  test("GLOBAL scope never writes the tombstone (it would be inherited host-wide)", async () => {
    // In the global file the flag is not this persona's opt-out, it is every
    // persona's: any persona that does not state its own routing inherits it.
    await applyRouting(configPath, { primaryModel: "host-primary" });
    await clearPiRouting(configPath);
    const routing = (await readConfigToml(configPath) as any).harnesses.pi.routing;
    expect(routing.use_local_config).toBeUndefined();
    expect(routing.primary_model).toBeUndefined();
  });

  test("configuring models REVOKES a previous opt-out in the same write", async () => {
    const target = await resolveHarnessWriteTarget(cfg("robbie"), "lena");
    await clearPiRouting(target.path, { tombstone: true });
    await applyRouting(
      target.path,
      { primaryModel: "lena-primary-2" }
    );
    const routing = (await readConfigToml(target.path) as any).harnesses.pi.routing;
    expect(routing.use_local_config).toBeUndefined();
    expect(routing.primary_model).toBe("lena-primary-2");
  });
});

describe("snapshotPiRouting / restorePiRouting (brain-wizard rollback)", () => {
  test("puts a previous routing table back after the wizard overwrote it", async () => {
    await applyRouting(configPath, {
      provider: "openrouter",
      primaryModel: "gpt-4.1",
      imageModel: "gpt-4.1",
      codingModel: "qwen-coder",
    });
    const snap = await snapshotPiRouting(configPath);

    await applyRouting(configPath, {
      provider: "groq",
      primaryModel: "llama-4",
      codingModel: undefined,
    });
    expect(
      (await readConfigToml(configPath)).harnesses,
    ).toMatchObject({ pi: { routing: { provider: "groq" } } });

    await restorePiRouting(configPath, snap);
    const toml = await readConfigToml(configPath);
    expect((toml.harnesses as any).pi.routing).toEqual({
      provider: "openrouter",
      primary_model: "gpt-4.1",
      image_model: "gpt-4.1",
      coding_model: "qwen-coder",
    });
  });

  test("round-trips the 'use Pi's own config' tombstone", async () => {
    await clearPiRouting(configPath, { tombstone: true });
    const snap = await snapshotPiRouting(configPath);

    await applyRouting(configPath, {
      provider: "openrouter",
      primaryModel: "gpt-4.1",
    });
    await restorePiRouting(configPath, snap);

    const routing = (await readConfigToml(configPath)).harnesses as any;
    // applyRouting REVOKES the tombstone; a key-by-key restore would have
    // left the persona silently inheriting the host routing instead.
    expect(routing.pi.routing.use_local_config).toBe(true);
    expect(routing.pi.routing.provider).toBeUndefined();
  });

  test("deletes the table again when there was none at snapshot time", async () => {
    const snap = await snapshotPiRouting(configPath, "pi-primary");
    expect(snap).toBeUndefined();

    await applyRouting(
      configPath,
      { provider: "openrouter", primaryModel: "gpt-4.1" },
      "pi-primary",
    );
    await restorePiRouting(configPath, snap, "pi-primary");

    const toml = (await readConfigToml(configPath)).harnesses as any;
    expect(toml.instances?.["pi-primary"]?.routing).toBeUndefined();
  });

  test("snapshots each instance slot independently", async () => {
    await applyRouting(configPath, { provider: "groq", primaryModel: "a" }, "pi-primary");
    await applyRouting(configPath, { provider: "openrouter", primaryModel: "b" }, "pi-fallback");
    const primary = await snapshotPiRouting(configPath, "pi-primary");

    await applyRouting(configPath, { provider: "mistral", primaryModel: "c" }, "pi-primary");
    await restorePiRouting(configPath, primary, "pi-primary");

    const toml = (await readConfigToml(configPath)).harnesses as any;
    expect(toml.instances["pi-primary"].routing.provider).toBe("groq");
    expect(toml.instances["pi-fallback"].routing.provider).toBe("openrouter");
  });
});
