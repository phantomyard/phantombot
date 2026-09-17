/**
 * The bare-invocation gate (issue #471).
 *
 * These tests exist because getting this backwards is silent and expensive:
 * an argv-based gate makes CI's `phantombot` smoke test write to disk, and
 * makes `phantombot | head` hang forever on a renderer nobody is watching.
 */

import { describe, expect, test } from "bun:test";

import {
  bareInvocationMode,
  currentTty,
  shouldOpenTui,
  launchRefusal,
  launchVaultPersona,
  parseLaunchFlags,
  unknownLaunchPersona,
  NO_TUI_FLAG,
} from "../src/lib/tuiGate.ts";
import { isReadOnlyInvocation } from "../src/lib/cliInvocation.ts";

const argv = (...args: string[]) => ["/usr/bin/bun", "phantombot", ...args];
const tty = (stdin: boolean, stdout: boolean) => ({ stdin, stdout });

describe("bareInvocationMode", () => {
  test("bare on a TTY opens the TUI", () => {
    expect(bareInvocationMode(argv(), tty(true, true))).toBe("tui");
    expect(shouldOpenTui(argv(), tty(true, true))).toBe(true);
  });

  test("bare with stdout redirected prints usage, never the TUI", () => {
    expect(bareInvocationMode(argv(), tty(true, false))).toBe("usage");
  });

  test("bare with stdin piped prints usage, never the TUI", () => {
    // `echo hi | phantombot` must not open a full-screen app.
    expect(bareInvocationMode(argv(), tty(false, true))).toBe("usage");
  });

  test("bare with neither (CI, cron) prints usage", () => {
    expect(bareInvocationMode(argv(), tty(false, false))).toBe("usage");
    expect(shouldOpenTui(argv(), tty(false, false))).toBe(false);
  });

  test("--no-tui gives the line-mode REPL when there is a keyboard", () => {
    expect(bareInvocationMode(argv(NO_TUI_FLAG), tty(true, true))).toBe("repl");
    expect(bareInvocationMode(argv(NO_TUI_FLAG), tty(true, false))).toBe("repl");
  });

  test("--no-tui with no keyboard falls back to usage", () => {
    expect(bareInvocationMode(argv(NO_TUI_FLAG), tty(false, true))).toBe(
      "usage",
    );
  });

  test("every other invocation is Citty's business, TTY or not", () => {
    for (const args of [
      ["--help"],
      ["--version"],
      ["help"],
      ["_complete", "--", "do"],
      ["doctor"],
      ["persona", "new", "x"],
      // --no-tui is only meaningful bare; it must not change a subcommand.
      ["doctor", NO_TUI_FLAG],
    ]) {
      expect(bareInvocationMode(argv(...args), tty(true, true))).toBe("usage");
    }
  });
});

describe("the gate does not change isReadOnlyInvocation", () => {
  test("bare is still read-only by that predicate", () => {
    // The TUI is a SECOND question asked after this one, not a redefinition of
    // it: CI's smoke test and every <TAB> still take the read-only path.
    expect(isReadOnlyInvocation(argv())).toBe(true);
    expect(isReadOnlyInvocation(argv("--help"))).toBe(true);
    expect(isReadOnlyInvocation(argv("_complete"))).toBe(true);
  });

  test("--no-tui is not read-only — the REPL needs the vault", () => {
    expect(isReadOnlyInvocation(argv(NO_TUI_FLAG))).toBe(false);
  });
});

describe("currentTty", () => {
  test("reads isTTY off a process-like object, defaulting to false", () => {
    expect(currentTty({ stdin: {}, stdout: {} })).toEqual({
      stdin: false,
      stdout: false,
    });
    expect(
      currentTty({ stdin: { isTTY: true }, stdout: { isTTY: true } }),
    ).toEqual({ stdin: true, stdout: true });
  });
});

/**
 * Launch flags (issue #575).
 *
 * `--prompt` seeds a TRUSTED turn, and the only thing that makes it trusted is
 * that a human is sitting in front of the terminal watching it run. So the
 * parser's job is not just "read a string": it must refuse every invocation
 * where nobody is watching, and refuse LOUDLY rather than quietly degrading to
 * the judge-screened `ask` path — a silent reroute would turn a refused
 * unattended prompt into an accepted one.
 */
