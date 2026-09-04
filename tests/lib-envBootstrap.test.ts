/**
 * Tests for withPersonaEnv — the only thing envBootstrap still does.
 *
 * The preloadEnvFiles/reloadEnvFiles suites that used to live here are GONE
 * with the functions themselves (#452): phantombot no longer sources a
 * plaintext .env at startup or before a harness spawn. Credentials reach a
 * turn only through the encrypted persona vault, and the guard that no new
 * runtime .env read path appears lives in tests/lib-envFile.test.ts.
 */

import { describe, expect, test } from "bun:test";

import { withPersonaEnv } from "../src/lib/envBootstrap.ts";

describe("withPersonaEnv", () => {
  test("sets PHANTOMBOT_PERSONA and PHANTOMBOT_CONVERSATION to the turn context and non-interactive env", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const out = withPersonaEnv(base, "burt", "telegram:42");
    expect(out.PHANTOMBOT_PERSONA).toBe("burt");
    expect(out.PHANTOMBOT_CONVERSATION).toBe("telegram:42");
    expect(out.CI).toBe("true");
    expect(out.DEBIAN_FRONTEND).toBe("noninteractive");
    expect(out.GIT_TERMINAL_PROMPT).toBe("0");
    expect(out.PATH).toBe("/usr/bin");
  });

  test("does not mutate the input env (copy-on-write)", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const out = withPersonaEnv(base, "robbie");
    expect(out).not.toBe(base);
    expect(base.PHANTOMBOT_PERSONA).toBeUndefined();
    expect(base.PHANTOMBOT_CONVERSATION).toBeUndefined();
    expect(base.CI).toBeUndefined();
  });

  test("sets only conversation when persona is undefined and includes non-interactive env", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const out = withPersonaEnv(base, undefined, "telegram:42");
    expect(out).not.toBe(base);
    expect(out.PHANTOMBOT_PERSONA).toBeUndefined();
    expect(out.PHANTOMBOT_CONVERSATION).toBe("telegram:42");
    expect(out.CI).toBe("true");
    expect(out.DEBIAN_FRONTEND).toBe("noninteractive");
    expect(out.GIT_TERMINAL_PROMPT).toBe("0");
  });

  test("allows base environment to override non-interactive defaults", () => {
    const base: NodeJS.ProcessEnv = {
      CI: "false",
      DEBIAN_FRONTEND: "dialog",
      GIT_TERMINAL_PROMPT: "1",
      PATH: "/usr/bin",
    };
    const out = withPersonaEnv(base, "burt");
    expect(out.CI).toBe("false");
    expect(out.DEBIAN_FRONTEND).toBe("dialog");
    expect(out.GIT_TERMINAL_PROMPT).toBe("1");
    expect(out.PHANTOMBOT_PERSONA).toBe("burt");
  });
});
