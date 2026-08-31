import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPhantomFromWizard } from "../src/tui/index.tsx";

const saved = {
  config: process.env.PHANTOMBOT_CONFIG,
  state: process.env.PHANTOMBOT_STATE,
  personas: process.env.PHANTOMBOT_PERSONAS_DIR,
};
let root: string | undefined;

afterEach(() => {
  if (saved.config === undefined) delete process.env.PHANTOMBOT_CONFIG;
  else process.env.PHANTOMBOT_CONFIG = saved.config;
  if (saved.state === undefined) delete process.env.PHANTOMBOT_STATE;
  else process.env.PHANTOMBOT_STATE = saved.state;
  if (saved.personas === undefined) delete process.env.PHANTOMBOT_PERSONAS_DIR;
  else process.env.PHANTOMBOT_PERSONAS_DIR = saved.personas;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("TUI persona creation", () => {
  test("a resumed persona is autostarted when the host already autostarts", async () => {
    root = mkdtempSync(join(tmpdir(), "phantombot-tui-create-"));
    const configPath = join(root, "config.toml");
    const personasDir = join(root, "personas");
    process.env.PHANTOMBOT_CONFIG = configPath;
    process.env.PHANTOMBOT_STATE = join(root, "state.json");
    process.env.PHANTOMBOT_PERSONAS_DIR = personasDir;
    writeFileSync(configPath, 'default_persona = "kai"\nautostart_personas = ["lena"]\n');
    mkdirSync(join(personasDir, "kai"), { recursive: true });

    let synced: string[] | undefined;
    const result = await createPhantomFromWizard(
      {
        name: "kai",
        identity: "a test phantom",
        tone: "blunt",
        brain: "codex",
        channel: "cli",
        memory: "none",
        voice: "none",
        makeDefault: false,
      },
      async (personas) => void (synced = [...personas]),
    );

    expect(result).toEqual({ created: false });
    // Joining an EXISTING autostart fleet is the detected case: the persona
    // is appended to the list that is already in use.
    expect(readFileSync(configPath, "utf8")).toMatch(
      /autostart_personas = \[\s*"lena",\s*"kai"\s*\]/,
    );
    // servedPersonasOf: the default first, then the rest of the fleet.
    expect(synced).toEqual(["kai", "lena"]);
    expect(
      readFileSync(join(personasDir, "kai", "config.toml"), "utf8"),
    ).toMatch(/chain = \[\s*"codex"/);
  });

  test("with no autostart detected, a new persona is NOT autostarted", async () => {
    root = mkdtempSync(join(tmpdir(), "phantombot-tui-create-"));
    const configPath = join(root, "config.toml");
    const personasDir = join(root, "personas");
    process.env.PHANTOMBOT_CONFIG = configPath;
    process.env.PHANTOMBOT_STATE = join(root, "state.json");
    process.env.PHANTOMBOT_PERSONAS_DIR = personasDir;
    // No `autostart_personas` at all — the "phantoms run when I open them"
    // mode. A new persona must not be silently conscripted into the fleet.
    writeFileSync(configPath, 'default_persona = "kai"\n');
    mkdirSync(join(personasDir, "kai"), { recursive: true });

    let synced: string[] | undefined;
    const result = await createPhantomFromWizard(
      {
        name: "kai",
        identity: "a test phantom",
        tone: "blunt",
        makeDefault: false,
      },
      async (personas) => void (synced = [...personas]),
    );

    expect(result).toEqual({ created: false });
    expect(readFileSync(configPath, "utf8")).not.toMatch(/autostart_personas/);
    // Heartbeat sync still reconciles what IS served — kai is the default,
    // so it is served; what changed is it did NOT join an autostart fleet.
    expect(synced).toEqual(["kai"]);
  });
});