describe("launch flags", () => {
  test("--prompt and --persona open the TUI when a human is watching", () => {
    expect(parseLaunchFlags(argv("--prompt", "ship it"))).toEqual({
      prompt: "ship it",
    });
    expect(parseLaunchFlags(argv("--prompt=ship it"))).toEqual({
      prompt: "ship it",
    });
    expect(parseLaunchFlags(argv("--persona", "kai", "--prompt", "hi"))).toEqual(
      { persona: "kai", prompt: "hi" },
    );
    expect(bareInvocationMode(argv("--prompt", "hi"), tty(true, true))).toBe(
      "tui",
    );
    expect(bareInvocationMode(argv("--persona", "kai"), tty(true, true))).toBe(
      "tui",
    );
  });

  test("a prompt with no terminal is REFUSED, never quietly rerouted", () => {
    // `phantombot --prompt … | cat`, cron, CI, a launcher with no TTY.
    for (const t of [tty(false, true), tty(true, false), tty(false, false)]) {
      expect(bareInvocationMode(argv("--prompt", "hi"), t)).toBe("refuse");
    }
    expect(launchRefusal(argv("--prompt", "hi"))).toContain("phantombot ask");
  });

  test("--no-tui cannot be combined with a prompt: headless must go via ask", () => {
    expect(
      bareInvocationMode(argv(NO_TUI_FLAG, "--prompt", "hi"), tty(true, true)),
    ).toBe("refuse");
    expect(launchRefusal(argv(NO_TUI_FLAG, "--prompt", "hi"))).toContain(
      "phantombot ask",
    );
  });

  test("a missing or empty value is an error, not an empty prompt", () => {
    for (const args of [["--prompt"], ["--prompt", "   "], ["--prompt="]]) {
      const parsed = parseLaunchFlags(argv(...args));
      expect(parsed && "error" in parsed).toBe(true);
      expect(bareInvocationMode(argv(...args), tty(true, true))).toBe("refuse");
    }
  });

  test("a repeated flag is an error, not last-wins", () => {
    // A launcher that builds argv badly must fail loudly rather than run a
    // different prompt than the one it believes it sent.
    const parsed = parseLaunchFlags(argv("--prompt", "a", "--prompt", "b"));
    expect(parsed && "error" in parsed).toBe(true);
  });

  test("--persona is held to the persona-directory naming rule", () => {
    // The value picks a directory under personas/ and the vault decrypted at
    // startup, so a traversal must never reach the filesystem.
    const parsed = parseLaunchFlags(argv("--persona", "../../etc"));
    expect(parsed && "error" in parsed).toBe(true);
    expect(bareInvocationMode(argv("--persona", "../../etc"), tty(true, true))).toBe(
      "refuse",
    );
  });

  test("launch flags never change a subcommand or an unknown flag", () => {
    // The hard non-goal of #471, restated: these are BARE-invocation flags.
    for (const args of [
      ["ask", "--prompt", "hi"],
      ["doctor", "--persona", "kai"],
      ["--promptx", "hi"],
      ["--help"],
    ]) {
      expect(parseLaunchFlags(argv(...args))).toBeNull();
      expect(bareInvocationMode(argv(...args), tty(true, true))).toBe("usage");
    }
  });

  test("a launch invocation is not read-only — it opens a vault-backed chat", () => {
    expect(isReadOnlyInvocation(argv("--prompt", "hi"))).toBe(false);
  });
});

describe("which persona a launch opens", () => {
  test("--persona wins over the injected env var and the configured default", () => {
    // The TUI is about to open a VAULT-BACKED conversation with this persona:
    // bootstrapping someone else's secrets leaves the chat with an empty env
    // and no visible cause.
    expect(
      launchVaultPersona({ persona: "kai" }, { PHANTOMBOT_PERSONA: "lena" }, "robbie"),
    ).toBe("kai");
    expect(launchVaultPersona({}, { PHANTOMBOT_PERSONA: "lena" }, "robbie")).toBe(
      "lena",
    );
    expect(launchVaultPersona({}, {}, "robbie")).toBe("robbie");
  });

  test("an unknown --persona is a bad argument, not a reason to open the wizard", () => {
    const personas = [{ name: "lena" }, { name: "kai" }];
    expect(unknownLaunchPersona({ persona: "kai" }, personas)).toBeUndefined();
    expect(unknownLaunchPersona({}, personas)).toBeUndefined();
    const err = unknownLaunchPersona({ persona: "kia" }, personas);
    expect(err).toContain("kia");
    expect(err).toContain("lena, kai");
    expect(unknownLaunchPersona({ persona: "kia" }, [])).toContain("none yet");
  });
});
