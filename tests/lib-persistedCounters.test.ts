import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bumpCounters,
  countersFilePath,
  readCounters,
} from "../src/lib/persistedCounters.ts";

const prevState = process.env.XDG_STATE_HOME;
let workdir = "";

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "counters-test-"));
  process.env.XDG_STATE_HOME = workdir;
});

afterAll(() => {
  if (prevState === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = prevState;
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

describe("persisted counters store", () => {
  test("empty store reads as {}", async () => {
    expect(await readCounters()).toEqual({});
  });

  test("bumps accumulate under the same key", async () => {
    bumpCounters({ "narration.drop.nl.en": 1 });
    bumpCounters({ "narration.drop.nl.en": 1 });
    bumpCounters({ "narration.drop.nl.en": 2 });
    expect(await readCounters()).toEqual({ "narration.drop.nl.en": 4 });
  });

  test("distinct keys count independently", async () => {
    bumpCounters({ "narration.drop.nl.en": 1, "delivery.lost.dm": 1 });
    bumpCounters({ "narration.idle-release.nl": 1 });
    expect(await readCounters()).toEqual({
      "narration.drop.nl.en": 1,
      "delivery.lost.dm": 1,
      "narration.idle-release.nl": 1,
    });
  });

  test("the store file lives in XDG state home under phantombot/", () => {
    expect(countersFilePath()).toBe(
      join(workdir, "phantombot", "counters.json"),
    );
  });

  test("zero and negative bumps are ignored", async () => {
    bumpCounters({ "a.b": 0, "c.d": -3 });
    expect(await readCounters()).toEqual({});
  });

  test("a corrupt store resets instead of wedging every future bump", async () => {
    mkdirSync(join(workdir, "phantombot"), { recursive: true });
    writeFileSync(countersFilePath(), "{not json", "utf8");
    bumpCounters({ "narration.drop.nl.en": 1 });
    expect(await readCounters()).toEqual({ "narration.drop.nl.en": 1 });
  });

  test("non-numeric junk in the store is dropped on read", async () => {
    mkdirSync(join(workdir, "phantombot"), { recursive: true });
    writeFileSync(
      countersFilePath(),
      JSON.stringify({ "narration.drop.nl.en": 2, junk: "hello" }),
      "utf8",
    );
    expect(await readCounters()).toEqual({ "narration.drop.nl.en": 2 });
  });

  test("concurrent bumps do not lose each other's updates", async () => {
    // Fire 20 bumps without awaiting; the internal chain must serialise
    // the read-modify-write cycles so every unit survives.
    for (let i = 0; i < 20; i++) bumpCounters({ "race.test": 1 });
    expect(await readCounters()).toEqual({ "race.test": 20 });
  });
});
