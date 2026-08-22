/**
 * #436: every command that can be pointed at a persona must READ that
 * persona's config.
 *
 * The persona directory and its `config.toml` are one unit. A command that
 * resolves `personaDir(config, input.persona)` while loading the config with a
 * bare `loadConfig()` mixes two personas: it writes into B's directory using
 * A's channels, harness chain, allowlists and voice settings. On a multi-persona
 * box that is a cross-persona data leak, not a cosmetic bug — `notify --persona
 * b` would reach persona A's Telegram chat.
 *
 * This is enforced structurally rather than per-command because the failure is
 * one omitted argument in a call that still typechecks, compiles and passes
 * every existing test — exactly the kind of regression a reviewer's eye slides
 * over on the next PR that adds a command.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.ts";

/** Commands that take an explicit persona and therefore must pass it on. */
const PERSONA_AWARE_MODULES = [
  "src/cli/ask.ts",
  "src/cli/doctor.ts",
  "src/cli/harness.ts",
  "src/cli/heartbeat.ts",
  "src/cli/mcp.ts",
  "src/cli/memory.ts",
  "src/cli/nightly.ts",
  "src/cli/notify.ts",
  "src/cli/phantomchat.ts",
  "src/cli/telegram.ts",
  "src/cli/vault.ts",
  "src/connectors/acp/server.ts",
];

describe("persona-aware commands load the persona's own config (#436)", () => {
  for (const rel of PERSONA_AWARE_MODULES) {
    test(`${rel} never calls loadConfig() with no persona`, () => {
      const src = readFileSync(join(import.meta.dir, "..", rel), "utf8");
      // `loadConfig()` — literally no argument — is the defect. Any call that
      // passes something (a persona, an explicit override) is fine.
      expect(src).not.toMatch(/\bloadConfig\(\s*\)/);
    });
  }

  test("loadConfig reads the named persona's file, not the default's", async () => {
    const root = mkdtempSync(join(tmpdir(), "phantombot-personacfg-"));
    const saved = {
      dir: process.env.PHANTOMBOT_PERSONAS_DIR,
      persona: process.env.PHANTOMBOT_PERSONA,
      cfg: process.env.PHANTOMBOT_CONFIG,
      global: process.env.PHANTOMBOT_GLOBAL_CONFIG,
    };
    try {
      delete process.env.PHANTOMBOT_PERSONA;
      delete process.env.PHANTOMBOT_CONFIG;
      process.env.PHANTOMBOT_PERSONAS_DIR = root;
      process.env.PHANTOMBOT_GLOBAL_CONFIG = join(root, "config.toml");
      writeFileSync(join(root, "config.toml"), 'default_persona = "lena"\n', "utf8");
      for (const [persona, chain] of [
        ["lena", '["pi"]'],
        ["kai", '["codex", "pi"]'],
      ] as const) {
        mkdirSync(join(root, persona), { recursive: true });
        writeFileSync(
          join(root, persona, "config.toml"),
          `[harnesses]\nchain = ${chain}\n`,
          "utf8",
        );
      }

      expect((await loadConfig("kai")).harnesses.chain).toEqual(["codex", "pi"]);
      expect((await loadConfig("lena")).harnesses.chain).toEqual(["pi"]);
      // No argument → the global default persona, as before.
      expect((await loadConfig()).harnesses.chain).toEqual(["pi"]);
    } finally {
      for (const [k, v] of [
        ["PHANTOMBOT_PERSONAS_DIR", saved.dir],
        ["PHANTOMBOT_PERSONA", saved.persona],
        ["PHANTOMBOT_CONFIG", saved.cfg],
        ["PHANTOMBOT_GLOBAL_CONFIG", saved.global],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
