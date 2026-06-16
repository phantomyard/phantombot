/**
 * Tests for the shared channel persona picker. The interactive `p.select` path
 * needs a TTY, so we cover the non-interactive guard: with no personas on disk
 * the picker must return null (skip) WITHOUT prompting or crashing.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pickChannelPersona } from "../src/cli/channelPersona.ts";
import type { Config } from "../src/config.ts";

describe("pickChannelPersona", () => {
  test("returns null (skip) when there are no personas — no prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pcp-"));
    // personasDir does not exist → listExistingPersonas returns [] → null,
    // before ever reaching loadState() or p.select().
    const config = {
      personasDir: join(dir, "personas"),
      defaultPersona: "ghost",
    } as Config;
    expect(await pickChannelPersona(config, "PhantomChat")).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  test("returns null when the personas dir exists but is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pcp-"));
    await mkdir(join(dir, "personas"), { recursive: true });
    const config = {
      personasDir: join(dir, "personas"),
      defaultPersona: "ghost",
    } as Config;
    expect(await pickChannelPersona(config, "Telegram")).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });
});
