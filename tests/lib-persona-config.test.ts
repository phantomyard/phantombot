/**
 * Per-persona config layering + migration (phantombot#439).
 *
 * The invariants under test are the ones that make `/update` safe to type at
 * any time from any version: the merge never invents a default, migration
 * copies without deleting, and running it twice changes nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HOST_ONLY_KEYS,
  mergeToml,
  migratePersonaConfig,
  personaConfigPath,
  readPersonaToml,
  stripHostOnlyKeys,
} from "../src/lib/personaConfig.ts";
import { loadConfig, withHostHarnessBins } from "../src/config.ts";
import { harnessChainIds } from "../src/harnesses/buildChain.ts";
import { readConfigToml } from "../src/lib/configWriter.ts";

let workdir: string;
let personasDir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-personacfg-"));
  personasDir = join(workdir, "personas");
  await mkdir(join(personasDir, "robbie"), { recursive: true });
  await mkdir(join(personasDir, "lena"), { recursive: true });
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("mergeToml", () => {
  test("merges per key, override wins, tables recurse", () => {
    const merged = mergeToml(
      {
        chattiness: true,
        channels: {
          telegram: { token: "global", poll_timeout_s: 30 },
        },
      },
      { channels: { telegram: { token: "persona" } } },
    );
    expect(merged).toEqual({
      chattiness: true,
      channels: { telegram: { token: "persona", poll_timeout_s: 30 } },
    });
  });

  test("a key absent from the override falls back to the base, not a default", () => {
    const merged = mergeToml({ voice: { provider: "elevenlabs" } }, {});
    expect(merged).toEqual({ voice: { provider: "elevenlabs" } });
  });

  test("arrays replace wholesale so a persona can NARROW an allowlist", () => {
    const merged = mergeToml(
      { channels: { telegram: { allowed_user_ids: [1, 2, 3] } } },
      { channels: { telegram: { allowed_user_ids: [2] } } },
    );
    expect(
      (merged.channels as any).telegram.allowed_user_ids,
    ).toEqual([2]);
  });

  test("neither input is mutated", () => {
    const base = { channels: { telegram: { token: "a" } } };
    const override = { channels: { telegram: { token: "b" } } };
    mergeToml(base, override);
    expect(base.channels.telegram.token).toBe("a");
    expect(override.channels.telegram.token).toBe("b");
  });
});

describe("stripHostOnlyKeys", () => {
  test("drops every host-level key and keeps the rest", () => {
    const stripped = stripHostOnlyKeys({
      default_persona: "evil",
      update_channel: "preview",
      personas_dir: "/tmp/elsewhere",
      memory_db: "/tmp/other.sqlite",
      autostart_personas: ["evil"],
      chattiness: false,
    });
    expect(stripped).toEqual({ chattiness: false });
    for (const key of HOST_ONLY_KEYS) {
      expect(Object.keys(stripped)).not.toContain(key);
    }
  });
});

describe("migratePersonaConfig", () => {
  const globalToml = {
    default_persona: "robbie",
    update_channel: "preview",
    chattiness: false,
    voice: { provider: "elevenlabs" },
    channels: {
      telegram: {
        token: "default-bot",
        allowed_user_ids: [7],
        personas: { lena: { token: "lena-bot" } },
      },
    },
    harnesses: {
      chain: ["claude"],
      claude: { bin: "/usr/bin/claude", model: "opus" },
      pi: { routing: { primary_model: "gpt-5.2", image_model: "vision-x" } },
      personas: { lena: { chain: ["pi", "claude"] } },
    },
  };

  test("seeds the default persona with the persona-scoped keys only", async () => {
    const r = await migratePersonaConfig({
      personasDir,
      persona: "robbie",
      globalToml,
      isDefault: true,
    });
    expect(r.migrated).toBe(true);

    const written = await readPersonaToml(personasDir, "robbie");
    expect(written.chattiness).toBe(false);
    expect(written.voice).toEqual({ provider: "elevenlabs" });
    expect((written.channels as any).telegram.token).toBe("default-bot");
    // Host-level keys never travel into a persona file...
    expect(written.default_persona).toBeUndefined();
    expect(written.update_channel).toBeUndefined();
    // ...and neither does the host's persona→bot routing table.
    expect((written.channels as any).telegram.personas).toBeUndefined();
    // `[harnesses]` is persona-scoped (phantombot#441): the whole block travels,
    // models and bins included, so the persona file is a complete description of
    // the brain it thinks with.
    expect((written.harnesses as any).chain).toEqual(["claude"]);
    expect((written.harnesses as any).claude).toEqual({
      bin: "/usr/bin/claude",
      model: "opus",
    });
    expect((written.harnesses as any).pi.routing).toEqual({
      primary_model: "gpt-5.2",
      image_model: "vision-x",
    });
    // ...but NOT the host-shaped persona→chain routing table, for the same
    // reason `[channels.telegram.personas]` is dropped: inside a persona file
    // it would read as that persona's override for a persona of its own name.
    expect((written.harnesses as any).personas).toBeUndefined();
  });

  test("a persona's legacy chain entry beats the host chain it just copied", async () => {
    // Both descriptions of Lena exist in the global file: the host default
    // chain, and her own legacy `[harnesses.personas.lena]` entry. The specific
    // one has to win, or migrating would silently re-point her at the host's
    // brain.
    await migratePersonaConfig({
      personasDir,
      persona: "lena",
      globalToml,
      isDefault: false,
    });
    const written = await readPersonaToml(personasDir, "lena");
    expect((written.harnesses as any).chain).toEqual(["pi", "claude"]);
    expect((written.harnesses as any).personas).toBeUndefined();
    // The rest of the host block still comes along.
    expect((written.harnesses as any).claude.bin).toBe("/usr/bin/claude");
  });

  test("a hand-set model in a persona file survives migration", async () => {
    await mkdir(join(personasDir, "jake"), { recursive: true });
    await writeFile(
      join(personasDir, "jake", "config.toml"),
      '[harnesses.claude]\nmodel = "sonnet"\n',
      "utf8",
    );
    await migratePersonaConfig({
      personasDir,
      persona: "jake",
      globalToml,
      isDefault: false,
    });
    const written = await readPersonaToml(personasDir, "jake");
    // Seeded only what was MISSING: the hand-set model stands, the bin arrives.
    expect((written.harnesses as any).claude.model).toBe("sonnet");
    expect((written.harnesses as any).claude.bin).toBe("/usr/bin/claude");
  });

  test("a non-default persona takes its OWN bot, never the default's", async () => {
    await migratePersonaConfig({
      personasDir,
      persona: "lena",
      globalToml,
      isDefault: false,
    });
    const written = await readPersonaToml(personasDir, "lena");
    expect((written.channels as any).telegram.token).toBe("lena-bot");
    // Its per-persona harness chain becomes its plain chain.
    expect((written.harnesses as any).chain).toEqual(["pi", "claude"]);
  });

  test("the default persona takes its legacy bot when no host account exists", async () => {
    const r = await migratePersonaConfig({
      personasDir,
      persona: "robbie",
      globalToml: {
        channels: {
          telegram: {
            personas: {
              robbie: {
                token: "legacy-default-bot",
                allowed_user_ids: [7],
              },
            },
          },
        },
      },
      isDefault: true,
    });

    expect(r).toMatchObject({ migrated: true, keys: ["channels"] });
    const written = await readPersonaToml(personasDir, "robbie");
    expect((written.channels as any).telegram).toEqual({
      token: "legacy-default-bot",
      allowed_user_ids: [7],
    });
    expect((written.channels as any).telegram.personas).toBeUndefined();
  });

  test("does not seed empty channel tables when no default account exists", async () => {
    const r = await migratePersonaConfig({
      personasDir,
      persona: "robbie",
      globalToml: {
        channels: {
          telegram: {
            personas: { lena: { token: "lena-bot" } },
          },
        },
      },
      isDefault: true,
    });

    expect(r).toEqual({ migrated: false, reason: "nothing-to-copy" });
    expect(await readPersonaToml(personasDir, "robbie")).toEqual({});
  });

  test("a non-default persona with no bot of its own inherits none", async () => {
    await mkdir(join(personasDir, "kai"), { recursive: true });
    await migratePersonaConfig({
      personasDir,
      persona: "kai",
      globalToml,
      isDefault: false,
    });
    const written = await readPersonaToml(personasDir, "kai");
    expect((written.channels as any)?.telegram).toBeUndefined();
  });

  test("NEVER deletes from the global file", async () => {
    const globalPath = join(workdir, "config.toml");
    const before = 'default_persona = "robbie"\n\n[channels.telegram]\ntoken = "default-bot"\n';
    await writeFile(globalPath, before, "utf8");
    await migratePersonaConfig({
      personasDir,
      persona: "robbie",
      globalToml: await readConfigToml(globalPath),
      isDefault: true,
    });
    expect(await readFile(globalPath, "utf8")).toBe(before);
  });

  test("idempotent: a second run over a fully seeded file writes nothing", async () => {
    await migratePersonaConfig({
      personasDir,
      persona: "robbie",
      globalToml,
      isDefault: true,
    });
    const path = personaConfigPath(personasDir, "robbie");
    const first = await readFile(path, "utf8");

    const second = await migratePersonaConfig({
      personasDir,
      persona: "robbie",
      globalToml,
      isDefault: true,
    });
    expect(second).toEqual({ migrated: false, reason: "exists" });
    expect(await readFile(path, "utf8")).toBe(first);
  });

  test("never clobbers a hand edit, but fills the keys it omits", async () => {
    const path = personaConfigPath(personasDir, "robbie");
    await mkdir(join(personasDir, "robbie"), { recursive: true });
    await writeFile(path, 'chattiness = true\n', "utf8");

    const r = await migratePersonaConfig({
      personasDir,
      persona: "robbie",
      globalToml,
      isDefault: true,
    });
    expect(r.migrated).toBe(true);
    const written = await readPersonaToml(personasDir, "robbie");
    // The hand-set value survives...
    expect(written.chattiness).toBe(true);
    // ...and the rest of the persona-scoped keys are seeded around it.
    expect((written.channels as any)?.telegram?.token).toBe("default-bot");
  });

  test("a partial persona file still gets its Telegram account translated", async () => {
    // Kai's repro: `phantombot voice --persona lena` writes `[voice]` into
    // lena's file BEFORE the first daemon start on the new binary. Treating
    // any non-empty file as "already migrated" would skip lena's Telegram
    // translation forever — she would then inherit the DEFAULT persona's bot
    // from the global file and planListeners would refuse to start Telegram
    // at all (one token, two listeners).
    const path = personaConfigPath(personasDir, "lena");
    await mkdir(join(personasDir, "lena"), { recursive: true });
    await writeFile(path, '[voice]\nprovider = "openai"\n', "utf8");

    const r = await migratePersonaConfig({
      personasDir,
      persona: "lena",
      globalToml,
      isDefault: false,
    });
    expect(r.migrated).toBe(true);
    const written = await readPersonaToml(personasDir, "lena");
    expect((written.voice as any)?.provider).toBe("openai");
    expect((written.channels as any)?.telegram?.token).toBe("lena-bot");
  });

  test("a host with nothing persona-scoped grows no empty file", async () => {
    const r = await migratePersonaConfig({
      personasDir,
      persona: "robbie",
      globalToml: { default_persona: "robbie" },
      isDefault: true,
    });
    expect(r).toEqual({ migrated: false, reason: "nothing-to-copy" });
    expect(await readPersonaToml(personasDir, "robbie")).toEqual({});
  });
});

describe("loadConfig persona layering", () => {
  // EVERY env var that outranks TOML in the assertions below has to be
  // scrubbed, not just the ones that point at the fixture. Two have bitten
  // this repo before: `PHANTOMBOT_PERSONA` is set on every child a harness
  // turn spawns (`withPersonaEnv`), and `TELEGRAM_BOT_TOKEN` is exported on
  // any real configured host — with either one live these tests read the
  // machine instead of the fixture and fail (or, worse, pass for the wrong
  // reason).
  const SCRUBBED = [
    "PHANTOMBOT_CONFIG",
    "PHANTOMBOT_PERSONAS_DIR",
    "PHANTOMBOT_STATE",
    "PHANTOMBOT_DEFAULT_PERSONA",
    "PHANTOMBOT_PERSONA",
    "PHANTOMBOT_AUTOSTART_PERSONAS",
    "PHANTOMBOT_CHATTINESS",
    "PHANTOMBOT_HARNESS_CHAIN",
    "PHANTOMBOT_UPDATE_CHANNEL",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_ALLOWED_USER_IDS",
    // The default bot's unsuffixed env overrides, and the suffixed forms the
    // persona layer reads instead. Several tests below set these DELIBERATELY
    // to reproduce a real host (where the default token arrives vault -> env),
    // so they must be saved and restored like everything else.
    "PHANTOMBOT_TELEGRAM_ALLOWED_USERS",
    "PHANTOMBOT_TELEGRAM_POLL_S",
    "PHANTOMBOT_TELEGRAM_GROUP_PERSONAS",
    "TELEGRAM_BOT_TOKEN_LENA",
    "TELEGRAM_BOT_TOKEN_ROBBIE",
    "PHANTOMBOT_TELEGRAM_ALLOWED_USERS_LENA",
    "PHANTOMBOT_TELEGRAM_POLL_S_LENA",
    "PHANTOMBOT_TELEGRAM_GROUP_PERSONAS_LENA",
    // The harness/model env layer (phantombot#441), host-ambient and
    // persona-suffixed. Same reason as the Telegram vars: the wizard writes the
    // unsuffixed forms into the shared env file, so any real host has them set
    // and an unscrubbed test would read the machine, not the fixture.
    "PHANTOMBOT_CLAUDE_MODEL",
    "PHANTOMBOT_CLAUDE_MODEL_LENA",
    "PHANTOMBOT_CLAUDE_BIN",
    "PHANTOMBOT_CLAUDE_BIN_LENA",
    "PHANTOMBOT_CLAUDE_FALLBACK_MODEL",
    "PHANTOMBOT_CODEX_MODEL",
    "PHANTOMBOT_CODEX_BIN",
    "PHANTOMBOT_PI_BIN",
    "PHANTOMBOT_HARNESS_CHAIN_LENA",
    "PHANTOMBOT_PRIMARY_MODEL",
    "PHANTOMBOT_PRIMARY_MODEL_LENA",
    "PHANTOMBOT_IMAGE_MODEL",
    "PHANTOMBOT_IMAGE_MODEL_LENA",
    "PHANTOMBOT_CODING_MODEL",
    "PHANTOMBOT_PI_PROVIDER",
    "PHANTOMBOT_PI_PROVIDER_LENA",
  ] as const;
  const SAVED = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const k of SCRUBBED) {
      SAVED.set(k, process.env[k]);
      delete process.env[k];
    }
    process.env.PHANTOMBOT_CONFIG = join(workdir, "config.toml");
    process.env.PHANTOMBOT_PERSONAS_DIR = personasDir;
    process.env.PHANTOMBOT_STATE = join(workdir, "state.json");
  });
  afterEach(() => {
    for (const k of SCRUBBED) {
      const v = SAVED.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    SAVED.clear();
  });

  test("no persona file = exactly the pre-#439 behaviour", async () => {
    await writeFile(
      process.env.PHANTOMBOT_CONFIG!,
      'default_persona = "robbie"\n\n[channels.telegram]\ntoken = "global-bot"\n',
      "utf8",
    );
    const config = await loadConfig();
    expect(config.channels.telegram?.token).toBe("global-bot");
    expect(config.personaLayer).toBe("robbie");
    expect(config.autostartPersonas).toEqual([]);
  });

  test("a migrated default account is removed from the effective legacy routing table", async () => {
    await writeFile(
      process.env.PHANTOMBOT_CONFIG!,
      'default_persona = "robbie"\n\n' +
        '[channels.telegram.personas.robbie]\n' +
        'token = "legacy-default-bot"\n\n' +
        '[channels.telegram.personas.lena]\n' +
        'token = "lena-bot"\n',
      "utf8",
    );
    const global = await readConfigToml(process.env.PHANTOMBOT_CONFIG!);
    await migratePersonaConfig({
      personasDir,
      persona: "robbie",
      globalToml: global,
      isDefault: true,
    });

    const config = await loadConfig();
    expect(config.channels.telegram?.token).toBe("legacy-default-bot");
    expect(config.channels.telegramPersonas?.robbie).toBeUndefined();
    expect(config.channels.telegramPersonas?.lena?.token).toBe("lena-bot");
  });

  test("a distinct legacy bot for the default persona remains routable", async () => {
    await writeFile(
      process.env.PHANTOMBOT_CONFIG!,
      'default_persona = "robbie"\n\n' +
        '[channels.telegram]\n' +
        'token = "primary-bot"\n\n' +
        '[channels.telegram.personas.robbie]\n' +
        'token = "second-bot"\n',
      "utf8",
    );
    await writeFile(
      personaConfigPath(personasDir, "robbie"),
      '[channels.telegram]\ntoken = "primary-bot"\n',
      "utf8",
    );

    const config = await loadConfig();
    expect(config.channels.telegram?.token).toBe("primary-bot");
    expect(config.channels.telegramPersonas?.robbie?.token).toBe("second-bot");
  });

  test("a suffixed env override can keep a copied legacy entry distinct", async () => {
    await writeFile(
      process.env.PHANTOMBOT_CONFIG!,
      'default_persona = "robbie"\n\n' +
        '[channels.telegram.personas.robbie]\n' +
        'token = "copied-bot"\n',
      "utf8",
    );
    await writeFile(
      personaConfigPath(personasDir, "robbie"),
      '[channels.telegram]\ntoken = "copied-bot"\n',
      "utf8",
    );
    process.env.TELEGRAM_BOT_TOKEN = "primary-env-bot";
    process.env.TELEGRAM_BOT_TOKEN_ROBBIE = "second-env-bot";

    const config = await loadConfig();
    expect(config.channels.telegram?.token).toBe("primary-env-bot");
    expect(config.channels.telegramPersonas?.robbie?.token).toBe(
      "second-env-bot",
    );
  });

  test("the persona file wins per key; unmentioned keys fall back to global", async () => {
    await writeFile(
      process.env.PHANTOMBOT_CONFIG!,
      'default_persona = "robbie"\nchattiness = false\n\n' +
        '[channels.telegram]\ntoken = "global-bot"\npoll_timeout_s = 11\n',
      "utf8",
    );
    await writeFile(
      personaConfigPath(personasDir, "robbie"),
      '[channels.telegram]\ntoken = "robbie-bot"\n',
      "utf8",
    );
    const config = await loadConfig();
    expect(config.channels.telegram?.token).toBe("robbie-bot");
    expect(config.channels.telegram?.pollTimeoutS).toBe(11);
    expect(config.chattiness).toBe(false);
  });

  test("loadConfig(name) layers ANOTHER persona without changing the default", async () => {
    await writeFile(
      process.env.PHANTOMBOT_CONFIG!,
      'default_persona = "robbie"\n\n[channels.telegram]\ntoken = "global-bot"\n',
      "utf8",
    );
    await writeFile(
      personaConfigPath(personasDir, "lena"),
      '[channels.telegram]\ntoken = "lena-bot"\n',
      "utf8",
    );
    const lena = await loadConfig("lena");
    expect(lena.channels.telegram?.token).toBe("lena-bot");
    expect(lena.defaultPersona).toBe("robbie");
    expect(lena.personaLayer).toBe("lena");
  });

  test("a persona cannot elect itself default or move the host's channel", async () => {
    await writeFile(
      process.env.PHANTOMBOT_CONFIG!,
      'default_persona = "robbie"\nupdate_channel = "stable"\n',
      "utf8",
    );
    await writeFile(
      personaConfigPath(personasDir, "lena"),
      'default_persona = "lena"\nupdate_channel = "preview"\n' +
        `personas_dir = "${join(workdir, "hijacked")}"\n`,
      "utf8",
    );
    const config = await loadConfig("lena");
    expect(config.defaultPersona).toBe("robbie");
    expect(config.updateChannel).toBe("stable");
    expect(config.personasDir).toBe(personasDir);
  });

  test("a persona's own harness chain beats the LEGACY personas table", async () => {
    // The post-migration state every upgraded host is in: the legacy
    // `[harnesses.personas.lena]` entry still sits in the global file (copy,
    // never delete — a rollback has to keep booting) AND lena's own file now
    // states her chain. `harnessChainIds` reads the legacy table first, so
    // without the fix the persona's own file could never take effect and
    // editing it would silently do nothing.
    await writeFile(
      process.env.PHANTOMBOT_CONFIG!,
      'default_persona = "robbie"\n\n[harnesses]\nchain = ["claude"]\n\n' +
        '[harnesses.personas.lena]\nchain = ["codex"]\n',
      "utf8",
    );
    await writeFile(
      personaConfigPath(personasDir, "lena"),
      '[harnesses]\nchain = ["pi"]\n',
      "utf8",
    );
    const lena = await loadConfig("lena");
    expect(harnessChainIds(lena, "lena")).toEqual(["pi"]);
    // Another persona's legacy entry is untouched by lena's layer.
    const robbie = await loadConfig("robbie");
    expect(harnessChainIds(robbie, "lena")).toEqual(["codex"]);
  });

  test("an UNMIGRATED persona keeps its legacy harness chain", async () => {
    await writeFile(
      process.env.PHANTOMBOT_CONFIG!,
      'default_persona = "robbie"\n\n[harnesses]\nchain = ["claude"]\n\n' +
        '[harnesses.personas.lena]\nchain = ["codex"]\n',
      "utf8",
    );
    const lena = await loadConfig("lena");
    expect(harnessChainIds(lena, "lena")).toEqual(["codex"]);
  });

  test("a non-default persona never inherits the default persona's bot", async () => {
    // Otherwise two listeners hold one token and planListeners (rightly)
    // refuses to start Telegram at all.
    await writeFile(
      process.env.PHANTOMBOT_CONFIG!,
      'default_persona = "robbie"\n\n[channels.telegram]\ntoken = "robbie-bot"\n',
      "utf8",
    );
    await writeFile(
      personaConfigPath(personasDir, "lena"),
      '[voice]\nprovider = "openai"\n',
      "utf8",
    );
    const lena = await loadConfig("lena");
    expect(lena.channels.telegram).toBeUndefined();
    expect(lena.voice.provider).toBe("openai");
  });

  test("a non-default persona falls back to its LEGACY routing-table bot", async () => {
    await writeFile(
      process.env.PHANTOMBOT_CONFIG!,
      'default_persona = "robbie"\n\n[channels.telegram]\ntoken = "robbie-bot"\n\n' +
        '[channels.telegram.personas.lena]\ntoken = "lena-bot"\n',
      "utf8",
    );
    const lena = await loadConfig("lena");
    expect(lena.channels.telegram?.token).toBe("lena-bot");
    // The routing table itself stays readable: planListeners still uses it to
    // plan OTHER personas' legacy listeners.
    expect(lena.channels.telegramPersonas?.lena?.token).toBe("lena-bot");
  });

  test("a PARTIAL persona telegram table never borrows the host token", async () => {
    // Kai's round-2 repro: lena's file states an allowlist but no token. The
    // deep merge has already folded the host account underneath it, so a fix
    // that merely skips the isolation rewrite when lena "has a telegram table"
    // hands her the DEFAULT persona's token with her allowlist — two listeners
    // on one bot, and lena answering on the owner's bot.
    await writeFile(
      process.env.PHANTOMBOT_CONFIG!,
      'default_persona = "robbie"\n\n[channels.telegram]\n' +
        'token = "robbie-bot"\nallowed_user_ids = [1]\n',
      "utf8",
    );
    await writeFile(
      personaConfigPath(personasDir, "lena"),
      "[channels.telegram]\nallowed_user_ids = [2]\n",
      "utf8",
    );
    const lena = await loadConfig("lena");
    // An account with no token of its own is INCOMPLETE, not a licence to
    // borrow the host's: lena simply has no Telegram until she is given a bot.
    expect(lena.channels.telegram).toBeUndefined();
  });

  test("a persona's own model beats the host's ambient env var", async () => {
    // The #441 crux. The harness wizard writes PHANTOMBOT_PRIMARY_MODEL into
    // the SHARED env file, so on any configured host the ambient var is set. If
    // env beat TOML unconditionally (phantombot's usual rule) every persona
    // would think with the host's model and the persona-scoped `[harnesses]`
    // block would be decorative.
    process.env.PHANTOMBOT_CLAUDE_MODEL = "host-opus";
    process.env.PHANTOMBOT_PRIMARY_MODEL = "host-primary";
    process.env.PHANTOMBOT_IMAGE_MODEL = "host-vision";
    await writeFile(
      process.env.PHANTOMBOT_CONFIG!,
      'default_persona = "robbie"\n',
      "utf8",
    );
    await writeFile(
      personaConfigPath(personasDir, "lena"),
      '[harnesses.claude]\nmodel = "lena-sonnet"\n\n' +
        '[harnesses.pi.routing]\nprimary_model = "lena-primary"\n',
      "utf8",
    );
    const lena = await loadConfig("lena");
    expect(lena.harnesses.claude.model).toBe("lena-sonnet");
    expect(lena.harnesses.pi.routing?.primaryModel).toBe("lena-primary");
    // A key lena does NOT state still takes the host's ambient value — the
    // fallback is the host, never a constant.
    expect(lena.harnesses.pi.routing?.imageModel).toBe("host-vision");
  });

  test("a cleared persona inherits NOTHING — not the host TOML, not ambient env", async () => {
    // Kai's Major: the wizard's "use Pi's own config" used to DELETE the
    // persona's routing keys, and under a per-key merge an absent key is the
    // host's key. So clearing Lena's routing resolved straight back to the
    // host's provider and models, and the host's ambient env on top of that.
    // The cleared state is now stated explicitly (use_local_config).
    process.env.PHANTOMBOT_PRIMARY_MODEL = "host-primary";
    process.env.PHANTOMBOT_IMAGE_MODEL = "host-vision";
    process.env.PHANTOMBOT_PI_PROVIDER = "host-provider";
    await writeFile(
      process.env.PHANTOMBOT_CONFIG!,
      'default_persona = "robbie"\n\n[harnesses.pi.routing]\n' +
        'provider = "openrouter"\nprimary_model = "host-toml-primary"\n' +
        'coding_model = "host-toml-coder"\n',
      "utf8",
    );
    await writeFile(
      personaConfigPath(personasDir, "lena"),
      "[harnesses.pi.routing]\nuse_local_config = true\n",
      "utf8",
    );
    const lena = await loadConfig("lena");
    expect(lena.harnesses.pi.routing?.useLocalConfig).toBe(true);
    expect(lena.harnesses.pi.routing?.provider).toBeUndefined();
    expect(lena.harnesses.pi.routing?.primaryModel).toBeUndefined();
    expect(lena.harnesses.pi.routing?.imageModel).toBeUndefined();
    expect(lena.harnesses.pi.routing?.codingModel).toBeUndefined();
    // ...and the host itself is untouched by another persona's opt-out.
    expect((await loadConfig("robbie")).harnesses.pi.routing?.primaryModel)
      .toBe("host-primary");
  });

  test("a persona's OWN suffixed env var still beats its file", async () => {
    process.env.PHANTOMBOT_CLAUDE_MODEL = "host-opus";
    process.env.PHANTOMBOT_CLAUDE_MODEL_LENA = "lena-env";
    await writeFile(
      process.env.PHANTOMBOT_CONFIG!,
      'default_persona = "robbie"\n',
      "utf8",
    );
    await writeFile(
      personaConfigPath(personasDir, "lena"),
      '[harnesses.claude]\nmodel = "lena-file"\n',
      "utf8",
    );
    expect((await loadConfig("lena")).harnesses.claude.model).toBe("lena-env");
  });

  test("an UNMIGRATED persona keeps the pre-#441 env-over-TOML rule", async () => {
    // No persona file: the ambient var must still win over the global TOML, or
    // upgrading would silently change which model an existing host runs.
    process.env.PHANTOMBOT_CLAUDE_MODEL = "host-env";
    await writeFile(
      process.env.PHANTOMBOT_CONFIG!,
      'default_persona = "robbie"\n\n[harnesses.claude]\nmodel = "global-toml"\n',
      "utf8",
    );
    expect((await loadConfig("lena")).harnesses.claude.model).toBe("host-env");
    // ...and so does the DEFAULT persona, whose layer IS the host's.
    await writeFile(
      personaConfigPath(personasDir, "robbie"),
      '[harnesses.claude]\nmodel = "robbie-file"\n',
      "utf8",
    );
    expect((await loadConfig("robbie")).harnesses.claude.model).toBe("host-env");
  });

  test("a persona states its own chain and Pi provider", async () => {
    await writeFile(
      process.env.PHANTOMBOT_CONFIG!,
      'default_persona = "robbie"\n\n[harnesses]\nchain = ["claude"]\n',
      "utf8",
    );
    await writeFile(
      personaConfigPath(personasDir, "lena"),
      '[harnesses]\nchain = ["pi", "claude"]\n\n' +
        '[harnesses.pi.routing]\nprovider = "openrouter"\n',
      "utf8",
    );
    const lena = await loadConfig("lena");
    expect(lena.harnesses.chain).toEqual(["pi", "claude"]);
    expect(lena.harnesses.pi.routing?.provider).toBe("openrouter");
    expect((await loadConfig("robbie")).harnesses.chain).toEqual(["claude"]);
  });

  test("only a DELIBERATELY pinned bin survives withHostHarnessBins", async () => {
    // Migration copies the host's bins into every persona file, so "the file
    // mentions a bin" cannot mean "pinned" — that would freeze each persona on
    // whatever path was probed the day it migrated. A bin that DIFFERS from the
    // host's is a real pin and is honoured.
    await writeFile(
      process.env.PHANTOMBOT_CONFIG!,
      'default_persona = "robbie"\n\n[harnesses.claude]\nbin = "/usr/bin/claude"\n\n' +
        '[harnesses.pi]\nbin = "/usr/bin/pi"\n',
      "utf8",
    );
    await writeFile(
      personaConfigPath(personasDir, "lena"),
      '[harnesses.claude]\nbin = "/usr/bin/claude"\n\n' +
        '[harnesses.pi]\nbin = "/opt/lena/pi"\n',
      "utf8",
    );
    const host = await loadConfig("robbie");
    const lena = withHostHarnessBins(await loadConfig("lena"), host);
    expect(lena.harnesses.pi.bin).toBe("/opt/lena/pi");
    expect(lena.harnesses.claude.bin).toBe("/usr/bin/claude");
    expect(lena.harnesses.ownBins).toEqual(["pi"]);

    // The echoed bin follows the host when the binary moves.
    const moved: typeof host = {
      ...host,
      harnesses: {
        ...host.harnesses,
        claude: { ...host.harnesses.claude, bin: "/opt/new/claude" },
      },
    };
    expect(
      withHostHarnessBins(await loadConfig("lena"), moved).harnesses.claude.bin,
    ).toBe("/opt/new/claude");
  });

  test("ambient DEFAULT bot env vars never reach a non-default persona", async () => {
    // Round-3 Major (Kai + Lena). `applyPersonaLayer` rebuilds lena's TOML
    // account from scratch, but `buildTelegramConfig` used to reapply the
    // UNSUFFIXED env overrides on top of it — and on a real host that is
    // exactly where the default bot's token arrives (vault -> env). Result:
    // every non-default persona resolved back to the owner's bot, two
    // listeners on one token, isolation silently undone.
    process.env.TELEGRAM_BOT_TOKEN = "HOST_DEFAULT_ENV";
    process.env.PHANTOMBOT_TELEGRAM_ALLOWED_USERS = "111";
    process.env.PHANTOMBOT_TELEGRAM_POLL_S = "7";
    process.env.PHANTOMBOT_TELEGRAM_GROUP_PERSONAS = "hostgroup";
    await writeFile(
      process.env.PHANTOMBOT_CONFIG!,
      'default_persona = "robbie"\n',
      "utf8",
    );
    await writeFile(
      personaConfigPath(personasDir, "lena"),
      '[channels.telegram]\ntoken = "lena-bot"\n' +
        "allowed_user_ids = [222]\npoll_timeout_s = 21\n" +
        'group_persona_names = ["lenagroup"]\n',
      "utf8",
    );
    const lena = await loadConfig("lena");
    expect(lena.channels.telegram?.token).toBe("lena-bot");
    expect(lena.channels.telegram?.allowedUserIds).toEqual([222]);
    expect(lena.channels.telegram?.pollTimeoutS).toBe(21);
    expect(lena.channels.telegram?.groupPersonaNames).toEqual(["lenagroup"]);
  });

  test("an ambient host token alone gives a non-default persona NO telegram", async () => {
    // Lena's exact repro: no TOML account anywhere, only the host token in the
    // environment. Ignoring the unsuffixed vars must mean ignoring them, not
    // falling back to them — a fallback is the same leak by another name.
    process.env.TELEGRAM_BOT_TOKEN = "HOST_DEFAULT_ENV";
    await writeFile(
      process.env.PHANTOMBOT_CONFIG!,
      'default_persona = "robbie"\n',
      "utf8",
    );
    const lena = await loadConfig("lena");
    expect(lena.channels.telegram).toBeUndefined();
    // ...while the default persona still gets it, exactly as before.
    const robbie = await loadConfig("robbie");
    expect(robbie.channels.telegram?.token).toBe("HOST_DEFAULT_ENV");
  });

  test("a non-default persona reads its OWN suffixed env overrides", async () => {
    // The convention the README already documents for named accounts, now
    // reaching the persona layer: env still wins over TOML, per persona.
    process.env.TELEGRAM_BOT_TOKEN = "HOST_DEFAULT_ENV";
    process.env.TELEGRAM_BOT_TOKEN_LENA = "lena-env-bot";
    process.env.PHANTOMBOT_TELEGRAM_ALLOWED_USERS_LENA = "333";
    process.env.PHANTOMBOT_TELEGRAM_POLL_S_LENA = "9";
    process.env.PHANTOMBOT_TELEGRAM_GROUP_PERSONAS_LENA = "lenaenvgroup";
    await writeFile(
      process.env.PHANTOMBOT_CONFIG!,
      'default_persona = "robbie"\n',
      "utf8",
    );
    await writeFile(
      personaConfigPath(personasDir, "lena"),
      '[channels.telegram]\ntoken = "lena-toml-bot"\n' +
        "allowed_user_ids = [222]\npoll_timeout_s = 21\n",
      "utf8",
    );
    const lena = await loadConfig("lena");
    expect(lena.channels.telegram?.token).toBe("lena-env-bot");
    expect(lena.channels.telegram?.allowedUserIds).toEqual([333]);
    expect(lena.channels.telegram?.pollTimeoutS).toBe(9);
    expect(lena.channels.telegram?.groupPersonaNames).toEqual(["lenaenvgroup"]);
  });

  test("the DEFAULT persona still honours the unsuffixed env overrides", async () => {
    // Pre-#439 behaviour, unchanged: those vars describe the default bot.
    process.env.TELEGRAM_BOT_TOKEN = "HOST_DEFAULT_ENV";
    process.env.PHANTOMBOT_TELEGRAM_ALLOWED_USERS = "111";
    await writeFile(
      process.env.PHANTOMBOT_CONFIG!,
      'default_persona = "robbie"\n\n[channels.telegram]\n' +
        'token = "robbie-toml-bot"\nallowed_user_ids = [1]\n',
      "utf8",
    );
    const robbie = await loadConfig();
    expect(robbie.channels.telegram?.token).toBe("HOST_DEFAULT_ENV");
    expect(robbie.channels.telegram?.allowedUserIds).toEqual([111]);
  });

  test("a partial persona table completes from its LEGACY entry, not the host", async () => {
    await writeFile(
      process.env.PHANTOMBOT_CONFIG!,
      'default_persona = "robbie"\n\n[channels.telegram]\n' +
        'token = "robbie-bot"\npoll_timeout_s = 11\n\n' +
        '[channels.telegram.personas.lena]\ntoken = "lena-bot"\n',
      "utf8",
    );
    await writeFile(
      personaConfigPath(personasDir, "lena"),
      "[channels.telegram]\nallowed_user_ids = [2]\n",
      "utf8",
    );
    const lena = await loadConfig("lena");
    expect(lena.channels.telegram?.token).toBe("lena-bot");
    expect(lena.channels.telegram?.allowedUserIds).toEqual([2]);
  });

  test("autostart_personas parses, trims, dedupes and survives junk", async () => {
    await writeFile(
      process.env.PHANTOMBOT_CONFIG!,
      'default_persona = "robbie"\nautostart_personas = ["lena", " kai ", "lena", ""]\n',
      "utf8",
    );
    expect((await loadConfig()).autostartPersonas).toEqual(["lena", "kai"]);

    await writeFile(
      process.env.PHANTOMBOT_CONFIG!,
      'default_persona = "robbie"\nautostart_personas = "lena"\n',
      "utf8",
    );
    expect((await loadConfig()).autostartPersonas).toEqual([]);
  });
});
