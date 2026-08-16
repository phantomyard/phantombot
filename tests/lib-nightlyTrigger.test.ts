/**
 * Tests for day-rollover detection — the trigger that replaced the 02:00
 * nightly timer.
 */

import { describe, expect, test } from "bun:test";
import { dailyFileDate, dayRolledOver } from "../src/lib/nightlyTrigger.ts";

describe("dailyFileDate", () => {
  test("uses the same basis the daily-file writer uses (UTC)", () => {
    // `memory capture` names files from toISOString(), so rollover detection
    // has to agree with that boundary or it would fire while the day it is
    // about to process is still being appended to.
    const at = new Date("2026-06-01T23:30:00Z");
    expect(dailyFileDate(at)).toBe("2026-06-01");
    expect(dailyFileDate(new Date("2026-06-02T00:00:00Z"))).toBe("2026-06-02");
  });
});

describe("dayRolledOver", () => {
  test("true when the previous fire was on an earlier day", () => {
    expect(
      dayRolledOver("2026-06-01T23:45:00Z", new Date("2026-06-02T00:15:00Z")),
    ).toBe(true);
  });

  test("false within the same day, even 23 hours apart", () => {
    expect(
      dayRolledOver("2026-06-01T00:30:00Z", new Date("2026-06-01T23:30:00Z")),
    ).toBe(false);
  });

  test("false with no marker — startup already swept, don't double up", () => {
    expect(dayRolledOver(undefined, new Date("2026-06-02T00:15:00Z"))).toBe(
      false,
    );
  });

  test("false on an unparseable marker rather than firing blind", () => {
    expect(dayRolledOver("not-a-date", new Date("2026-06-02T00:15:00Z"))).toBe(
      false,
    );
  });

  test("false when the clock stepped backwards (NTP fix, restored snapshot)", () => {
    // Previous fire recorded in the future: nothing has closed, so nothing to
    // distil. Firing here would process a day that is still open.
    expect(
      dayRolledOver("2026-06-03T10:00:00Z", new Date("2026-06-02T09:00:00Z")),
    ).toBe(false);
  });

  test("true across a multi-day gap (box was powered off for a week)", () => {
    expect(
      dayRolledOver("2026-05-26T09:00:00Z", new Date("2026-06-02T09:00:00Z")),
    ).toBe(true);
  });
});
