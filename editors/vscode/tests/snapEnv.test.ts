/**
 * Snap-aware spawn-env tests — reproduce the strict-snap redirected-`$HOME`
 * exit-2 case and assert the env-pinning fix, all pure (no `vscode`, no real
 * subprocess, no fs).
 *
 * Background (see src/snapEnv.ts): a STRICT SNAP VS Code (Ubuntu App Center)
 * redirects `$HOME` into the snap sandbox, whose phantombot persona store is
 * empty, so plain `phantombot acp` exits 2 ("no other personas exist"). The fix
 * pins PHANTOMBOT_PERSONAS_DIR + PHANTOMBOT_CONFIG back to the REAL home via
 * `$SNAP_REAL_HOME`.
 */

import { describe, expect, test } from "bun:test";

import {
  configPathFor,
  isHomeRedirected,
  isSnapConfined,
  personasDirFor,
  snapAwareSpawnEnv,
  type EnvMap,
} from "../src/snapEnv.ts";

const REAL_HOME = "/home/alice";
const SNAP_HOME = "/home/alice/snap/code/158";

/** The env snapd hands a strict-snap-confined `phantombot acp` child. */
function strictSnapEnv(extra: EnvMap = {}): EnvMap {
  return {
    HOME: SNAP_HOME,
    SNAP: "/snap/code/158",
    SNAP_REAL_HOME: REAL_HOME,
    // Under a strict snap XDG_* are redirected too (under the snap HOME).
    XDG_CONFIG_HOME: `${SNAP_HOME}/.config`,
    XDG_DATA_HOME: `${SNAP_HOME}/.local/share`,
    ...extra,
  };
}

/** The env a NATIVE install (.deb / Zed) sees — real home, no snap vars. */
function nativeEnv(extra: EnvMap = {}): EnvMap {
  return { HOME: REAL_HOME, PATH: "/usr/bin", ...extra };
}

describe("isSnapConfined", () => {
  test("true only when BOTH $SNAP and $SNAP_REAL_HOME are set", () => {
    expect(isSnapConfined(strictSnapEnv())).toBe(true);
    expect(isSnapConfined(nativeEnv())).toBe(false);
    expect(isSnapConfined({ SNAP: "/snap/code/158" })).toBe(false);
    expect(isSnapConfined({ SNAP_REAL_HOME: REAL_HOME })).toBe(false);
    expect(isSnapConfined({ SNAP: "  ", SNAP_REAL_HOME: REAL_HOME })).toBe(false);
  });
});

describe("isHomeRedirected — reproduces the exit-2 trigger", () => {
  test("strict-snap HOME redirected under <real home>/snap/ is detected", () => {
    // THIS is the exact condition that empties phantombot's persona store and
    // makes `phantombot acp` exit 2. The redirected HOME sits under the real
    // home's snap/ subtree, not at the real home.
    expect(isHomeRedirected(strictSnapEnv())).toBe(true);
  });

  test("a native install's HOME == SNAP_REAL_HOME is NOT redirected", () => {
    expect(
      isHomeRedirected({ HOME: REAL_HOME, SNAP_REAL_HOME: REAL_HOME }),
    ).toBe(false);
  });

  test("no snap vars at all → not redirected", () => {
    expect(isHomeRedirected(nativeEnv())).toBe(false);
  });
});

describe("snapAwareSpawnEnv — the fix", () => {
  test("native env is returned UNCHANGED (no snap → no override)", () => {
    const env = nativeEnv();
    const out = snapAwareSpawnEnv(env);
    expect(out).toBe(env); // same reference, untouched
    expect(out.PHANTOMBOT_PERSONAS_DIR).toBeUndefined();
    expect(out.PHANTOMBOT_CONFIG).toBeUndefined();
  });

  test("strict-snap env gets absolute overrides pinned to the REAL home", () => {
    const out = snapAwareSpawnEnv(strictSnapEnv());

    // The fix: persona/config resolution is pinned back to the REAL home, NOT
    // the empty redirected snap home — this is what prevents the exit-2 crash.
    expect(out.PHANTOMBOT_PERSONAS_DIR).toBe(personasDirFor(REAL_HOME));
    expect(out.PHANTOMBOT_CONFIG).toBe(configPathFor(REAL_HOME));

    // Both are absolute and under the real home, NOT under the snap sandbox.
    expect(out.PHANTOMBOT_PERSONAS_DIR!.startsWith(REAL_HOME + "/")).toBe(true);
    expect(out.PHANTOMBOT_PERSONAS_DIR).not.toContain("/snap/");
    expect(out.PHANTOMBOT_CONFIG).not.toContain("/snap/");
  });

  test("returns a NEW object; never mutates the caller's env", () => {
    const env = strictSnapEnv();
    const out = snapAwareSpawnEnv(env);
    expect(out).not.toBe(env);
    expect(env.PHANTOMBOT_PERSONAS_DIR).toBeUndefined();
    expect(env.PHANTOMBOT_CONFIG).toBeUndefined();
  });

  test("respects an explicit user override — does not clobber it", () => {
    const out = snapAwareSpawnEnv(
      strictSnapEnv({
        PHANTOMBOT_PERSONAS_DIR: "/custom/personas",
        PHANTOMBOT_CONFIG: "/custom/config.toml",
      }),
    );
    expect(out.PHANTOMBOT_PERSONAS_DIR).toBe("/custom/personas");
    expect(out.PHANTOMBOT_CONFIG).toBe("/custom/config.toml");
  });

  test("a blank/whitespace override is treated as unset and gets pinned", () => {
    const out = snapAwareSpawnEnv(
      strictSnapEnv({ PHANTOMBOT_PERSONAS_DIR: "   ", PHANTOMBOT_CONFIG: "" }),
    );
    expect(out.PHANTOMBOT_PERSONAS_DIR).toBe(personasDirFor(REAL_HOME));
    expect(out.PHANTOMBOT_CONFIG).toBe(configPathFor(REAL_HOME));
  });

  test("path helpers build phantombot's default absolute layout", () => {
    expect(personasDirFor(REAL_HOME)).toBe(
      "/home/alice/.local/share/phantombot/personas",
    );
    expect(configPathFor(REAL_HOME)).toBe(
      "/home/alice/.config/phantombot/config.toml",
    );
  });
});
