import { describe, expect, test, afterEach } from "bun:test";

import { resolvePersona, type Config } from "../src/config.ts";

const config = { defaultPersona: "phantom" } as Config;

const savedEnv = process.env.PHANTOMBOT_PERSONA;

afterEach(() => {
  if (savedEnv === undefined) delete process.env.PHANTOMBOT_PERSONA;
  else process.env.PHANTOMBOT_PERSONA = savedEnv;
});

// phantombot#469: a non-default persona's harness runs every CLI call with
// PHANTOMBOT_PERSONA injected. Persona-scoped commands must resolve through
// this helper — falling back straight to defaultPersona makes them silently
// operate on ANOTHER persona's data.
describe("resolvePersona", () => {
  test("explicit flag wins over env and default", () => {
    process.env.PHANTOMBOT_PERSONA = "from-env";
    expect(resolvePersona("explicit", config)).toBe("explicit");
  });

  test("env var wins over default when no flag is given", () => {
    process.env.PHANTOMBOT_PERSONA = "from-env";
    expect(resolvePersona(undefined, config)).toBe("from-env");
  });

  test("falls back to the default persona with no flag and no env", () => {
    delete process.env.PHANTOMBOT_PERSONA;
    expect(resolvePersona(undefined, config)).toBe("phantom");
  });

  test("empty-string env var does not shadow the default", () => {
    process.env.PHANTOMBOT_PERSONA = "";
    expect(resolvePersona(undefined, config)).toBe("phantom");
  });
});
