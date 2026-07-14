/**
 * ACP slash-command parse + allowlist.
 *
 * Two failure modes to pin, and they pull in opposite directions:
 *
 *   UNDER-capture — the reported bug. `/stop` wasn't recognized on this surface
 *   at all, so it went to the model as prompt text and the runaway turn kept
 *   running.
 *
 *   OVER-capture — the bug the fix could easily introduce. A prompt that merely
 *   BEGINS with a slash (a path, a regex, a persona's own `/remember`) must
 *   still reach the model. Swallowing those would be a new, quieter breakage.
 */

import { describe, expect, test } from "bun:test";

import {
  ACP_AVAILABLE_COMMANDS,
  acpCommandName,
  isAcpCommand,
} from "../src/connectors/acp/commands.ts";

describe("acpCommandName — owned commands", () => {
  test("recognizes the control commands", () => {
    expect(acpCommandName("/stop")).toBe("/stop");
    expect(acpCommandName("/reset")).toBe("/reset");
    expect(acpCommandName("/status")).toBe("/status");
    expect(acpCommandName("/help")).toBe("/help");
    expect(acpCommandName("/harness codex")).toBe("/harness");
  });

  test("tolerates whitespace, case and an @bot suffix", () => {
    expect(acpCommandName("  /STOP  ")).toBe("/stop");
    expect(acpCommandName("/Reset")).toBe("/reset");
    expect(acpCommandName("/stop@phantom")).toBe("/stop");
  });

  test("/start is accepted as a /help alias but not advertised", () => {
    expect(acpCommandName("/start")).toBe("/start");
    expect(ACP_AVAILABLE_COMMANDS.map((c) => c.name)).not.toContain("start");
  });
});

describe("acpCommandName — falls through to the model", () => {
  test("plain prose is not a command", () => {
    expect(acpCommandName("hello")).toBeUndefined();
    expect(acpCommandName("stop the build")).toBeUndefined();
  });

  test("text that merely starts with a slash is NOT swallowed", () => {
    // The over-capture guard. Each of these must reach the model.
    expect(acpCommandName("/usr/bin/env — is that on PATH?")).toBeUndefined();
    expect(acpCommandName("/^foo.*bar$/ matches what?")).toBeUndefined();
    expect(acpCommandName("/home/dev/project/src/index.ts is broken")).toBeUndefined();
    expect(isAcpCommand("/remember I prefer tabs")).toBe(false);
  });

  test("a command NAME inside a sentence is not a command", () => {
    expect(acpCommandName("why doesn't /stop work in Zed?")).toBeUndefined();
  });

  test("Telegram-only commands are NOT inherited by this surface", () => {
    // /update swaps the binary and /restart bounces the service — but this
    // process's lifecycle belongs to the EDITOR, so neither is a coherent
    // action here. They must fall through rather than half-execute.
    expect(acpCommandName("/update")).toBeUndefined();
    expect(acpCommandName("/restart")).toBeUndefined();
    expect(acpCommandName("/coder")).toBeUndefined();
  });
});

describe("ACP_AVAILABLE_COMMANDS — the advertised menu", () => {
  test("offers the control commands the user actually needs", () => {
    const names = ACP_AVAILABLE_COMMANDS.map((c) => c.name);
    expect(names).toEqual(["stop", "reset", "status", "harness", "help"]);
  });

  test("every advertised command is one we actually handle", () => {
    // Guards the drift where a command is offered in the editor's menu but
    // falls through to the model, which then talks about doing it instead.
    for (const c of ACP_AVAILABLE_COMMANDS) {
      expect(isAcpCommand(`/${c.name}`)).toBe(true);
      expect(c.description.length).toBeGreaterThan(0);
    }
  });
});
