import { describe, expect, test } from "bun:test";
import {
  formatNotifySummary,
  notifyLanded,
  notifySummaryDelivered,
} from "../src/lib/notifySummary.ts";
import { exitAfterFlush } from "../src/cli/notify.ts";

const sent = formatNotifySummary("max", ["telegram", "phantomchat"], {
  telegramText: 2,
  telegramVoice: 0,
  phantomchatText: 1,
});
const none = formatNotifySummary("max", ["telegram"], {
  telegramText: 0,
  telegramVoice: 0,
  phantomchatText: 0,
});

describe("notify summary", () => {
  test("parser reads back exactly what the formatter writes", () => {
    expect(notifySummaryDelivered(sent)).toBe(3);
    expect(notifySummaryDelivered(none)).toBe(0);
    expect(notifySummaryDelivered("")).toBeUndefined();
    expect(notifySummaryDelivered("notify: boom\n")).toBeUndefined();
  });

  test("summary found among log noise on either side", () => {
    expect(notifySummaryDelivered(`[warn] relay slow\n${sent}[warn] x\n`)).toBe(3);
  });

  test("a mid-line echo of the summary (e.g. message text) does not count", () => {
    expect(notifySummaryDelivered(`log: user said ${sent}`)).toBeUndefined();
  });
});

describe("notifyLanded (broker verdict)", () => {
  test("exit 0 is delivered", () => {
    expect(notifyLanded(0, "")).toBe(true);
  });

  test("killed after delivering (the duplicate-notification bug) is delivered", () => {
    // Timeout kill => non-zero exit, but the summary already reports sends.
    expect(notifyLanded(143, sent)).toBe(true);
    expect(notifyLanded(1, sent)).toBe(true);
  });

  test("non-zero with nothing delivered or no summary is a real failure", () => {
    expect(notifyLanded(1, none)).toBe(false);
    expect(notifyLanded(143, "")).toBe(false);
    expect(notifyLanded(2, "no notify channel configured\n")).toBe(false);
  });
});

describe("exitAfterFlush", () => {
  test("exits hard with the given code instead of waiting on the event loop", async () => {
    // A handle that would keep the loop alive forever if notify merely set
    // process.exitCode and returned.
    const keepAlive = setInterval(() => {}, 1_000);
    try {
      const codes: number[] = [];
      await exitAfterFlush(1, (c) => codes.push(c));
      await exitAfterFlush(0, (c) => codes.push(c));
      expect(codes).toEqual([1, 0]);
    } finally {
      clearInterval(keepAlive);
    }
  });
});
