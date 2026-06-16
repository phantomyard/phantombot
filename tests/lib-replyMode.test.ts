import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearReplyModeOverride,
  getReplyModeOverride,
  normalizeReplyMode,
  normalizeReplyModeRequest,
  replyModeStatePath,
  setReplyModeOverride,
  touchReplyModeOverride,
} from "../src/lib/replyMode.ts";

const SAVED = process.env.PHANTOMBOT_REPLY_MODE_STATE;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "phantombot-reply-mode-"));
  process.env.PHANTOMBOT_REPLY_MODE_STATE = join(dir, "state.json");
});

afterEach(async () => {
  if (SAVED === undefined) delete process.env.PHANTOMBOT_REPLY_MODE_STATE;
  else process.env.PHANTOMBOT_REPLY_MODE_STATE = SAVED;
  await rm(dir, { recursive: true, force: true });
});

describe("reply mode overrides", () => {
  test("normalizes only persisted override modes", () => {
    expect(normalizeReplyMode("text")).toBe("text");
    expect(normalizeReplyMode("voice")).toBe("voice");
    expect(normalizeReplyMode("default")).toBeUndefined();
    expect(normalizeReplyMode(undefined)).toBeUndefined();
  });

  test("normalizes request modes including explicit disable", () => {
    expect(normalizeReplyModeRequest("text")).toBe("text");
    expect(normalizeReplyModeRequest("voice")).toBe("voice");
    expect(normalizeReplyModeRequest("default")).toBe("default");
    expect(normalizeReplyModeRequest("disable")).toBe("default");
    expect(normalizeReplyModeRequest("clear")).toBe("default");
    expect(normalizeReplyModeRequest(undefined)).toBeUndefined();
  });

  test("sets and reads a persona+conversation scoped override", async () => {
    await setReplyModeOverride({
      persona: "kai",
      conversation: "telegram:1",
      mode: "text",
      now: new Date("2026-06-16T10:00:00Z"),
    });

    expect(replyModeStatePath()).toBe(join(dir, "state.json"));
    expect(
      await getReplyModeOverride({
        persona: "kai",
        conversation: "telegram:1",
        now: new Date("2026-06-16T10:09:59Z"),
      }),
    ).toBe("text");
    expect(
      await getReplyModeOverride({
        persona: "lena",
        conversation: "telegram:1",
        now: new Date("2026-06-16T10:01:00Z"),
      }),
    ).toBeUndefined();
  });

  test("touch extends the idle expiry", async () => {
    await setReplyModeOverride({
      persona: "kai",
      conversation: "telegram:1",
      mode: "voice",
      now: new Date("2026-06-16T10:00:00Z"),
    });

    expect(
      await touchReplyModeOverride({
        persona: "kai",
        conversation: "telegram:1",
        now: new Date("2026-06-16T10:09:00Z"),
      }),
    ).toBe("voice");
    expect(
      await getReplyModeOverride({
        persona: "kai",
        conversation: "telegram:1",
        now: new Date("2026-06-16T10:18:30Z"),
      }),
    ).toBe("voice");
  });

  test("expired overrides are cleared", async () => {
    await setReplyModeOverride({
      persona: "kai",
      conversation: "telegram:1",
      mode: "text",
      now: new Date("2026-06-16T10:00:00Z"),
    });

    expect(
      await getReplyModeOverride({
        persona: "kai",
        conversation: "telegram:1",
        now: new Date("2026-06-16T10:10:01Z"),
      }),
    ).toBeUndefined();
  });

  test("clear removes an override", async () => {
    await setReplyModeOverride({
      persona: "kai",
      conversation: "telegram:1",
      mode: "text",
    });
    await clearReplyModeOverride({ persona: "kai", conversation: "telegram:1" });
    expect(
      await getReplyModeOverride({ persona: "kai", conversation: "telegram:1" }),
    ).toBeUndefined();
  });
});
