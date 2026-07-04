/**
 * Windows-port shim tests (issue #201, feature/windows-port).
 *
 * These verify the platform-conditional behaviour of the Phase 1 shims:
 * path resolution, the run-lock path, the platform enum, and the read-only
 * invocation guard. Where a shim branches on `process.platform`, we stub it
 * with a save/restore wrapper so the Windows branch is exercised even though
 * CI runs on Linux — the assertions are pure path/string logic with no OS
 * calls, so this is safe and deterministic.
 */

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { xdgConfigHome, xdgDataHome, xdgStateHome } from "../src/config.ts";
import { currentPlatform } from "../src/lib/platform.ts";
import { defaultLockPath } from "../src/lib/runLock.ts";
import { isReadOnlyInvocation } from "../src/lib/cliInvocation.ts";

/** Temporarily override process.platform for one synchronous assertion. */
function withPlatform(value: NodeJS.Platform, fn: () => void): void {
  const saved = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value, configurable: true });
  try {
    fn();
  } finally {
    if (saved) Object.defineProperty(process, "platform", saved);
  }
}

/** Temporarily set/unset env vars around a callback, restoring after. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("currentPlatform (windows)", () => {
  test("maps win32 → windows", () => {
    withPlatform("win32", () => {
      expect(currentPlatform()).toBe("windows");
    });
  });
});

describe("xdg* path resolvers on Windows", () => {
  const XDG = {
    XDG_CONFIG_HOME: undefined,
    XDG_DATA_HOME: undefined,
    XDG_STATE_HOME: undefined,
    LOCALAPPDATA: "C:\\Users\\megan\\AppData\\Local",
  };

  test("config, data AND state all collapse under %LOCALAPPDATA% (single root)", () => {
    withEnv(XDG, () => {
      withPlatform("win32", () => {
        const root = "C:\\Users\\megan\\AppData\\Local";
        expect(xdgConfigHome()).toBe(root);
        expect(xdgDataHome()).toBe(root);
        expect(xdgStateHome()).toBe(root);
      });
    });
  });

  test("explicit XDG_* env still wins on Windows (test/override escape hatch)", () => {
    withEnv({ ...XDG, XDG_DATA_HOME: "D:\\override\\data" }, () => {
      withPlatform("win32", () => {
        expect(xdgDataHome()).toBe("D:\\override\\data");
      });
    });
  });

  test("does NOT affect POSIX resolution", () => {
    withEnv(
      { XDG_CONFIG_HOME: undefined, XDG_DATA_HOME: undefined, XDG_STATE_HOME: undefined },
      () => {
        withPlatform("linux", () => {
          expect(xdgConfigHome()).toContain(".config");
          expect(xdgDataHome()).toContain(join(".local", "share"));
          expect(xdgStateHome()).toContain(join(".local", "state"));
        });
      },
    );
  });
});

describe("defaultLockPath on Windows", () => {
  test("falls back to per-user %TEMP% when XDG_RUNTIME_DIR is unset", () => {
    withEnv({ XDG_RUNTIME_DIR: undefined }, () => {
      withPlatform("win32", () => {
        expect(defaultLockPath()).toBe(join(tmpdir(), "phantombot.run.lock"));
      });
    });
  });

  test("XDG_RUNTIME_DIR still wins if somehow set", () => {
    withEnv({ XDG_RUNTIME_DIR: "R:\\run" }, () => {
      withPlatform("win32", () => {
        expect(defaultLockPath()).toBe(join("R:\\run", "phantombot.run.lock"));
      });
    });
  });
});

describe("isReadOnlyInvocation", () => {
  const argv = (...rest: string[]) => ["bun", "phantombot", ...rest];

  test("bare invocation (no subcommand) is read-only", () => {
    expect(isReadOnlyInvocation(argv())).toBe(true);
  });

  test.each([["--help"], ["-h"], ["--version"], ["-v"], ["help"]])(
    "%s is read-only",
    (flag) => {
      expect(isReadOnlyInvocation(argv(flag))).toBe(true);
    },
  );

  test.each([["run"], ["ask"], ["vault"], ["persona"], ["tick"], ["nightly"]])(
    "%s subcommand is NOT read-only (bootstrap must run)",
    (sub) => {
      expect(isReadOnlyInvocation(argv(sub))).toBe(false);
    },
  );

  test("a --help AFTER a real subcommand is not treated as top-level read-only", () => {
    // `phantombot vault --help` still runs bootstrap; only the top-level
    // help/version fast-path is guarded. This is intentional and documented.
    expect(isReadOnlyInvocation(argv("vault", "--help"))).toBe(false);
  });
});
