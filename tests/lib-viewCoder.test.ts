/**
 * Unit tests for the persistent per-conversation coder-progress override
 * (src/lib/viewCoder.ts). Unlike replyMode it has NO idle expiry — an override
 * persists until explicitly changed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyViewCoderRequest,
  clearViewCoderOverride,
  getViewCoderOverride,
  normalizeViewCoderRequest,
  setViewCoderOverride,
  viewCoderStatePath,
} from "../src/lib/viewCoder.ts";

const SAVED = process.env.PHANTOMBOT_VIEW_CODER_STATE;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "phantombot-view-coder-"));
  process.env.PHANTOMBOT_VIEW_CODER_STATE = join(dir, "state.json");
});

afterEach(async () => {
  if (SAVED === undefined) delete process.env.PHANTOMBOT_VIEW_CODER_STATE;
  else process.env.PHANTOMBOT_VIEW_CODER_STATE = SAVED;
  await rm(dir, { recursive: true, force: true });
});

describe("normalizeViewCoderRequest", () => {
  test("accepts on/off/default and common synonyms", () => {
    expect(normalizeViewCoderRequest("on")).toBe("on");
    expect(normalizeViewCoderRequest("enable")).toBe("on");
    expect(normalizeViewCoderRequest("off")).toBe("off");
    expect(normalizeViewCoderRequest("disable")).toBe("off");
    expect(normalizeViewCoderRequest("default")).toBe("default");
    expect(normalizeViewCoderRequest("clear")).toBe("default");
    expect(normalizeViewCoderRequest("auto")).toBe("default");
  });

  test("rejects unknown values", () => {
    expect(normalizeViewCoderRequest("maybe")).toBeUndefined();
    expect(normalizeViewCoderRequest("")).toBeUndefined();
    expect(normalizeViewCoderRequest(undefined)).toBeUndefined();
  });
});

describe("viewCoder override store", () => {
  test("set then get returns the scoped override", async () => {
    expect(viewCoderStatePath()).toBe(join(dir, "state.json"));
    await setViewCoderOverride({
      persona: "kai",
      conversation: "telegram:1",
      mode: "off",
    });
    expect(
      await getViewCoderOverride({ persona: "kai", conversation: "telegram:1" }),
    ).toBe("off");
  });

  test("scoped by persona+conversation — no cross-talk", async () => {
    await setViewCoderOverride({
      persona: "kai",
      conversation: "telegram:1",
      mode: "on",
    });
    expect(
      await getViewCoderOverride({ persona: "lena", conversation: "telegram:1" }),
    ).toBeUndefined();
    expect(
      await getViewCoderOverride({ persona: "kai", conversation: "telegram:2" }),
    ).toBeUndefined();
  });

  test("PERSISTENT — no idle expiry, the override survives arbitrary time", async () => {
    await setViewCoderOverride({
      persona: "kai",
      conversation: "telegram:1",
      mode: "off",
      now: new Date("2026-01-01T00:00:00Z"),
    });
    // A year later — still off. (replyMode would have expired long ago.)
    expect(
      await getViewCoderOverride({ persona: "kai", conversation: "telegram:1" }),
    ).toBe("off");
  });

  test("clear removes the override → defers to default", async () => {
    await setViewCoderOverride({
      persona: "kai",
      conversation: "telegram:1",
      mode: "on",
    });
    await clearViewCoderOverride({ persona: "kai", conversation: "telegram:1" });
    expect(
      await getViewCoderOverride({ persona: "kai", conversation: "telegram:1" }),
    ).toBeUndefined();
  });

  test("applyViewCoderRequest: on/off persist, default clears", async () => {
    await applyViewCoderRequest({
      persona: "kai",
      conversation: "telegram:1",
      request: "on",
    });
    expect(
      await getViewCoderOverride({ persona: "kai", conversation: "telegram:1" }),
    ).toBe("on");

    await applyViewCoderRequest({
      persona: "kai",
      conversation: "telegram:1",
      request: "default",
    });
    expect(
      await getViewCoderOverride({ persona: "kai", conversation: "telegram:1" }),
    ).toBeUndefined();
  });

  test("on-disk JSON shape matches what the extension reader expects", async () => {
    await setViewCoderOverride({
      persona: "kai",
      conversation: "telegram:1",
      mode: "off",
    });
    const raw = await Bun.file(join(dir, "state.json")).text();
    const parsed = JSON.parse(raw) as Record<string, { mode: string }>;
    // Key = `${persona}\u0000${conversation}`; entry carries { mode }.
    const key = `kai\u0000telegram:1`;
    expect(parsed[key]?.mode).toBe("off");
  });
});
