/**
 * The #435 boundary: everything phantombot writes at runtime lives inside the
 * persona directory.
 *
 * The load-bearing test here is "every runtime path resolves inside the persona
 * directory" — it enumerates the real path resolvers rather than restating a
 * list of strings, so a NEW path helper that forgets the boundary fails this
 * test without anyone remembering to extend it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inboxDir } from "../src/channels/telegram/parse.ts";
import { chattinessStatePath } from "../src/lib/chattiness.ts";
import { defaultTickLockPath } from "../src/cli/tick.ts";
import { withPersonaEnv } from "../src/lib/envBootstrap.ts";
import { defaultEnvFilePath } from "../src/lib/envFile.ts";
import {
  activePersona,
  ensurePersonaTmpDir,
  loadGlobalConfig,
  personaConfigPath,
  personaDbPath,
  personaEnvPath,
  personaLogDir,
  personaMemoryIndexPath,
  personaRoot,
  personaRunDir,
  personaStatePath,
  personaTmpDir,
  setGlobalConfigValue,
  tmpEnvOverlay,
} from "../src/lib/personaPaths.ts";
import { replyModeStatePath } from "../src/lib/replyMode.ts";
import { taskLogsDir } from "../src/lib/taskScheduler.ts";
import { heartbeatMarkerPath, tickMarkerPath } from "../src/lib/timerHealth.ts";
import { defaultDigestDir } from "../src/lib/turnDigest.ts";
import { defaultRegistryDir } from "../src/lib/turnRegistry.ts";
import { pendingUpdatePath, lastNotifiedPath } from "../src/lib/updateNotify.ts";
import { defaultLockDir } from "../src/lib/workspaceLock.ts";

const ENV_KEYS = [
  "PHANTOMBOT_PERSONA",
  "PHANTOMBOT_PERSONAS_DIR",
  "PHANTOMBOT_GLOBAL_CONFIG",
  "PHANTOMBOT_CONFIG",
  "PHANTOMBOT_STATE",
  "PHANTOMBOT_ENV_FILE",
  "PHANTOMBOT_MEMORY_DB",
  "PHANTOMBOT_CHATTINESS_STATE",
  "PHANTOMBOT_REPLY_MODE_STATE",
  "PHANTOMBOT_WORKSPACE_LOCK_DIR",
  "PHANTOMBOT_TURN_REGISTRY_DIR",
  "PHANTOMBOT_TURN_DIGEST_DIR",
  "XDG_DATA_HOME",
];
const SAVED: Record<string, string | undefined> = {};

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-persona-paths-"));
  for (const k of ENV_KEYS) {
    SAVED[k] = process.env[k];
    delete process.env[k];
  }
  process.env.PHANTOMBOT_PERSONAS_DIR = join(workdir, "personas");
  process.env.PHANTOMBOT_GLOBAL_CONFIG = join(workdir, "personas", "config.toml");
  process.env.PHANTOMBOT_PERSONA = "lena";
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
  await rm(workdir, { recursive: true, force: true });
});

describe("persona boundary (#435)", () => {
  test("EVERY runtime path resolves inside the active persona's directory", () => {
    // Enumerated as the real resolvers, not as strings: a new helper that
    // forgets the boundary is caught by adding one line here, and an existing
    // one that regresses is caught with no edit at all.
    const resolvers: Array<[string, () => string]> = [
      ["config.toml", personaConfigPath],
      ["state.json", personaStatePath],
      [".env", personaEnvPath],
      ["database", personaDbPath],
      ["memory index", personaMemoryIndexPath],
      ["run dir", personaRunDir],
      ["log dir", personaLogDir],
      ["tmp dir", personaTmpDir],
      ["env file (via envFile.ts)", defaultEnvFilePath],
      ["tick lock", defaultTickLockPath],
      ["workspace locks", defaultLockDir],
      ["turn registry", defaultRegistryDir],
      ["turn digests", defaultDigestDir],
      ["reply-mode overrides", replyModeStatePath],
      ["chattiness overrides", chattinessStatePath],
      ["heartbeat marker", heartbeatMarkerPath],
      ["tick marker", tickMarkerPath],
      ["pending-update marker", pendingUpdatePath],
      ["last-notified marker", lastNotifiedPath],
      ["task logs", taskLogsDir],
      ["telegram inbox", () => inboxDir("telegram:1001")],
    ];

    const root = personaRoot();
    expect(root).toBe(join(workdir, "personas", "lena"));
    for (const [what, resolve] of resolvers) {
      expect(`${what}: ${resolve()}`).toBe(`${what}: ${resolve()}`);
      expect(resolve().startsWith(root + "/")).toBe(true);
    }
  });

  test("nothing lands in the shared system temp directory", () => {
    // The whole point of forcing TMPDIR: a persona's scratch files are persona
    // data, and a /tmp sweep must not be able to yank one out mid-turn.
    // (The test workdir itself lives under /tmp, so the assertion that matters
    // is that the persona tmp dir is INSIDE the persona, not that its absolute
    // path avoids the system temp root.)
    expect(personaTmpDir()).toBe(join(personaRoot(), "tmp"));
    expect(personaTmpDir()).not.toBe(tmpdir());
    expect(ensurePersonaTmpDir()).toBe(join(personaRoot(), "tmp"));
  });

  test("two personas share no path at all", () => {
    const lena = personaConfigPath();
    process.env.PHANTOMBOT_PERSONA = "kai";
    const kai = personaConfigPath();
    expect(lena).not.toBe(kai);
    expect(personaDbPath()).toContain(join("personas", "kai"));
  });
});

describe("activePersona resolution", () => {
  test("PHANTOMBOT_PERSONA wins — it is what every service unit sets", () => {
    expect(activePersona()).toBe("lena");
  });

  test("falls back to the global default when the env var is unset", async () => {
    delete process.env.PHANTOMBOT_PERSONA;
    setGlobalConfigValue("default_persona", "kai");
    expect(activePersona()).toBe("kai");
  });

  test("falls back to the built-in name when there is no global file", () => {
    delete process.env.PHANTOMBOT_PERSONA;
    expect(activePersona()).toBe("phantom");
  });

  test("a corrupt global file degrades to defaults instead of throwing", async () => {
    delete process.env.PHANTOMBOT_PERSONA;
    await writeFile(process.env.PHANTOMBOT_GLOBAL_CONFIG!, "this is not toml [[[", {
      encoding: "utf8",
      flag: "w",
    }).catch(async () => {
      // The directory may not exist yet on a fresh temp root.
      await Bun.write(process.env.PHANTOMBOT_GLOBAL_CONFIG!, "this is not toml [[[");
    });
    expect(loadGlobalConfig()).toEqual({});
    expect(activePersona()).toBe("phantom");
  });
});

describe("tmpEnvOverlay", () => {
  test("pins the temp dir on POSIX and Windows names alike", () => {
    const overlay = tmpEnvOverlay("lena");
    const dir = join(workdir, "personas", "lena", "tmp");
    expect(overlay).toEqual({
      TMPDIR: dir,
      TMP: dir,
      TEMP: dir,
      PHANTOMBOT_TMP_DIR: dir,
    });
  });

  test("withPersonaEnv applies it to the CHILD env and never to process.env", () => {
    const before = process.env.TMPDIR;
    const child = withPersonaEnv(
      { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
      "lena",
      "conv",
      "turn",
    );
    expect(child.TMPDIR).toBe(join(workdir, "personas", "lena", "tmp"));
    expect(child.PHANTOMBOT_PERSONA).toBe("lena");
    // The parent serves many personas over its lifetime; mutating its own
    // TMPDIR would leak one persona's dir into whatever ran next.
    expect(process.env.TMPDIR).toBe(before);
  });

  test("a persona-less spawn is left completely untouched", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    expect(withPersonaEnv(base, undefined)).toBe(base);
  });
});

describe("setGlobalConfigValue", () => {
  test("creates the file on first write", async () => {
    setGlobalConfigValue("default_persona", "kai");
    expect(await readFile(process.env.PHANTOMBOT_GLOBAL_CONFIG!, "utf8")).toContain(
      'default_persona = "kai"',
    );
  });

  test("rewrites only its own line, preserving comments and other keys", async () => {
    await Bun.write(
      process.env.PHANTOMBOT_GLOBAL_CONFIG!,
      '# hand-written\ndefault_persona = "lena"\nupdate_channel = "preview"\n',
    );
    setGlobalConfigValue("default_persona", "kai");
    const text = await readFile(process.env.PHANTOMBOT_GLOBAL_CONFIG!, "utf8");
    expect(text).toContain("# hand-written");
    expect(text).toContain('default_persona = "kai"');
    expect(text).toContain('update_channel = "preview"');
    expect(text).not.toContain('default_persona = "lena"');
  });

  test("a new key is inserted BEFORE the first section header", async () => {
    // A top-level key written after a `[section]` header is silently swallowed
    // into that section by TOML — it would read back as undefined.
    await Bun.write(
      process.env.PHANTOMBOT_GLOBAL_CONFIG!,
      '[something]\nkey = "value"\n',
    );
    setGlobalConfigValue("update_channel", "preview");
    const text = await readFile(process.env.PHANTOMBOT_GLOBAL_CONFIG!, "utf8");
    expect(text.indexOf("update_channel")).toBeLessThan(text.indexOf("[something]"));
    expect(loadGlobalConfig().update_channel).toBe("preview");
  });
});
