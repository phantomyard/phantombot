/**
 * Slash commands on the chat screen (phantombot#480).
 *
 * Two failure modes are being pinned here, and they pull against each other:
 *
 *   - a typed `/status` must NOT reach the model, which answers it with a
 *     plausible invention rather than the truth; and
 *   - a typed `/usr/bin/env` or `/etc/hosts` MUST reach the model, because it
 *     is a sentence about the filesystem, not a command.
 *
 * The third is drift: the terminal must not grow its own copy of a command
 * list that Telegram and phantomchat can then diverge from, so the advertised
 * set is derived from the shared one.
 */

import { describe, expect, test } from "bun:test";

import { TELEGRAM_BOT_COMMANDS } from "../src/channels/commands.ts";
import {
  commandHints,
  commandName,
  completeCommand,
  isKnownCommand,
  isUnknownCommand,
  TUI_COMMANDS,
  unknownCommandReply,
} from "../src/tui/slash.ts";

describe("what the terminal advertises", () => {
  test("is the shared set, so a command added once appears on every surface", () => {
    const shared = TELEGRAM_BOT_COMMANDS.map((c) => c.command).filter(
      (c) => c !== "start",
    );
    expect(TUI_COMMANDS.map((c) => c.name)).toEqual(shared);
  });

  test("includes the lifecycle commands — this app runs on the host they act on", () => {
    const names = TUI_COMMANDS.map((c) => c.name);
    expect(names).toContain("update");
    expect(names).toContain("restart");
  });

  test("still answers /start, it just does not advertise it", () => {
    expect(isKnownCommand("/start")).toBe(true);
    expect(TUI_COMMANDS.some((c) => c.name === "start")).toBe(false);
  });
});

describe("telling a command from a path", () => {
  test("a bare command word is a command", () => {
    expect(commandName("/status")).toBe("status");
    expect(commandName("  /Harness pi  ")).toBe("harness");
    expect(isKnownCommand("/harness pi")).toBe(true);
  });

  test("a path is not, and goes to the phantom untouched", () => {
    for (const text of [
      "/usr/bin/env is on PATH?",
      "/etc/hosts",
      "/home/andrew/notes.md needs a look",
      "/^ab+c$/ matches what?",
      "// commented out",
      "/",
    ]) {
      expect(commandName(text)).toBeUndefined();
      expect(isKnownCommand(text)).toBe(false);
      expect(isUnknownCommand(text)).toBe(false);
    }
  });

  test("text that merely mentions a slash is not a command", () => {
    expect(commandName("what does /status do?")).toBeUndefined();
  });

  test("a command-shaped miss is answered here, not by the model", () => {
    expect(isUnknownCommand("/wat")).toBe(true);
    const reply = unknownCommandReply("/wat");
    expect(reply).toContain("/wat");
    // The reply has to name the way out, or a user whose message genuinely
    // starts with a slash has no idea how to send it.
    expect(reply).toContain("/help");
    expect(reply.toLowerCase()).toContain("slash");
  });
});

describe("the type-ahead", () => {
  test("a lone slash offers everything", () => {
    expect(commandHints("/")).toHaveLength(TUI_COMMANDS.length);
  });

  test("narrows as you type", () => {
    expect(commandHints("/st").map((c) => c.name)).toEqual(["stop", "status"]);
    expect(commandHints("/sta").map((c) => c.name)).toEqual(["status"]);
  });

  test("goes away once you start on the arguments", () => {
    // A menu that stays up while you type `/harness pi` is a menu in the way.
    expect(commandHints("/harness ")).toEqual([]);
    expect(commandHints("hello")).toEqual([]);
    expect(commandHints("")).toEqual([]);
  });

  test("tab completes to the longest unambiguous prefix", () => {
    expect(completeCommand("/st")).toBe("/st");
    expect(completeCommand("/sta")).toBe("/status ");
    expect(completeCommand("/h")).toBe("/h");
    expect(completeCommand("/he")).toBe("/help ");
  });

  test("tab on a non-command leaves the input exactly as it was", () => {
    expect(completeCommand("/usr/bin")).toBe("/usr/bin");
    expect(completeCommand("hello there")).toBe("hello there");
    expect(completeCommand("/zzz")).toBe("/zzz");
  });
});
