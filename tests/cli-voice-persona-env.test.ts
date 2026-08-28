/**
 * Env-fallback regression for `phantombot voice` (PR #474 review): the
 * wizard must resolve the persona BEFORE loading config, so a harness
 * running with PHANTOMBOT_PERSONA=leo reads LEO's voice layer — not the
 * default persona's. Both layers state DIFFERENT providers here, so the
 * wizard's initial selection is observable: it must pick the target
 * persona's provider, never the default persona's.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVoice } from "../src/cli/voice.ts";

// The whole wizard is interactive; the only thing this suite needs to see
// is the select() call's initialValue (driven by `existing.provider`).
const captured: { initialValue?: string; message?: string } = {};
mock.module("@clack/prompts", () => ({
  intro: () => {},
  outro: () => {},
  note: () => {},
  cancel: () => {},
  select: async (opts: { message: string; initialValue?: string }) => {
    captured.message = opts.message;
    captured.initialValue = opts.initialValue as string | undefined;
    return "elevenlabs";
  },
  isCancel: () => true, // bail right after select — nothing written
  spinner: () => ({ start: () => {}, stop: () => {} }),
  password: async () => undefined,
  text: async () => undefined,
}));

let workdir: string;
let personasDir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-voice-env-"));
  personasDir = join(workdir, "personas");
  // Two personas, DIFFERENT voice providers: the default one (phantom) on
  // elevenlabs, the target one (leo) on openai.
  await mkdir(join(personasDir, "phantom"), { recursive: true });
  await mkdir(join(personasDir, "leo"), { recursive: true });
  await writeFile(
    join(personasDir, "phantom", "config.toml"),
    `[voice]\nprovider = "elevenlabs"\n`,
    "utf8",
  );
  await writeFile(
    join(personasDir, "leo", "config.toml"),
    `[voice]\nprovider = "openai"\n`,
    "utf8",
  );
  await writeFile(join(workdir, "config.toml"), "", "utf8");
  process.env.PHANTOMBOT_CONFIG = join(workdir, "config.toml");
  process.env.PHANTOMBOT_PERSONAS_DIR = personasDir;
  process.env.PHANTOMBOT_STATE = join(workdir, "state.json");
});

afterEach(async () => {
  delete process.env.PHANTOMBOT_CONFIG;
  delete process.env.PHANTOMBOT_PERSONAS_DIR;
  delete process.env.PHANTOMBOT_STATE;
  delete process.env.PHANTOMBOT_PERSONA;
  await rm(workdir, { recursive: true, force: true });
});

describe("runVoice — PHANTOMBOT_PERSONA env fallback", () => {
  test("env persona's layer drives the wizard (leo → openai, not phantom's elevenlabs)", async () => {
    process.env.PHANTOMBOT_PERSONA = "leo";
    const errors: string[] = [];

    const code = await runVoice({
      err: { write: (t: string) => (errors.push(String(t)), true) },
    });

    expect(code).toBe(0); // isCancel bails cleanly, nothing written
    expect(errors.join("")).not.toContain("no persona");
    expect(captured.initialValue).toBe("openai");
  });

  test("without env, the default persona's layer is used (elevenlabs)", async () => {
    const errors: string[] = [];

    const code = await runVoice({
      err: { write: (t: string) => (errors.push(String(t)), true) },
    });

    expect(code).toBe(0);
    expect(errors.join("")).not.toContain("no persona");
    expect(captured.initialValue).toBe("elevenlabs");
  });

  test("explicit --persona still wins over the env var", async () => {
    process.env.PHANTOMBOT_PERSONA = "leo";
    const errors: string[] = [];

    const code = await runVoice({
      persona: "phantom",
      err: { write: (t: string) => (errors.push(String(t)), true) },
    });

    expect(code).toBe(0);
    expect(captured.message).toBeDefined();
    expect(captured.initialValue).toBe("elevenlabs");
  });

  test("env persona that does not exist is refused before writing", async () => {
    process.env.PHANTOMBOT_PERSONA = "nobody";
    const errors: string[] = [];

    const code = await runVoice({
      err: { write: (t: string) => (errors.push(String(t)), true) },
    });

    expect(code).toBe(2);
    expect(errors.join("")).toContain("no persona 'nobody'");
  });
});
