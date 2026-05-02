/**
 * Citty dispatcher. The phantombot command surface is intentionally small:
 *
 *   import-persona  - copy an OpenClaw agent dir + telegram config in
 *   create-persona  - TUI to make a new persona from scratch
 *   telegram        - TUI to configure the Telegram channel
 *   harness         - TUI to choose primary + fallback harnesses
 *   install         - install systemd --user unit so phantombot survives logout
 *   uninstall       - remove the systemd unit
 *   run             - run the bot in the foreground (Ctrl-C to stop)
 *
 * Dev/debug commands (ask, chat, doctor, history, list-personas, etc.)
 * have been removed as part of the v0.1 surface lock.
 */

import { defineCommand } from "citty";
import { VERSION } from "../version.ts";
import personaCmd from "./persona.ts";
import telegramCmd from "./telegram.ts";
import harnessCmd from "./harness.ts";
import installCmd from "./install.ts";
import uninstallCmd from "./uninstall.ts";
import runCmd from "./run.ts";
import memoryCmd from "./memory.ts";
import embeddingCmd from "./embedding.ts";
import heartbeatCmd from "./heartbeat.ts";
import nightlyCmd from "./nightly.ts";
import envCmd from "./env.ts";
import notifyCmd from "./notify.ts";
import taskCmd from "./task.ts";
import tickCmd from "./tick.ts";
import updateCmd from "./update.ts";
import voiceCmd from "./voice.ts";

export const mainCommand = defineCommand({
  meta: {
    name: "phantombot",
    version: VERSION,
    description:
      "Personality-first chat agent CLI. Wraps Claude Code and Pi CLIs with persona, memory, and a Telegram bot front-end.",
  },
  subCommands: {
    persona: personaCmd,
    telegram: telegramCmd,
    harness: harnessCmd,
    embedding: embeddingCmd,
    env: envCmd,
    install: installCmd,
    uninstall: uninstallCmd,
    run: runCmd,
    memory: memoryCmd,
    notify: notifyCmd,
    heartbeat: heartbeatCmd,
    nightly: nightlyCmd,
    task: taskCmd,
    tick: tickCmd,
    update: updateCmd,
    voice: voiceCmd,
  },
});
