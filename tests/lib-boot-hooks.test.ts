/**
 * Tests for the [boot_hooks] linger-ownership marker: parse, host-only
 * stripping, and the write/clear round-trip. Regression coverage for the
 * PR #509 blocker — linger is a phantombot init PREREQUISITE and per-USER
 * host state, so only a flag phantombot itself created may ever be torn
 * down (and the boot-state probe must not display an inherited one as Boot).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBootHooks } from "../src/config.ts";
import { stripHostOnlyKeys } from "../src/lib/personaConfig.ts";
import { writeBootHook } from "../src/lib/personaDefault.ts";
import { readConfigToml } from "../src/lib/configWriter.ts";
import type { Config } from "../src/config.ts";

let workdir: string;
let path: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-boothooks-"));
  path = join(workdir, "config.toml");
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

function fakeConfig(): Config {
  return { configPath: path } as unknown as Config;
}

describe("parseBootHooks", () => {
  test("absent / malformed table → {}", () => {
    expect(parseBootHooks({})).toEqual({});
    expect(parseBootHooks({ boot_hooks: "yes" })).toEqual({});
    expect(parseBootHooks({ boot_hooks: { linger: "true" } })).toEqual({});
  });

  test("linger boolean round-trips; everything else ignored", () => {
    expect(parseBootHooks({ boot_hooks: { linger: true, stray: 1 } })).toEqual({ linger: true });
    expect(parseBootHooks({ boot_hooks: { linger: false } })).toEqual({ linger: false });
  });

  test("boot_hooks is HOST-ONLY — stripped from persona layers", () => {
    const out = stripHostOnlyKeys({ boot_hooks: { linger: true }, model: "x" });
    expect(out).toEqual({ model: "x" });
  });
});

describe("writeBootHook", () => {
  test("set → linger marker in [boot_hooks]; clear → table removed entirely", async () => {
    await writeFile(path, 'default_persona = "phantom"\n');
    const config = fakeConfig();

    await writeBootHook(config, "linger", true);
    expect(await readFile(path, "utf8")).toContain("[boot_hooks]");
    expect((await readConfigToml(path)).boot_hooks).toEqual({ linger: true });
    expect(config.bootHooks).toEqual({ linger: true });

    // Other keys survive the write.
    expect((await readConfigToml(path)).default_persona).toBe("phantom");

    await writeBootHook(config, "linger", undefined);
    const after = await readConfigToml(path);
    expect(after.boot_hooks).toBeUndefined(); // no `boot_hooks = {}` noise
    expect(after.default_persona).toBe("phantom");
    expect(config.bootHooks).toEqual({});
  });
});
