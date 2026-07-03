/**
 * Tests for the /chattiness per-conversation override store and the
 * narration-enabled resolver (override wins; else config default).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyChattinessRequest,
  chattinessStatePath,
  clearChattinessOverride,
  getChattinessOverride,
  normalizeChattinessRequest,
  resolveNarrationEnabled,
  setChattinessOverride,
} from "../src/lib/chattiness.ts";

describe("normalizeChattinessRequest", () => {
  test("on + synonyms", () => {
    expect(normalizeChattinessRequest("on")).toBe("on");
    expect(normalizeChattinessRequest("loud")).toBe("on");
    expect(normalizeChattinessRequest("verbose")).toBe("on");
  });
  test("off + synonyms", () => {
    expect(normalizeChattinessRequest("off")).toBe("off");
    expect(normalizeChattinessRequest("quiet")).toBe("off");
    expect(normalizeChattinessRequest("silent")).toBe("off");
  });
  test("default + synonyms", () => {
    expect(normalizeChattinessRequest("default")).toBe("default");
    expect(normalizeChattinessRequest("auto")).toBe("default");
    expect(normalizeChattinessRequest("clear")).toBe("default");
    expect(normalizeChattinessRequest("")).toBe("default");
  });
  test("rejects unknown", () => {
    expect(normalizeChattinessRequest("maybe")).toBeUndefined();
  });
});

describe("override store", () => {
  const SAVED = process.env.PHANTOMBOT_CHATTINESS_STATE;
  let dir: string;
  const who = { persona: "lena", conversation: "telegram:1" };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "phantombot-chattiness-"));
    process.env.PHANTOMBOT_CHATTINESS_STATE = join(dir, "state.json");
  });
  afterEach(async () => {
    if (SAVED === undefined) delete process.env.PHANTOMBOT_CHATTINESS_STATE;
    else process.env.PHANTOMBOT_CHATTINESS_STATE = SAVED;
    await rm(dir, { recursive: true, force: true });
  });

  test("path honors the env override", () => {
    expect(chattinessStatePath()).toBe(join(dir, "state.json"));
  });

  test("unset → undefined", async () => {
    expect(await getChattinessOverride(who)).toBeUndefined();
  });

  test("set/get/clear round-trip", async () => {
    await setChattinessOverride({ ...who, mode: "off" });
    expect(await getChattinessOverride(who)).toBe("off");
    await setChattinessOverride({ ...who, mode: "on" });
    expect(await getChattinessOverride(who)).toBe("on");
    await clearChattinessOverride(who);
    expect(await getChattinessOverride(who)).toBeUndefined();
  });

  test("applyChattinessRequest: default clears", async () => {
    await applyChattinessRequest({ ...who, request: "off" });
    expect(await getChattinessOverride(who)).toBe("off");
    await applyChattinessRequest({ ...who, request: "default" });
    expect(await getChattinessOverride(who)).toBeUndefined();
  });

  test("overrides are scoped per persona+conversation", async () => {
    await setChattinessOverride({ ...who, mode: "off" });
    expect(
      await getChattinessOverride({ persona: "kai", conversation: "telegram:1" }),
    ).toBeUndefined();
    expect(
      await getChattinessOverride({ persona: "lena", conversation: "telegram:2" }),
    ).toBeUndefined();
  });
});

describe("resolveNarrationEnabled — precedence", () => {
  const SAVED = process.env.PHANTOMBOT_CHATTINESS_STATE;
  let dir: string;
  const who = { persona: "lena", conversation: "telegram:1" };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "phantombot-chattiness-"));
    process.env.PHANTOMBOT_CHATTINESS_STATE = join(dir, "state.json");
  });
  afterEach(async () => {
    if (SAVED === undefined) delete process.env.PHANTOMBOT_CHATTINESS_STATE;
    else process.env.PHANTOMBOT_CHATTINESS_STATE = SAVED;
    await rm(dir, { recursive: true, force: true });
  });

  test("no override → follows the config default", async () => {
    expect(await resolveNarrationEnabled({ ...who, configDefault: true })).toBe(
      true,
    );
    expect(await resolveNarrationEnabled({ ...who, configDefault: false })).toBe(
      false,
    );
  });

  test("override ON wins even when default is OFF", async () => {
    await setChattinessOverride({ ...who, mode: "on" });
    expect(await resolveNarrationEnabled({ ...who, configDefault: false })).toBe(
      true,
    );
  });

  test("override OFF wins even when default is ON", async () => {
    await setChattinessOverride({ ...who, mode: "off" });
    expect(await resolveNarrationEnabled({ ...who, configDefault: true })).toBe(
      false,
    );
  });

  test("clearing the override falls back to the default again", async () => {
    await setChattinessOverride({ ...who, mode: "off" });
    await clearChattinessOverride(who);
    expect(await resolveNarrationEnabled({ ...who, configDefault: true })).toBe(
      true,
    );
  });
});
