/**
 * Tests for the dynamic shell tab-completion engine (src/lib/completion.ts)
 * and the `phantombot completion` script emitter (src/cli/completion.ts).
 *
 * The engine walks the LIVE Citty command tree, so these tests drive it against
 * `mainCommand` itself — they assert real subcommands/flags come back, which
 * doubles as a guard that the tree is walkable (Resolvable args/subCommands).
 */

import { describe, expect, test } from "bun:test";

import { mainCommand } from "../src/cli/index.ts";
import {
  COMPLETION_SHELLS,
  completionScript,
  computeCompletions,
  isCompletionShell,
  runComplete,
} from "../src/lib/completion.ts";

const complete = (tokens: string[]) => computeCompletions(mainCommand, tokens);

describe("computeCompletions — subcommand completion", () => {
  test("empty token offers the top-level subcommands", async () => {
    const out = await complete([""]);
    expect(out).toContain("run");
    expect(out).toContain("install");
    expect(out).toContain("p2p");
    // The hidden backend is not a registered subcommand, so never suggested.
    expect(out).not.toContain("_complete");
  });

  test("a prefix filters the subcommand list", async () => {
    const out = await complete(["p"]);
    expect(out).toContain("p2p");
    expect(out).toContain("persona");
    expect(out).toContain("phantomchat");
    expect(out.every((c) => c.startsWith("p"))).toBe(true);
    expect(out).not.toContain("run");
  });

  test("descends into nested subcommands", async () => {
    // `p2p` has a single `status` subcommand.
    const out = await complete(["p2p", ""]);
    expect(out).toEqual(["status"]);
  });

  test("nested subcommand honours a prefix", async () => {
    expect(await complete(["p2p", "s"])).toEqual(["status"]);
    expect(await complete(["p2p", "x"])).toEqual([]);
  });
});

describe("computeCompletions — flag completion", () => {
  test("a leading dash offers the command's flags plus --help", async () => {
    const out = await complete(["logs", "-"]);
    expect(out).toContain("--follow");
    expect(out).toContain("--no-follow"); // boolean args expose a --no- form
    expect(out).toContain("--lines");
    expect(out).toContain("--help");
  });

  test("--no- form is only offered for boolean args", async () => {
    const out = await complete(["logs", "--no-"]);
    expect(out).toContain("--no-follow");
    expect(out).not.toContain("--no-lines"); // string arg
  });

  test("root offers --version, subcommands do not", async () => {
    expect(await complete(["--"])).toContain("--version");
    expect(await complete(["logs", "--"])).not.toContain("--version");
  });

  test("a leaf command with only flags completes flags on empty tab", async () => {
    // `restart` has no subcommands and no args → still offers --help.
    const out = await complete(["restart", ""]);
    expect(out).toEqual(["--help"]);
  });
});

describe("runComplete — argv extraction", () => {
  test("reads the word list after the '--' separator", async () => {
    const out = await runComplete(mainCommand, ["--", "p2p", ""]);
    expect(out).toEqual(["status"]);
  });

  test("half-typed flags after '--' are treated as words, not parsed", async () => {
    const out = await runComplete(mainCommand, ["--", "logs", "--fo"]);
    expect(out).toEqual(["--follow"]);
  });

  test("falls back to the whole argv when no '--' is present", async () => {
    const out = await runComplete(mainCommand, ["p2p", ""]);
    expect(out).toEqual(["status"]);
  });
});

describe("completionScript", () => {
  test("every supported shell is a valid, non-empty script", () => {
    for (const shell of COMPLETION_SHELLS) {
      const script = completionScript(shell);
      expect(script.length).toBeGreaterThan(0);
      expect(script).toContain("phantombot _complete");
    }
  });

  test("bash wires a completion function", () => {
    expect(completionScript("bash")).toContain("complete -F _phantombot_complete phantombot");
  });

  test("zsh registers via compdef", () => {
    expect(completionScript("zsh")).toContain("compdef _phantombot phantombot");
  });

  test("fish disables file completion", () => {
    expect(completionScript("fish")).toContain("complete -c phantombot -f");
  });

  test("isCompletionShell guards the union", () => {
    expect(isCompletionShell("bash")).toBe(true);
    expect(isCompletionShell("powershell")).toBe(false);
  });
});
