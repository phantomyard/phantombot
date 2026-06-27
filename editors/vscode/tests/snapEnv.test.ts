/**
 * Snap-aware spawn-env tests — reproduce the strict-snap redirected-`$HOME`
 * exit-2 case and assert the env-pinning fix, all pure (no `vscode`, no real
 * subprocess, no fs).
 *
 * Background (see src/snapEnv.ts): a STRICT SNAP VS Code (Ubuntu App Center)
 * redirects `$HOME` into the snap sandbox, whose phantombot persona store is
 * empty, so plain `phantombot acp` exits 2 ("no other personas exist"). The fix
 * pins ONLY PHANTOMBOT_CONFIG back to the REAL home via `$SNAP_REAL_HOME`;
 * loadConfig then resolves personas_dir from that config (default OR custom), so
 * PHANTOMBOT_PERSONAS_DIR is deliberately left unset to avoid overriding a custom
 * persona root.
 */

import { describe, expect, test } from "bun:test";

import {
  configHomeFor,
  configPathFor,
  dataHomeFor,
  isHomeRedirected,
  isSnapConfined,
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

  test("strict-snap env pins config + XDG dirs to the REAL home", () => {
    const out = snapAwareSpawnEnv(strictSnapEnv());

    // The fix: config resolution is pinned back to the REAL home, NOT the empty
    // redirected snap home — this is what prevents the exit-2 crash. loadConfig
    // then resolves personas_dir from that config.
    expect(out.PHANTOMBOT_CONFIG).toBe(configPathFor(REAL_HOME));

    // PHANTOMBOT_PERSONAS_DIR is deliberately NOT set: it would override a custom
    // `personas_dir` in config.toml and silently break custom persona roots.
    expect(out.PHANTOMBOT_PERSONAS_DIR).toBeUndefined();

    // The config is absolute and under the real home, NOT under the snap sandbox.
    expect(out.PHANTOMBOT_CONFIG!.startsWith(REAL_HOME + "/")).toBe(true);
    expect(out.PHANTOMBOT_CONFIG).not.toContain("/snap/");
  });

  test("DEFAULT install (no personas_dir): restores XDG_DATA_HOME so loadConfig's default store resolves to the REAL home — the blocker Kai flagged", () => {
    // This is the case PHANTOMBOT_CONFIG alone did NOT cover: a config.toml with
    // no explicit personas_dir falls back to join(xdgDataHome(),"phantombot",
    // "personas") in loadConfig. Under strict snap XDG_DATA_HOME is redirected to
    // the empty sandbox store → exit 2. We must hand the child a real XDG_DATA_HOME.
    const out = snapAwareSpawnEnv(strictSnapEnv());

    expect(out.XDG_DATA_HOME).toBe(dataHomeFor(REAL_HOME));
    expect(out.XDG_CONFIG_HOME).toBe(configHomeFor(REAL_HOME));

    // Forced back under the real home, NOT the snap sandbox.
    expect(out.XDG_DATA_HOME).toBe("/home/alice/.local/share");
    expect(out.XDG_DATA_HOME).not.toContain("/snap/");
    expect(out.XDG_CONFIG_HOME).not.toContain("/snap/");

    // Still no PHANTOMBOT_PERSONAS_DIR: custom personas_dir in config.toml wins.
    expect(out.PHANTOMBOT_PERSONAS_DIR).toBeUndefined();
  });

  test("FORCES XDG dirs over snapd's redirected sandbox values", () => {
    // snapd always populates XDG_* with redirected sandbox paths; the redirected
    // value IS the bug, so we override rather than respect it.
    const out = snapAwareSpawnEnv(
      strictSnapEnv({
        XDG_DATA_HOME: `${SNAP_HOME}/.local/share`,
        XDG_CONFIG_HOME: `${SNAP_HOME}/.config`,
      }),
    );
    expect(out.XDG_DATA_HOME).toBe(dataHomeFor(REAL_HOME));
    expect(out.XDG_CONFIG_HOME).toBe(configHomeFor(REAL_HOME));
  });

  test("returns a NEW object; never mutates the caller's env", () => {
    const env = strictSnapEnv();
    const out = snapAwareSpawnEnv(env);
    expect(out).not.toBe(env);
    expect(env.PHANTOMBOT_CONFIG).toBeUndefined();
    expect(env.PHANTOMBOT_PERSONAS_DIR).toBeUndefined();
  });

  test("respects an explicit PHANTOMBOT_CONFIG override — does not clobber it", () => {
    const out = snapAwareSpawnEnv(
      strictSnapEnv({
        PHANTOMBOT_CONFIG: "/custom/config.toml",
      }),
    );
    expect(out.PHANTOMBOT_CONFIG).toBe("/custom/config.toml");
    expect(out.PHANTOMBOT_PERSONAS_DIR).toBeUndefined();
  });

  test("a blank/whitespace PHANTOMBOT_CONFIG is treated as unset and gets pinned", () => {
    const out = snapAwareSpawnEnv(
      strictSnapEnv({ PHANTOMBOT_CONFIG: "" }),
    );
    expect(out.PHANTOMBOT_CONFIG).toBe(configPathFor(REAL_HOME));
    expect(out.PHANTOMBOT_PERSONAS_DIR).toBeUndefined();
  });

  test("an explicit PHANTOMBOT_PERSONAS_DIR is passed through untouched", () => {
    // We never set it ourselves, but if the user/env already has one we must not
    // strip it — pass it straight through.
    const out = snapAwareSpawnEnv(
      strictSnapEnv({ PHANTOMBOT_PERSONAS_DIR: "/custom/personas" }),
    );
    expect(out.PHANTOMBOT_PERSONAS_DIR).toBe("/custom/personas");
    expect(out.PHANTOMBOT_CONFIG).toBe(configPathFor(REAL_HOME));
  });

  test("config path helper builds phantombot's default absolute layout", () => {
    expect(configPathFor(REAL_HOME)).toBe(
      "/home/alice/.config/phantombot/config.toml",
    );
  });

  test("XDG path helpers build phantombot's default absolute layout", () => {
    expect(dataHomeFor(REAL_HOME)).toBe("/home/alice/.local/share");
    expect(configHomeFor(REAL_HOME)).toBe("/home/alice/.config");
  });
});
