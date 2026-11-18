/**
 * Package-manager ownership detection (mise / Omarchy). When mise installed
 * the binary, phantombot must not offer or perform its own in-place update.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  detectExternalUpdateManager,
  externalUpdateMessage,
} from "../src/lib/externalUpdates.ts";
import { isVersionInvocation } from "../src/lib/cliInvocation.ts";

const noEnv = {};

describe("detectExternalUpdateManager", () => {
  test("registry install under ~/.local/share/mise → mise", () => {
    const m = detectExternalUpdateManager(
      "/home/u/.local/share/mise/installs/phantombot/1.1.510/phantombot",
      noEnv,
    );
    expect(m?.name).toBe("mise");
    expect(m?.upgradeCommand).toBe("mise upgrade phantombot");
  });

  test("backend-qualified install dir → mise", () => {
    expect(
      detectExternalUpdateManager(
        "/home/u/.local/share/mise/installs/github-phantomyard-phantombot/1.1.510/bin/phantombot",
        noEnv,
      )?.name,
    ).toBe("mise");
  });

  test("custom MISE_DATA_DIR → mise", () => {
    expect(
      detectExternalUpdateManager("/opt/tools/installs/phantombot/latest/phantombot", {
        MISE_DATA_DIR: "/opt/tools/",
      })?.name,
    ).toBe("mise");
  });

  test("Windows separators → mise", () => {
    expect(
      detectExternalUpdateManager(
        "C:\\Users\\u\\AppData\\Local\\mise\\installs\\phantombot\\1.1.510\\phantombot.exe",
        noEnv,
      )?.name,
    ).toBe("mise");
  });

  test("normal install locations → self-managed", () => {
    for (const p of [
      "/home/u/.local/bin/phantombot",
      "/usr/local/bin/phantombot",
      "C:\\Users\\u\\AppData\\Local\\phantombot\\phantombot.exe",
    ]) {
      expect(detectExternalUpdateManager(p, noEnv)).toBeNull();
    }
  });

  test("bun from mise running from source is NOT a mise-managed phantombot", () => {
    expect(
      detectExternalUpdateManager(
        "/home/u/.local/share/mise/installs/bun/1.3.0/bin/bun",
        noEnv,
      ),
    ).toBeNull();
  });

  test("installs/ with no tool subpath is not a match", () => {
    expect(
      detectExternalUpdateManager("/home/u/.local/share/mise/installs/phantombot", noEnv),
    ).toBeNull();
  });

  test("this test process is not mise-managed (CI sanity)", () => {
    // Guards the defaults: a false positive here would silently disable every
    // update path for real users too.
    expect(detectExternalUpdateManager(join("/tmp", "phantombot"), noEnv)).toBeNull();
  });

  test("message names the manager and the command", () => {
    const msg = externalUpdateMessage({
      name: "mise",
      upgradeCommand: "mise upgrade phantombot",
    });
    expect(msg).toContain("mise");
    expect(msg).toContain("`mise upgrade phantombot`");
  });
});

describe("isVersionInvocation", () => {
  test("exactly --version", () => {
    expect(isVersionInvocation(["bun", "pb", "--version"])).toBe(true);
    expect(isVersionInvocation(["bun", "pb"])).toBe(false);
    expect(isVersionInvocation(["bun", "pb", "update", "--version"])).toBe(false);
    expect(isVersionInvocation(["bun", "pb", "--version", "x"])).toBe(false);
  });
});

describe("phantombot --version stdout", () => {
  test("prints the bare version with no [log] prefix", async () => {
    const proc = Bun.spawn(
      [process.execPath, join(import.meta.dir, "..", "src", "index.ts"), "--version"],
      { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
    );
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out).toMatch(/^\d+\.\d+\.\d+(-dev)?\n$/);
  }, 20_000);
});
