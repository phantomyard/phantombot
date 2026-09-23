/**
 * The engine scope must be INVISIBLE outside an engine call: the daemon and
 * the CLI never enter one, so every helper it touches has to behave exactly as
 * before. Inside a scope it must win over the host's XDG and location env.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { xdgConfigHome, xdgDataHome, xdgStateHome } from "../src/config.ts";
import { withPersonaEnv } from "../src/lib/envBootstrap.ts";
import {
  bindToScope,
  currentEngineScope,
  HOST_LOCATION_ENV,
  hostLocationEnv,
  runInEngineScope,
  scopedChildEnv,
} from "../src/lib/engineScope.ts";
import { writeLogLine } from "../src/lib/logSink.ts";
import { statePath } from "../src/state.ts";

const scope = {
  configHome: "/engine/config",
  dataHome: "/engine/data",
  stateHome: "/engine/state",
};

const saved: Record<string, string | undefined> = {};
function setEnv(name: string, value: string): void {
  if (!(name in saved)) saved[name] = process.env[name];
  process.env[name] = value;
}
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete saved[k];
  }
});

describe("outside a scope (daemon / CLI)", () => {
  test("XDG helpers read the environment exactly as before", () => {
    setEnv("XDG_CONFIG_HOME", "/host/config");
    setEnv("XDG_DATA_HOME", "/host/data");
    setEnv("XDG_STATE_HOME", "/host/state");
    expect(currentEngineScope()).toBeUndefined();
    expect(xdgConfigHome()).toBe("/host/config");
    expect(xdgDataHome()).toBe("/host/data");
    expect(xdgStateHome()).toBe("/host/state");
  });

  test("location overrides are honoured", () => {
    setEnv("PHANTOMBOT_STATE", "/host/state.json");
    expect(hostLocationEnv("PHANTOMBOT_STATE")).toBe("/host/state.json");
    expect(statePath()).toBe("/host/state.json");
  });

  test("child env is byte-identical to the pre-engine shape", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/bin", PHANTOMBOT_CONFIG: "/host/config.toml" };
    expect(withPersonaEnv(base, "ana", "c", "t")).toEqual({
      CI: "true",
      DEBIAN_FRONTEND: "noninteractive",
      GIT_TERMINAL_PROMPT: "0",
      PATH: "/bin",
      PHANTOMBOT_CONFIG: "/host/config.toml",
      PHANTOMBOT_PERSONA: "ana",
      PHANTOMBOT_CONVERSATION: "c",
      PHANTOMBOT_TURN_ID: "t",
    });
    expect(scopedChildEnv()).toEqual({});
  });
});

describe("inside a scope (embedded engine)", () => {
  test("XDG helpers resolve the scope, ignoring the host env", () => {
    setEnv("XDG_DATA_HOME", "/host/data");
    runInEngineScope(scope, () => {
      expect(xdgConfigHome()).toBe("/engine/config");
      expect(xdgDataHome()).toBe("/engine/data");
      expect(xdgStateHome()).toBe("/engine/state");
    });
  });

  test("every host location override is ignored", () => {
    for (const name of HOST_LOCATION_ENV) setEnv(name, `/host/${name}`);
    runInEngineScope(scope, () => {
      for (const name of HOST_LOCATION_ENV) expect(hostLocationEnv(name)).toBeUndefined();
      expect(statePath()).toBe("/engine/data/phantombot/state.json");
    });
  });

  test("child env points at the scope and drops host location overrides", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/bin", PHANTOMBOT_CONFIG: "/host/config.toml", XDG_DATA_HOME: "/host/data" };
    const env = runInEngineScope(scope, () => withPersonaEnv(base, "ana"));
    expect(env.XDG_CONFIG_HOME).toBe("/engine/config");
    expect(env.XDG_DATA_HOME).toBe("/engine/data");
    expect(env.XDG_STATE_HOME).toBe("/engine/state");
    expect(env.PHANTOMBOT_CONFIG).toBeUndefined();
    expect(env.PHANTOMBOT_PERSONA).toBe("ana");
  });

  test("log lines go to the scope's sink", () => {
    const lines: string[] = [];
    runInEngineScope({ ...scope, logSink: (l) => lines.push(l) }, () => writeLogLine("x\n"));
    expect(lines).toEqual(["x\n"]);
  });

  test("scopes do not bleed across concurrent async work", async () => {
    const other = { ...scope, dataHome: "/other/data" };
    const [a, b] = await Promise.all([
      runInEngineScope(scope, async () => {
        await new Promise((r) => setTimeout(r, 10));
        return xdgDataHome();
      }),
      runInEngineScope(other, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return xdgDataHome();
      }),
    ]);
    expect(a).toBe("/engine/data");
    expect(b).toBe("/other/data");
  });
});

describe("bindToScope", () => {
  test("a generator resumed from outside still runs inside the scope", async () => {
    async function* gen() {
      yield xdgDataHome();
      await new Promise((r) => setTimeout(r, 1));
      yield xdgDataHome();
    }
    setEnv("XDG_DATA_HOME", "/host/data");
    // Unbound: the body sees the caller's (empty) context.
    const unbound: string[] = [];
    for await (const v of gen()) unbound.push(v);
    expect(unbound).toEqual(["/host/data", "/host/data"]);

    const bound: string[] = [];
    for await (const v of bindToScope(scope, gen())) bound.push(v);
    expect(bound).toEqual(["/engine/data", "/engine/data"]);
  });

  test("return() reaches the inner generator's finally inside the scope", async () => {
    let finallySaw: string | undefined;
    async function* gen() {
      try {
        yield 1;
        yield 2;
      } finally {
        finallySaw = xdgDataHome();
      }
    }
    for await (const _ of bindToScope(scope, gen())) break;
    expect(finallySaw).toBe("/engine/data");
  });
});
