/**
 * Regression tests for how `phantombot persona` DISPATCHES, as opposed to what
 * its flows do once dispatched.
 *
 * Why this file exists separately from cli-persona.test.ts: that suite calls
 * `runPersona` / `runSwitchPersona` directly, so it never runs citty's command
 * dispatch — and the bug it missed lived entirely there. Registering `new`
 * under citty's `subCommands` made citty treat the FIRST POSITIONAL of
 * `persona <name>` as a subcommand name and throw `Unknown command <name>`,
 * killing the documented default-persona switch on every host that took
 * v1.1.316. It also ran the parent `run` after the matched subcommand, so a
 * successful `persona new <name>` set exitCode 1 from the switch path
 * rejecting the literal token "new" as a missing persona.
 *
 * Both are only visible through `runCommand`, so that is what these drive.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runCommand } from "citty";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import personaCmd from "../src/cli/persona.ts";

describe("persona command dispatch", () => {
  let dir = "";
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "phantombot-persona-dispatch-"));
    for (const k of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"]) {
      saved[k] = process.env[k];
      process.env[k] = dir;
    }
    process.exitCode = undefined;
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    process.exitCode = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  test("`persona <name>` reaches the switch path instead of citty's subcommand lookup", async () => {
    // The whole point: a positional that is NOT a subcommand must not be
    // rejected by the dispatcher. It reaches runSwitchPersona, which reports
    // the missing persona itself — that is the correct, pre-#477 behaviour.
    await runCommand(personaCmd, { rawArgs: ["definitely-not-a-persona"] });
    expect(process.exitCode).toBe(1); // "not found", not "Unknown command"
  });

  test("`persona new <name>` creates the persona and leaves a success exit code", async () => {
    await runCommand(personaCmd, {
      rawArgs: ["new", "dispatchlab", "--harness", "claude"],
    });
    expect(existsSync(join(dir, "phantombot/personas/dispatchlab"))).toBe(true);
    // The parent `run` must not have also treated "new" as a persona to
    // switch to; that is what turned a successful create into exit 1.
    expect(process.exitCode ?? 0).toBe(0);
  });
});
