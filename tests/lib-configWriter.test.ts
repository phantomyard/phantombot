/**
 * Tests for the TOML round-trip config writer.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getIn,
  readConfigToml,
  setIn,
  updateConfigToml,
  writeConfigToml,
} from "../src/lib/configWriter.ts";

let workdir: string;
let path: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-cfgwriter-"));
  path = join(workdir, "config.toml");
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("readConfigToml", () => {
  test("returns {} when the file does not exist", async () => {
    expect(await readConfigToml(path)).toEqual({});
  });

  test("parses an existing TOML file", async () => {
    await writeFile(path, `name = "phantom"\n\n[harnesses]\nchain = ["claude"]\n`);
    expect(await readConfigToml(path)).toEqual({
      name: "phantom",
      harnesses: { chain: ["claude"] },
    });
  });
});

describe("writeConfigToml", () => {
  test("writes nested objects as TOML sections", async () => {
    await writeConfigToml(path, {
      default_persona: "robbie",
      channels: { telegram: { token: "abc", allowed_user_ids: [42] } },
    });
    const text = await readFile(path, "utf8");
    expect(text).toContain('default_persona = "robbie"');
    expect(text).toContain("[channels.telegram]");
    expect(text).toContain('token = "abc"');
    expect(text).toContain("allowed_user_ids = [ 42 ]");
  });
});

describe("updateConfigToml", () => {
  test("preserves existing keys outside the mutated section", async () => {
    await writeFile(
      path,
      `default_persona = "robbie"\n\n[harnesses]\nchain = ["claude"]\n`,
    );
    await updateConfigToml(path, (toml) => {
      setIn(toml, ["channels", "telegram", "token"], "new-token");
    });
    const after = await readConfigToml(path);
    expect(after.default_persona).toBe("robbie");
    expect(after.harnesses).toEqual({ chain: ["claude"] });
    expect(getIn(after, ["channels", "telegram", "token"])).toBe("new-token");
  });
});

describe("setIn / getIn", () => {
  test("setIn creates intermediate objects", () => {
    const o: Record<string, unknown> = {};
    setIn(o, ["a", "b", "c"], 42);
    expect(o).toEqual({ a: { b: { c: 42 } } });
  });

  test("setIn replaces a non-object on the path", () => {
    const o: Record<string, unknown> = { a: "scalar" };
    setIn(o, ["a", "b"], 1);
    expect(o).toEqual({ a: { b: 1 } });
  });

  test("getIn returns nested value or undefined", () => {
    const o = { a: { b: { c: 99 } } };
    expect(getIn(o, ["a", "b", "c"])).toBe(99);
    expect(getIn(o, ["a", "b", "z"])).toBeUndefined();
    expect(getIn(o, ["x"])).toBeUndefined();
  });
});
