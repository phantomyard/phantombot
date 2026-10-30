/**
 * The Settings-entry model-catalog refresh (lib/embeddedPi.ts `syncPiModels`).
 *
 * Three guards here are invisible in a green run and were review findings on PR
 * #715:
 *
 *   - SCOPE: pi keeps the catalog in its AGENT DIR and phantombot keeps one per
 *     persona, so an unscoped spawn refreshes whatever persona the ambient env
 *     names — never the one whose settings are open.
 *   - CRASH PATH: spawn reports ENOENT asynchronously via `error`, and an
 *     unhandled `error` event on an EventEmitter is an uncaughtException, so
 *     opening Settings could take the whole TUI down.
 *   - SCOPE OF THE ROOTS: a raw `process.env` copy is the PRE-scope view, so a
 *     detached child inside an embedding app resolves the HOST data home.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ENV_PI_MODELS_SYNC_OFF, syncPiModels } from "../src/lib/embeddedPi.ts";
import { ENV_ENGINE_SCOPE, runInEngineScope } from "../src/lib/engineScope.ts";
import { ENV_PI_AGENT_DIR, nativeAgentDir } from "../src/lib/nativeAgentDir.ts";

/** A ChildProcess stand-in: EventEmitter (so `error` behaves for real) + unref. */
class FakeChild extends EventEmitter {
  unrefed = false;
  unref(): void {
    this.unrefed = true;
  }
}

interface SpawnCall {
  cmd: string;
  args: string[];
  opts: Record<string, unknown>;
}

function recorder(opts: { throwSync?: boolean } = {}) {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const spawnImpl = (cmd: string, args: string[], o: object) => {
    calls.push({ cmd, args, opts: o as Record<string, unknown> });
    if (opts.throwSync) throw new Error("EACCES: spawn not permitted");
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  return { spawnImpl, calls, children };
}

const BASE_ENV: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/home/x" };
let dataHome: string;

beforeEach(() => {
  dataHome = mkdtempSync(join(tmpdir(), "pb-pi-sync-"));
});
afterEach(() => {
  rmSync(dataHome, { recursive: true, force: true });
});

function run(r: ReturnType<typeof recorder>, env: NodeJS.ProcessEnv = BASE_ENV, persona = "kai") {
  return syncPiModels({ persona, dataHome, env, spawnImpl: r.spawnImpl });
}

describe("syncPiModels", () => {
  test("re-enters the embedded engine with `update --models`, detached and unref'd", () => {
    const r = recorder();
    expect(run(r)).toBe(true);
    const { cmd, args, opts } = r.calls[0]!;
    expect(cmd).toBe(process.execPath);
    expect(args).toContain("__pi");
    expect(args.slice(-2)).toEqual(["update", "--models"]);
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe("ignore");
    expect(opts.windowsHide).toBe(true);
    expect(r.children[0]!.unrefed).toBe(true);
  });

  test("refreshes the SELECTED persona's agent dir, not the ambient one", () => {
    const r = recorder();
    // A persona-scoped TUI browsing a sibling persona is the bug this pins.
    run(r, { ...BASE_ENV, PHANTOMBOT_PERSONA: "lena", [ENV_PI_AGENT_DIR]: "/legacy/agent" });
    const env = r.calls[0]!.opts.env as Record<string, string>;
    expect(env[ENV_PI_AGENT_DIR]).toBe(nativeAgentDir(dataHome, "kai"));
    expect(env.PHANTOMBOT_PERSONA).toBe("kai");
    // PATH/HOME must survive (pi needs them) and the dir must exist to be written.
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/x");
    expect(existsSync(nativeAgentDir(dataHome, "kai"))).toBe(true);
  });

  test("an async `error` event is absorbed, not thrown out of the TUI", () => {
    const r = recorder();
    run(r);
    // With no listener this emit throws — precisely the regression.
    expect(() => r.children[0]!.emit("error", new Error("ENOENT: exe vanished"))).not.toThrow();
  });

  test("a synchronous spawn throw is swallowed and reports false", () => {
    const r = recorder({ throwSync: true });
    expect(() => expect(run(r)).toBe(false)).not.toThrow();
  });

  test("does not pre-empt the legacy absorb on an upgraded host", () => {
    // A refresh must not create the persona dir before that persona's first
    // turn: absorbFileInto skips existing targets, so the legacy catalog would
    // be stranded. Legacy present + persona absent => hands off.
    mkdirSync(nativeAgentDir(dataHome), { recursive: true });
    const r = recorder();
    expect(run(r)).toBe(false);
    expect(r.calls.length).toBe(0);
    expect(existsSync(nativeAgentDir(dataHome, "kai"))).toBe(false);

    // Once the persona dir exists (first turn ran), the refresh is fine.
    mkdirSync(nativeAgentDir(dataHome, "kai"), { recursive: true });
    expect(run(r)).toBe(true);
  });

  test("a FRESH host (no legacy dir) still refreshes and creates the dir", () => {
    const r = recorder();
    expect(run(r)).toBe(true);
    expect(existsSync(nativeAgentDir(dataHome, "kai"))).toBe(true);
  });

  test("offline mode and the test escape hatch both suppress the spawn", () => {
    for (const env of [{ PI_OFFLINE: "1" }, { [ENV_PI_MODELS_SYNC_OFF]: "1" }]) {
      const r = recorder();
      expect(run(r, { ...BASE_ENV, ...env })).toBe(false);
      expect(r.calls.length).toBe(0);
    }
  });

  test("stacks no second child while one refresh for the persona is in flight", () => {
    // Settings mounts on every visit: leave and re-enter and each mount used to
    // spawn another network child for the same persona.
    const r = recorder();
    expect(run(r)).toBe(true);
    expect(run(r)).toBe(false);
    expect(r.calls.length).toBe(1);
    // The mark is PER PERSONA: a sibling still refreshes.
    expect(run(r, BASE_ENV, "lena")).toBe(true);
    expect(r.calls.length).toBe(2);
  });

  test("a launch failure clears the in-flight mark so a later visit retries", () => {
    const r = recorder();
    expect(run(r)).toBe(true);
    r.children[0]!.emit("error", new Error("ENOENT: exe vanished"));
    expect(run(r)).toBe(true);
    expect(r.calls.length).toBe(2);
  });

  test("inside an engine scope the child gets the scoped roots, not the host's", () => {
    const r = recorder();
    const scope = {
      configHome: "/embed/config",
      dataHome: "/embed/data",
      stateHome: "/embed/state",
    };
    runInEngineScope(scope, () => run(r, { ...BASE_ENV, PHANTOMBOT_CONFIG: "/host/config.toml" }));
    const env = r.calls[0]!.opts.env as Record<string, string>;
    expect(env[ENV_ENGINE_SCOPE]).toBe("1");
    expect(env.XDG_DATA_HOME).toBe("/embed/data");
    expect(env.XDG_CONFIG_HOME).toBe("/embed/config");
    // A host-location override would aim the child at the HOST's phantombot.
    expect(env.PHANTOMBOT_CONFIG).toBeUndefined();
    // The catalog still lands in the selected persona's dir.
    expect(env[ENV_PI_AGENT_DIR]).toBe(nativeAgentDir(dataHome, "kai"));
  });
});
