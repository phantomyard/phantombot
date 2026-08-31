/**
 * Tests for `phantombot run` — focused on the early-exit failure paths.
 * The full Telegram polling loop is exercised by the runTelegramServer
 * tests in tests/channels-telegram.test.ts (now folded into the run cmd).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  armShutdownWatchdog,
  planListeners,
  selectPhantomchatPersonas,
  runRun,
  SHUTDOWN_GRACE_MS,
} from "../src/cli/run.ts";
import { savePhantomchatPersonaConfig } from "../src/channels/phantomchat/personaStore.ts";
import { generateIdentity } from "../src/lib/nostrIdentity.ts";
import { acquireRunLock } from "../src/lib/runLock.ts";
import type { Config } from "../src/config.ts";

class CaptureStream {
  chunks: string[] = [];
  write(s: string | Uint8Array): boolean {
    this.chunks.push(typeof s === "string" ? s : new TextDecoder().decode(s));
    return true;
  }
  get text(): string {
    return this.chunks.join("");
  }
}

const SAVED_STATE = process.env.PHANTOMBOT_STATE;

let workdir: string;
let config: Config;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-run-"));
  process.env.PHANTOMBOT_STATE = join(workdir, "state.json");
  await mkdir(join(workdir, "personas", "phantom"), { recursive: true });
  await writeFile(
    join(workdir, "personas", "phantom", "BOOT.md"),
    "# Phantom",
  );
  config = {
    defaultPersona: "phantom",
    harnessIdleTimeoutMs: 600_000, harnessHardTimeoutMs: 600_000, harnessStartupTimeoutMs: 600_000,
    personasDir: join(workdir, "personas"),
    memoryDbPath: join(workdir, "memory.sqlite"),
    configPath: join(workdir, "config.toml"),
    harnesses: {
      chain: ["claude"],
      claude: { bin: "claude", model: "opus", fallbackModel: "sonnet" },
      pi: { bin: "pi", maxPayloadBytes: 1_000_000 },
    },
    channels: {},
    embeddings: { provider: "none" },
    voice: { provider: "none" },
  };
});

afterEach(async () => {
  if (SAVED_STATE === undefined) delete process.env.PHANTOMBOT_STATE;
  else process.env.PHANTOMBOT_STATE = SAVED_STATE;
  await rm(workdir, { recursive: true, force: true });
});

describe("runRun — early exits", () => {
  test("returns 2 when telegram is not configured", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const code = await runRun({ config, out, err });
    expect(code).toBe(2);
    expect(err.text).toContain("phantombot telegram");
  });

  test("incomplete Telegram-only config warns before exiting with no runnable channel", async () => {
    const err = new CaptureStream();
    const code = await runRun({
      config: { ...config, channels: { telegramStated: true } },
      lockPath: join(workdir, "run.lock"),
      out: new CaptureStream(),
      err,
    });

    expect(code).toBe(2);
    expect(err.text).toContain("persona 'phantom'");
    expect(err.text).toContain("no bot_token");
    expect(err.text).toContain("no telegram listeners could be started");
    expect(err.text).toContain("check the warnings above");
    expect(err.text).not.toContain("no channels configured");
  });

  test("returns 2 when persona dir is missing and no other personas exist", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    await rm(join(workdir, "personas", "phantom"), { recursive: true });
    const code = await runRun({
      config: {
        ...config,
        channels: {
          telegram: {
            token: "abc",
            pollTimeoutS: 30,
            allowedUserIds: [],
          },
        },
      },
      out,
      err,
    });
    expect(code).toBe(2);
    expect(err.text).toContain("no other personas exist");
  });

  test("heals to another persona when default is missing but others exist", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    // Remove the configured default persona, but leave a different one.
    await rm(join(workdir, "personas", "phantom"), { recursive: true });
    await mkdir(join(workdir, "personas", "kai"), { recursive: true });
    await writeFile(join(workdir, "personas", "kai", "BOOT.md"), "# Kai");

    // Use an empty harness chain to force an early exit (code 2) after
    // the persona validation passes. This proves healing worked without
    // launching a full Telegram polling server.
    const code = await runRun({
      config: {
        ...config,
        defaultPersona: "ghostfixture",
        harnesses: { ...config.harnesses, chain: [] },
        channels: {
          telegram: {
            token: "abc",
            pollTimeoutS: 30,
            allowedUserIds: [],
          },
        },
      },
      lockPath: join(workdir, "run.lock"),
      out,
      err,
    });
    // Should fail on harness chain, not persona-missing.
    expect(code).toBe(2);
    expect(err.text).not.toContain("no other personas exist");
    expect(err.text).toContain("phantombot harness");
  });

  test("canonicalizes a default even when its wrong-cased path resolves", async () => {
    const canonicalDir = join(workdir, "personas", "Phantom");
    await rename(join(workdir, "personas", "phantom"), canonicalDir);
    // Reproduce a case-insensitive filesystem on Linux: the configured path
    // resolves, while the directory listing still supplies canonical spelling.
    await symlink(canonicalDir, join(workdir, "personas", "phantom"), "dir");
    const err = new CaptureStream();
    const caseConfig = {
      ...config,
      harnesses: { ...config.harnesses, chain: [] },
      channels: {
        telegram: { token: "abc", pollTimeoutS: 30, allowedUserIds: [] },
      },
    };

    const code = await runRun({
      config: caseConfig,
      lockPath: join(workdir, "run.lock"),
      out: new CaptureStream(),
      err,
    });

    expect(code).toBe(2);
    expect(caseConfig.defaultPersona).toBe("Phantom");
    expect(err.text).toContain("case mismatch against persona dir");
  });

  test("returns 2 when harness chain is empty", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const code = await runRun({
      config: {
        ...config,
        harnesses: { ...config.harnesses, chain: [] },
        channels: {
          telegram: {
            token: "abc",
            pollTimeoutS: 30,
            allowedUserIds: [],
          },
        },
      },
      out,
      err,
    });
    expect(code).toBe(2);
    expect(err.text).toContain("phantombot harness");
  });

  test("returns success without stderr when the supervisor finds the daemon already running", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const lockPath = join(workdir, "run.lock");
    const held = acquireRunLock(lockPath);
    if (!("release" in held)) throw new Error("setup: expected to hold run lock");
    try {
      const code = await runRun({
        config: {
          ...config,
          channels: {
            telegram: { token: "abc", pollTimeoutS: 30, allowedUserIds: [] },
          },
        },
        lockPath,
        ifNotRunning: true,
        checkHarnesses: false,
        out,
        err,
      });
      expect(code).toBe(0);
      expect(err.text).toBe("");
    } finally {
      held.release();
    }
  });

  test("keeps the interactive already-running diagnostic by default", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const lockPath = join(workdir, "run.lock");
    const held = acquireRunLock(lockPath);
    if (!("release" in held)) throw new Error("setup: expected to hold run lock");
    try {
      const code = await runRun({
        config: {
          ...config,
          channels: {
            telegram: { token: "abc", pollTimeoutS: 30, allowedUserIds: [] },
          },
        },
        lockPath,
        checkHarnesses: false,
        out,
        err,
      });
      expect(code).toBe(1);
      expect(err.text).toContain("phantombot is already running");
    } finally {
      held.release();
    }
  });

  test("warns but keeps running when a configured harness binary is missing", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    let listenerStarted = false;
    const code = await runRun({
      config: {
        ...config,
        harnesses: { ...config.harnesses, chain: ["pi"] },
        channels: {
          telegram: {
            token: "abc",
            pollTimeoutS: 30,
            allowedUserIds: [],
          },
        },
      },
      lockPath: join(workdir, "run.lock"),
      checkHarnesses: async () => [{ id: "pi", bin: "pi" }],
      runTelegramServer: async () => {
        listenerStarted = true;
      },
      out,
      err,
    });
    expect(code).toBe(0);
    expect(listenerStarted).toBe(true);
    expect(err.text).toContain("configured harness binary not found");
    expect(err.text).toContain("pi: 'pi'");
    expect(err.text).toContain("Phantombot will keep running");
  });

  test("persists resolved harness binaries before starting listeners", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    await runRun({
      config: {
        ...config,
        harnesses: { ...config.harnesses, chain: ["pi"] },
        channels: {
          telegram: {
            token: "abc",
            pollTimeoutS: 30,
            allowedUserIds: [],
          },
        },
      },
      lockPath: join(workdir, "run.lock"),
      checkHarnesses: async () => [
        { id: "pi", bin: "pi", resolved: "/opt/pi-node/bin/pi" },
      ],
      runTelegramServer: async () => {},
      out,
      err,
    });

    const state = JSON.parse(await readFile(join(workdir, "state.json"), "utf8"));
    expect(state.harness_bins.pi).toBe("/opt/pi-node/bin/pi");
  });
});

describe("runRun — multi-persona telegram", () => {
  test("passes each listener its effective persona harness chain", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    await mkdir(join(workdir, "personas", "amanda"), { recursive: true });
    await writeFile(join(workdir, "personas", "amanda", "BOOT.md"), "# Amanda");
    const chains: Record<string, string[]> = {};

    const code = await runRun({
      config: {
        ...config,
        harnesses: {
          ...config.harnesses,
          chain: ["codex"],
          personas: { amanda: { chain: ["claude", "codex"] } },
          codex: { bin: "codex", model: "" },
        },
        channels: {
          telegram: { token: "default-tok", pollTimeoutS: 30, allowedUserIds: [] },
          telegramPersonas: {
            amanda: { token: "amanda-tok", pollTimeoutS: 30, allowedUserIds: [] },
          },
        },
      },
      lockPath: join(workdir, "run.lock"),
      checkHarnesses: false,
      runTelegramServer: async (input) => {
        chains[input.persona] = input.harnesses.map((h) => h.id);
      },
      out,
      err,
    });

    expect(code).toBe(0);
    expect(chains.phantom).toEqual(["codex"]);
    expect(chains.amanda).toEqual(["claude", "codex"]);
  });

  test("a LEGACY-routed persona gets its OWN resolved config, not the default's", async () => {
    // phantombot#439 round 2: `autostart_personas` is not the only road to a
    // second listener — a host still routing through
    // `[channels.telegram.personas.amanda]` gets one too, and a listener with
    // no resolved config silently runs on the DEFAULT persona's harness chain,
    // voice, chattiness and timeouts. Migration seeds amanda's config.toml, so
    // the run wiring must resolve it.
    const out = new CaptureStream();
    const err = new CaptureStream();
    await mkdir(join(workdir, "personas", "amanda"), { recursive: true });
    await writeFile(join(workdir, "personas", "amanda", "BOOT.md"), "# Amanda");
    await writeFile(
      join(workdir, "personas", "amanda", "config.toml"),
      'chattiness = true\n',
      "utf8",
    );
    const asked: string[] = [];
    const chains: Record<string, string[]> = {};

    const code = await runRun({
      config: {
        ...config,
        harnesses: {
          ...config.harnesses,
          chain: ["codex"],
          codex: { bin: "codex", model: "" },
        },
        channels: {
          telegram: { token: "default-tok", pollTimeoutS: 30, allowedUserIds: [] },
          telegramPersonas: {
            amanda: { token: "amanda-tok", pollTimeoutS: 30, allowedUserIds: [] },
          },
        },
      },
      lockPath: join(workdir, "run.lock"),
      checkHarnesses: false,
      loadPersonaConfig: async (name) => {
        asked.push(name);
        return {
          ...config,
          harnesses: {
            ...config.harnesses,
            chain: ["claude"],
            claude: { ...config.harnesses.claude, bin: "claude" },
          },
          channels: {
            telegramPersonas: {
              amanda: {
                token: "amanda-tok",
                pollTimeoutS: 30,
                allowedUserIds: [],
              },
            },
          },
        } as typeof config;
      },
      runTelegramServer: async (input) => {
        chains[input.persona] = input.harnesses.map((h) => h.id);
      },
      out,
      err,
    });

    expect(code).toBe(0);
    expect(asked).toContain("amanda");
    expect(chains.amanda).toEqual(["claude"]);
    expect(chains.phantom).toEqual(["codex"]);
  });

  test("fails startup when a telegram persona override has no usable harness", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    await mkdir(join(workdir, "personas", "amanda"), { recursive: true });
    await writeFile(join(workdir, "personas", "amanda", "BOOT.md"), "# Amanda");
    let listenerStarted = false;

    const code = await runRun({
      config: {
        ...config,
        harnesses: {
          ...config.harnesses,
          personas: { amanda: { chain: ["claudee"] } },
        },
        channels: {
          telegram: { token: "default-tok", pollTimeoutS: 30, allowedUserIds: [] },
          telegramPersonas: {
            amanda: { token: "amanda-tok", pollTimeoutS: 30, allowedUserIds: [] },
          },
        },
      },
      lockPath: join(workdir, "run.lock"),
      checkHarnesses: false,
      runTelegramServer: async () => {
        listenerStarted = true;
      },
      out,
      err,
    });

    expect(code).toBe(2);
    expect(listenerStarted).toBe(false);
    expect(err.text).toContain("unknown harness 'claudee'");
    expect(err.text).toContain("telegram persona 'amanda' has no usable harnesses");
  });

  test("starts when only [channels.telegram.personas.*] is configured (no default block)", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    await mkdir(join(workdir, "personas", "miles"), { recursive: true });
    await writeFile(join(workdir, "personas", "miles", "BOOT.md"), "# Miles");

    const code = await runRun({
      config: {
        ...config,
        harnesses: { ...config.harnesses, chain: [] }, // force early exit after planning
        channels: {
          telegramPersonas: {
            miles: { token: "miles-token", pollTimeoutS: 30, allowedUserIds: [] },
          },
        },
      },
      lockPath: join(workdir, "run.lock"),
      out,
      err,
    });
    // Plan succeeded; failed on empty harness chain (proves planner accepted personas-only setup).
    expect(code).toBe(2);
    expect(err.text).toContain("phantombot harness");
    expect(err.text).not.toContain("phantombot telegram");
  });

  // Direct unit test of planListeners — the runRun() wrapper exits on
  // the empty harness chain before printing its listener table, so the
  // only way to assert on the planner output is to call it directly.
  test("planListeners builds one listener per configured persona, in order", async () => {
    const err = new CaptureStream();
    await mkdir(join(workdir, "personas", "miles"), { recursive: true });
    await writeFile(join(workdir, "personas", "miles", "BOOT.md"), "# Miles");
    await mkdir(join(workdir, "personas", "desiree"), { recursive: true });
    await writeFile(join(workdir, "personas", "desiree", "BOOT.md"), "# Desiree");

    const plan = planListeners(
      {
        ...config,
        channels: {
          telegram: { token: "default-tok", pollTimeoutS: 30, allowedUserIds: [1] },
          telegramPersonas: {
            miles: { token: "miles-tok", pollTimeoutS: 30, allowedUserIds: [2] },
            desiree: { token: "desiree-tok", pollTimeoutS: 30, allowedUserIds: [3] },
          },
        },
      },
      "phantom",
      err,
    );

    expect(plan.fatal).toBeUndefined();
    expect(plan.listeners).toHaveLength(3);

    // Default listener is first (defines the admin channel).
    expect(plan.listeners[0]).toMatchObject({
      persona: "phantom",
      source: "default",
      account: { token: "default-tok" },
    });

    // Persona listeners follow, each bound to its own bot + agentDir.
    const byPersona = Object.fromEntries(
      plan.listeners.map((l) => [l.persona, l]),
    );
    expect(byPersona.miles).toMatchObject({
      source: "personas.miles",
      account: { token: "miles-tok", allowedUserIds: [2] },
    });
    expect(byPersona.miles!.agentDir).toBe(join(workdir, "personas", "miles"));
    expect(byPersona.desiree).toMatchObject({
      source: "personas.desiree",
      account: { token: "desiree-tok", allowedUserIds: [3] },
    });
    expect(byPersona.desiree!.agentDir).toBe(
      join(workdir, "personas", "desiree"),
    );

    // Tokens are all distinct (the duplicate-token guard didn't trip).
    const tokens = plan.listeners.map((l) => l.account.token);
    expect(new Set(tokens).size).toBe(3);
  });

  test("runRun seeds the default persona's config file, idempotently (#439)", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const globalPath = join(workdir, "config.toml");
    const globalText =
      'default_persona = "phantom"\nchattiness = false\n\n' +
      '[channels.telegram]\ntoken = "tok"\n';
    await writeFile(globalPath, globalText, "utf8");
    const personaPath = join(workdir, "personas", "phantom", "config.toml");

    const run = () =>
      runRun({
        config: {
          ...config,
          // Empty chain → exits at the harness guard, AFTER migration.
          harnesses: { ...config.harnesses, chain: [] },
          channels: {
            telegram: { token: "tok", pollTimeoutS: 30, allowedUserIds: [] },
          },
        },
        lockPath: join(workdir, "run.lock"),
        out,
        err,
      });

    expect(await run()).toBe(2);
    const seeded = await readFile(personaPath, "utf8");
    expect(seeded).toContain("tok");
    expect(seeded).toContain("chattiness");
    // The global file is untouched — an older binary must still boot.
    expect(await readFile(globalPath, "utf8")).toBe(globalText);

    // Second start over the already-seeded file changes nothing at all:
    // /update is order-independent and re-running is free.
    expect(await run()).toBe(2);
    expect(await readFile(personaPath, "utf8")).toBe(seeded);

    // A hand edit is preserved, and only the keys the file OMITS are filled
    // back in — a partial file (e.g. one `phantombot voice --persona` wrote
    // before the first restart) must not leave the persona half-migrated.
    await writeFile(personaPath, 'chattiness = true\n', "utf8");
    expect(await run()).toBe(2);
    const reseeded = await readFile(personaPath, "utf8");
    expect(reseeded).toContain("chattiness = true");
    expect(reseeded).toContain("tok");
  });

  // --- autostart personas (phantombot#439) ---------------------------------

  async function givePersona(name: string) {
    await mkdir(join(workdir, "personas", name), { recursive: true });
    await writeFile(join(workdir, "personas", name, "BOOT.md"), `# ${name}`);
  }

  function personaConfigWithBot(_name: string, token: string): Config {
    return {
      ...config,
      channels: {
        telegram: { token, pollTimeoutS: 30, allowedUserIds: [] },
      },
    };
  }

  test("selectPhantomchatPersonas gates on the explicit boot roster", () => {
    const err = new CaptureStream();
    const specs = [
      { persona: "phantom" },
      { persona: "lena" },
      { persona: "imported" },
    ];

    // An explicit roster is the whole truth: an imported/restored identity
    // that merely EXISTS on disk must never start talking to the world.
    const gated = selectPhantomchatPersonas(
      specs,
      { autostartPersonas: ["lena"] },
      "phantom",
      err,
    );
    expect(gated.map((s) => s.persona)).toEqual(["phantom", "lena"]);
    expect(err.text).toContain("imported");
    expect(err.text).toContain("autostart_personas");
  });

  test("no autostart_personas key = every configured identity still starts", () => {
    const err = new CaptureStream();
    const specs = [{ persona: "phantom" }, { persona: "lena" }];
    // Upgrade safety: a host that has never been told what to start keeps
    // exactly today's behaviour rather than silently losing a channel.
    const ungated = selectPhantomchatPersonas(
      specs,
      { autostartPersonas: undefined },
      "phantom",
      err,
    );
    expect(ungated).toEqual(specs);
    expect(err.text).toBe("");
  });

  test("planListeners starts an autostart persona from its OWN config", async () => {
    const err = new CaptureStream();
    await givePersona("lena");

    const plan = planListeners(
      {
        ...config,
        autostartPersonas: ["lena"],
        channels: {
          telegram: { token: "default-tok", pollTimeoutS: 30, allowedUserIds: [] },
        },
      },
      "phantom",
      err,
      new Map([["lena", personaConfigWithBot("lena", "lena-tok")]]),
    );

    expect(plan.fatal).toBeUndefined();
    expect(plan.listeners).toHaveLength(2);
    expect(plan.listeners[1]).toMatchObject({
      persona: "lena",
      source: "autostart.lena",
      account: { token: "lena-tok" },
    });
    // The listener carries its own config so its turns run with its settings.
    expect(plan.listeners[1]!.config?.channels.telegram?.token).toBe("lena-tok");
  });

  test("listing the default persona in autostart does NOT start it twice", async () => {
    const err = new CaptureStream();
    const plan = planListeners(
      {
        ...config,
        autostartPersonas: ["phantom"],
        channels: {
          telegram: { token: "default-tok", pollTimeoutS: 30, allowedUserIds: [] },
        },
      },
      "phantom",
      err,
      new Map([["phantom", personaConfigWithBot("phantom", "default-tok")]]),
    );
    expect(plan.fatal).toBeUndefined();
    expect(plan.listeners).toHaveLength(1);
  });

  test("a migrated persona in BOTH its own file and the legacy table starts once", async () => {
    const err = new CaptureStream();
    await givePersona("lena");
    // This is exactly the post-migration shape: copy-not-delete leaves the bot
    // described in the legacy table AND in lena's own config file.
    const plan = planListeners(
      {
        ...config,
        autostartPersonas: ["lena"],
        channels: {
          telegram: {
            token: "default-tok",
            pollTimeoutS: 30,
            allowedUserIds: [],
          },
          telegramPersonas: {
            lena: { token: "lena-tok", pollTimeoutS: 30, allowedUserIds: [] },
          },
        },
      },
      "phantom",
      err,
      new Map([["lena", personaConfigWithBot("lena", "lena-tok")]]),
    );
    // Without the dedupe this is the duplicate-token fatal, and Telegram dies
    // on every migrated multi-persona host.
    expect(plan.fatal).toBeUndefined();
    expect(plan.listeners.filter((l) => l.persona === "lena")).toHaveLength(1);
  });

  test("an autostart persona with no bot of its own is skipped, not fatal", async () => {
    const err = new CaptureStream();
    await givePersona("lena");
    const plan = planListeners(
      {
        ...config,
        autostartPersonas: ["lena"],
        channels: {
          telegram: { token: "default-tok", pollTimeoutS: 30, allowedUserIds: [] },
        },
      },
      "phantom",
      err,
      new Map([["lena", { ...config, channels: {} }]]),
    );
    expect(plan.fatal).toBeUndefined();
    expect(plan.listeners).toHaveLength(1);
    expect(err.text).toBe("");
  });

  test("an autostart persona that states an incomplete bot warns without throwing", async () => {
    const err = new CaptureStream();
    await givePersona("lena");
    const plan = planListeners(
      {
        ...config,
        autostartPersonas: ["lena"],
        channels: {
          telegram: { token: "default-tok", pollTimeoutS: 30, allowedUserIds: [] },
        },
      },
      "phantom",
      err,
      new Map([["lena", {
        ...config,
        channels: { telegramStated: true },
      }]]),
    );

    expect(plan.fatal).toBeUndefined();
    expect(plan.listeners).toHaveLength(1);
    expect(err.text).toContain("persona 'lena'");
    expect(err.text).toContain("no bot_token");
    expect(err.text).toContain("no telegram listener will start");
  });

  test("incomplete default and legacy accounts warn but do not make planning fatal", async () => {
    const err = new CaptureStream();
    await givePersona("lena");
    const plan = planListeners(
      {
        ...config,
        channels: {
          telegramStated: true,
          telegramPersonasStated: ["lena"],
        },
      },
      "phantom",
      err,
    );

    expect(plan.fatal).toBeUndefined();
    expect(plan.listeners).toEqual([]);
    expect(err.text).toContain("persona 'phantom'");
    expect(err.text).toContain("persona 'lena'");
    expect(err.text.match(/no bot_token/g)).toHaveLength(2);
  });

  test("an autostart persona with no dir on disk warns and is skipped", async () => {
    const err = new CaptureStream();
    const plan = planListeners(
      {
        ...config,
        autostartPersonas: ["ghost"],
        channels: {
          telegram: { token: "default-tok", pollTimeoutS: 30, allowedUserIds: [] },
        },
      },
      "phantom",
      err,
      new Map([["ghost", personaConfigWithBot("ghost", "ghost-tok")]]),
    );
    expect(plan.listeners).toHaveLength(1);
    expect(err.text).toContain("ghost");
  });

  test("two autostart personas sharing one bot token still fatal", async () => {
    const err = new CaptureStream();
    await givePersona("lena");
    await givePersona("kai");
    const plan = planListeners(
      {
        ...config,
        autostartPersonas: ["lena", "kai"],
        channels: {},
      },
      "phantom",
      err,
      new Map([
        ["lena", personaConfigWithBot("lena", "shared")],
        ["kai", personaConfigWithBot("kai", "shared")],
      ]),
    );
    expect(plan.fatal).toContain("token reused");
  });

  test("planListeners returns personas-only listeners when no default block is set", async () => {
    const err = new CaptureStream();
    await mkdir(join(workdir, "personas", "miles"), { recursive: true });
    await writeFile(join(workdir, "personas", "miles", "BOOT.md"), "# Miles");

    const plan = planListeners(
      {
        ...config,
        channels: {
          telegramPersonas: {
            miles: { token: "miles-tok", pollTimeoutS: 30, allowedUserIds: [] },
          },
        },
      },
      "phantom",
      err,
    );

    expect(plan.fatal).toBeUndefined();
    expect(plan.listeners).toHaveLength(1);
    expect(plan.listeners[0]!.source).toBe("personas.miles");
    expect(plan.listeners.find((l) => l.source === "default")).toBeUndefined();
  });

  test("skips a persona block whose agent dir is missing but keeps the others", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    // 'phantom' (default) exists from beforeEach; 'miles' is configured but missing on disk.

    const code = await runRun({
      config: {
        ...config,
        harnesses: { ...config.harnesses, chain: [] },
        channels: {
          telegram: { token: "default-tok", pollTimeoutS: 30, allowedUserIds: [] },
          telegramPersonas: {
            miles: { token: "miles-tok", pollTimeoutS: 30, allowedUserIds: [] },
          },
        },
      },
      lockPath: join(workdir, "run.lock"),
      out,
      err,
    });
    expect(code).toBe(2); // empty harness chain (planner did NOT fatal)
    expect(err.text).toContain("phantombot harness");
    expect(err.text).toContain("personas.miles");
    expect(err.text).toContain("no agent dir");
  });

  test("fatal when default + persona share the same token", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    await mkdir(join(workdir, "personas", "miles"), { recursive: true });
    await writeFile(join(workdir, "personas", "miles", "BOOT.md"), "# Miles");

    const code = await runRun({
      config: {
        ...config,
        channels: {
          telegram: { token: "shared", pollTimeoutS: 30, allowedUserIds: [] },
          telegramPersonas: {
            miles: { token: "shared", pollTimeoutS: 30, allowedUserIds: [] },
          },
        },
      },
      lockPath: join(workdir, "run.lock"),
      out,
      err,
    });
    expect(code).toBe(2);
    expect(err.text).toMatch(/token reused/);
  });

  test("fatal when two persona entries share the same token", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    await mkdir(join(workdir, "personas", "miles"), { recursive: true });
    await writeFile(join(workdir, "personas", "miles", "BOOT.md"), "# Miles");
    await mkdir(join(workdir, "personas", "desiree"), { recursive: true });
    await writeFile(join(workdir, "personas", "desiree", "BOOT.md"), "# Desiree");

    const code = await runRun({
      config: {
        ...config,
        channels: {
          telegramPersonas: {
            miles: { token: "shared", pollTimeoutS: 30, allowedUserIds: [] },
            desiree: { token: "shared", pollTimeoutS: 30, allowedUserIds: [] },
          },
        },
      },
      lockPath: join(workdir, "run.lock"),
      out,
      err,
    });
    expect(code).toBe(2);
    expect(err.text).toMatch(/token reused/);
  });

  test("returns 2 when every configured persona is missing", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    // No default block, miles configured but no miles persona on disk.
    const code = await runRun({
      config: {
        ...config,
        channels: {
          telegramPersonas: {
            miles: { token: "miles-tok", pollTimeoutS: 30, allowedUserIds: [] },
          },
        },
      },
      lockPath: join(workdir, "run.lock"),
      out,
      err,
    });
    expect(code).toBe(2);
    expect(err.text).toContain("no telegram listeners could be started");
  });
});

describe("runRun — phantomchat-only (no Telegram)", () => {
  // `phantombot init` now makes PhantomChat the required primary channel and
  // lets the user skip Telegram. The clean no-Telegram install has NO
  // [channels.telegram] / [channels.telegram.personas] but DOES have a persona
  // phantomchat.json. runRun must accept that as a runnable channel instead of
  // bailing at the Telegram guard (which would install a service that dies on
  // first start). We use the empty-harness-chain trick to force a clean early
  // exit AFTER the channel guards have accepted the setup — proving the
  // PhantomChat-only path is reached without spinning up real relay sockets.
  test("accepts a phantomchat-only setup past the Telegram and listener guards", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const agentDir = join(workdir, "personas", "lena");
    await mkdir(agentDir, { recursive: true });
    await savePhantomchatPersonaConfig(agentDir, {
      nsec: generateIdentity().nsec,
      relays: ["wss://relay.example"],
      allowedNpubs: [generateIdentity().npub],
    });

    const code = await runRun({
      config: {
        ...config,
        harnesses: { ...config.harnesses, chain: [] }, // force exit after channel guards
        channels: {}, // no Telegram at all
      },
      lockPath: join(workdir, "run.lock"),
      out,
      err,
    });

    // Got past the Telegram guard AND the "no telegram listeners" guard, then
    // hit the empty harness chain — proving the PhantomChat-only path is live.
    expect(code).toBe(2);
    expect(err.text).toContain("phantombot harness");
    expect(err.text).not.toContain("no channels configured");
    expect(err.text).not.toContain("no telegram listeners could be started");
  });

  // A BROKEN (not just absent) Telegram config must also degrade to
  // PhantomChat-only rather than kill the service — the app must never fail to
  // start while a runnable channel exists. Same empty-harness-chain trick:
  // reaching the harness guard proves we got PAST the Telegram fatal.
  async function givePhantomchat(persona = "lena") {
    const agentDir = join(workdir, "personas", persona);
    await mkdir(agentDir, { recursive: true });
    await savePhantomchatPersonaConfig(agentDir, {
      nsec: generateIdentity().nsec,
      relays: ["wss://relay.example"],
      allowedNpubs: [generateIdentity().npub],
    });
  }

  test("incomplete Telegram warns and continues with PhantomChat", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    await givePhantomchat("phantom");
    const code = await runRun({
      config: {
        ...config,
        harnesses: { ...config.harnesses, chain: [] },
        channels: { telegramStated: true },
      },
      lockPath: join(workdir, "run.lock"),
      out,
      err,
    });

    // Reaching the harness guard proves the broken Telegram account did not
    // throw or terminate startup while PhantomChat remained runnable.
    expect(code).toBe(2);
    expect(err.text).toContain("no bot_token");
    expect(err.text).toContain("phantombot harness");
    expect(err.text).not.toContain("no channels configured");
    expect(err.text).not.toContain("no telegram listeners could be started");
  });

  test("reused Telegram bot token degrades to PhantomChat-only (does NOT fatal)", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    await givePhantomchat();
    const code = await runRun({
      config: {
        ...config,
        harnesses: { ...config.harnesses, chain: [] }, // exit after channel guards
        channels: {
          // default + a persona share ONE token → planListeners would fatal.
          telegram: { token: "dup", pollTimeoutS: 30, allowedUserIds: [] },
          telegramPersonas: {
            phantom: { token: "dup", pollTimeoutS: 30, allowedUserIds: [] },
          },
        },
      },
      lockPath: join(workdir, "run.lock"),
      out,
      err,
    });
    // Reached the harness guard → got PAST the dup-token fatal (which would
    // otherwise have returned 2 without ever mentioning the harness).
    expect(code).toBe(2);
    expect(err.text).toContain("phantombot harness");
    expect(err.text).toContain("token reused"); // surfaced as a warning…
    expect(err.text).toContain("continuing with phantomchat only");
  });

  test("missing Telegram default persona degrades to PhantomChat-only (does NOT fatal)", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    await givePhantomchat();
    // Telegram default configured, but its persona dir does not exist and no
    // other persona can heal it.
    await rm(join(workdir, "personas", "phantom"), { recursive: true, force: true });
    const code = await runRun({
      config: {
        ...config,
        defaultPersona: "ghostfixture",
        harnesses: { ...config.harnesses, chain: [] },
        channels: {
          telegram: { token: "abc", pollTimeoutS: 30, allowedUserIds: [] },
        },
      },
      lockPath: join(workdir, "run.lock"),
      out,
      err,
    });
    expect(code).toBe(2);
    expect(err.text).toContain("phantombot harness"); // got past the persona-missing fatal
    expect(err.text).not.toContain("no other personas exist");
  });
});

describe("shutdown force-exit watchdog", () => {
  // On SIGTERM we abort and let the loop drain naturally — but a relay
  // ws.close() stuck on a half-open socket can keep the loop alive until
  // systemd's 90s SIGKILL. The watchdog bounds that to the grace window.
  test("grace window is bounded well under systemd's 90s SIGKILL", () => {
    expect(SHUTDOWN_GRACE_MS).toBeGreaterThan(0);
    expect(SHUTDOWN_GRACE_MS).toBeLessThan(90_000);
  });

  // The critical safety property: the watchdog must NOT keep the event loop
  // alive. If it were ref'd, every clean shutdown would stall for the full
  // grace window. hasRef() === false proves .unref() was applied.
  test("watchdog timer is unref'd so it never delays a clean shutdown", () => {
    const t = armShutdownWatchdog(60_000, () => {});
    expect((t as unknown as { hasRef(): boolean }).hasRef()).toBe(false);
    clearTimeout(t);
  });

  // And it actually fires onForce once the window elapses — this is what
  // replaces the 90s SIGKILL with a prompt clean exit.
  test("watchdog fires onForce after the grace window elapses", async () => {
    let fired = 0;
    armShutdownWatchdog(20, () => {
      fired += 1;
    });
    expect(fired).toBe(0);
    await new Promise((r) => setTimeout(r, 60));
    expect(fired).toBe(1);
  });
});
